// Resolves a SerpApi request: memory (TTL, LRU) → snapshot files → live.
// Every result carries where it came from and when it was fetched, so the UI
// can label it honestly. Live calls happen only when the caller allows them
// and the run's credit budget grants one.
import "server-only";

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  readSerpApiKey,
  readSnapshotEntry,
  readSnapshotIndex,
  requestKey,
  sanitizeResponse,
  SerpApiError,
  serpApiSearch,
  SNAPSHOT_VERSION,
  type SerpEngine,
  type SerpRequest,
  type SnapshotEntry,
  type SnapshotIndex,
} from "@/lib/serpapi";
import { isRecord } from "@/lib/utils";
import type { DataSource } from "@/types/domain";
import { readConfig, type CreditBudget, type DataMode } from "./guards";

export const SAMPLE_DIR = path.join(process.cwd(), "data", "sample");

const HOUR_MS = 3_600_000;
const TTL_MS: Record<SerpEngine, number> = {
  google_maps: 24 * HOUR_MS,
  google_maps_reviews: 7 * 24 * HOUR_MS,
  google_news: 24 * HOUR_MS,
};
const MAX_MEMORY_ENTRIES = 500;
const KEY_PATTERN = /^[a-f0-9]{8,64}$/;
/** Per-call limit for request-time searches (scripts keep the client's longer default). */
const LIVE_TIMEOUT_MS = 15_000;

// ---------- errors ----------

export type StoreErrorCode = "NOT_AVAILABLE_OFFLINE" | "CREDIT_CAP" | "UPSTREAM";

/** Typed failure the pipeline maps 1:1 to a CheckErrorCode. Messages are safe to show. */
export class StoreError extends Error {
  readonly code: StoreErrorCode;
  constructor(code: StoreErrorCode, message: string) {
    super(message);
    this.name = "StoreError";
    this.code = code;
  }
}

// ---------- memory LRU ----------

interface MemoryEntry {
  response: unknown;
  fetchedAt: string;
  engine: SerpEngine;
}

// Holds live responses only; snapshot/sample files are cheap to re-read and
// keep their own labels. Map iteration order doubles as LRU order.
const memory = new Map<string, MemoryEntry>();

function memoryGet(key: string, now: number): MemoryEntry | null {
  const hit = memory.get(key);
  if (!hit) return null;
  const age = now - Date.parse(hit.fetchedAt);
  if (!(age >= 0 && age < TTL_MS[hit.engine])) {
    memory.delete(key);
    return null;
  }
  memory.delete(key);
  memory.set(key, hit);
  return hit;
}

function memorySet(key: string, entry: MemoryEntry): void {
  memory.delete(key);
  memory.set(key, entry);
  while (memory.size > MAX_MEMORY_ENTRIES) {
    const oldest = memory.keys().next().value;
    if (oldest === undefined) break;
    memory.delete(oldest);
  }
}

/** True if a fresh live response for this key is in memory (a 0-credit hit). */
export function isInMemory(key: string, now: number = Date.now()): boolean {
  return memoryGet(key, now) !== null;
}

/** Test hook. */
export function clearMemory(): void {
  memory.clear();
}

// ---------- file readers (snapshot dir via snapshot.ts, sample dir here) ----------

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

async function readSampleEntry(key: string): Promise<SnapshotEntry | null> {
  if (!KEY_PATTERN.test(key)) return null;
  const parsed = await readJson(path.join(SAMPLE_DIR, "entries", `${key}.json`));
  if (!isRecord(parsed) || parsed.version !== SNAPSHOT_VERSION || parsed.key !== key) return null;
  if (typeof parsed.fetchedAt !== "string") return null;
  return parsed as unknown as SnapshotEntry;
}

async function readSampleIndex(): Promise<SnapshotIndex | null> {
  const parsed = await readJson(path.join(SAMPLE_DIR, "index.json"));
  if (!isRecord(parsed) || parsed.version !== SNAPSHOT_VERSION || !isRecord(parsed.combos)) return null;
  return parsed as unknown as SnapshotIndex;
}

/** The pre-fetched combos for a data mode (data/snapshots or data/sample), or null. */
export function readIndex(mode: DataMode): Promise<SnapshotIndex | null> {
  return mode === "sample" ? readSampleIndex() : readSnapshotIndex();
}

async function readStoredEntry(key: string, mode: DataMode): Promise<SnapshotEntry | null> {
  if (!KEY_PATTERN.test(key)) return null;
  return mode === "sample" ? readSampleEntry(key) : readSnapshotEntry(key);
}

// ---------- resolve ----------

export interface ResolveOptions {
  allowLive: boolean;
  budget: CreditBudget;
  signal?: AbortSignal;
  /** "live" (refresh) skips memory and files. */
  prefer?: "snapshot" | "live";
  /** Lookup key; defaults to requestKey(req). Pass the index key for snapshot combos. */
  key?: string;
  /** Defaults to the server config (DATA_SOURCE). */
  mode?: DataMode;
}

export interface Resolved {
  response: unknown;
  fetchedAt: string;
  source: DataSource;
  key: string;
}

function upstreamMessage(err: unknown): string {
  if (err instanceof SerpApiError) {
    if (err.status === 429) return "The search service's hourly limit was reached. Pre-fetched cities still work.";
    switch (err.code) {
      case "TIMEOUT":
        return "The search service did not respond in time.";
      case "NO_KEY":
        return "Live search is not configured on this server.";
      case "API":
        return "The search service reported an error for this request.";
      default:
        return "The search service could not be reached.";
    }
  }
  return "The search service could not be reached.";
}

export async function resolve(req: SerpRequest, opts: ResolveOptions): Promise<Resolved> {
  const key = opts.key ?? requestKey(req);
  const mode = opts.mode ?? readConfig().dataMode;

  if (opts.prefer !== "live") {
    const hit = memoryGet(key, Date.now());
    if (hit) return { response: hit.response, fetchedAt: hit.fetchedAt, source: "cache", key };

    const stored = await readStoredEntry(key, mode);
    if (stored && stored.engine === req.engine) {
      return { response: stored.response, fetchedAt: stored.fetchedAt, source: mode === "sample" ? "sample" : "snapshot", key };
    }
  }

  // Synthetic sample mode never mixes in live data.
  if (!opts.allowLive || mode === "sample") {
    throw new StoreError("NOT_AVAILABLE_OFFLINE", "This search is not available offline.");
  }
  if (opts.signal?.aborted) throw new StoreError("UPSTREAM", "Request was cancelled.");
  if (!opts.budget.take()) {
    throw new StoreError("CREDIT_CAP", "The live-search budget for this run is used up.");
  }

  let raw: unknown;
  try {
    raw = await serpApiSearch(req.engine, req.params, { signal: opts.signal, timeoutMs: LIVE_TIMEOUT_MS });
  } catch (err) {
    // Never forward the client's message verbatim: the URL (with the key) must not leak.
    throw new StoreError("UPSTREAM", upstreamMessage(err));
  }
  const response = sanitizeResponse(raw, readSerpApiKey());
  const fetchedAt = new Date().toISOString();
  memorySet(key, { response, fetchedAt, engine: req.engine });
  return { response, fetchedAt, source: "live", key };
}
