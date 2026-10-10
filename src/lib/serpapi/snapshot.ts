// Snapshot format shared by scripts/gate.ts (writer) and the server store (reader).
// A snapshot entry is a REAL SerpApi response, sanitised (no reviewer identity,
// reviewer names scrubbed from reply salutations, no api key) and stamped with
// the time it was fetched. The UI always labels
// snapshot data with that time — snapshots are never presented as live.

import { promises as fs } from "node:fs";
import path from "node:path";
import type { CityId, TreatmentId } from "@/types/domain";
import type { SerpEngine } from "./params";
import { scrubReplySnippet } from "./reply";

export const SNAPSHOT_VERSION = 1;
export const SNAPSHOT_DIR = path.join(process.cwd(), "data", "snapshots");
const ENTRIES_DIR = path.join(SNAPSHOT_DIR, "entries");
const INDEX_FILE = path.join(SNAPSHOT_DIR, "index.json");

export interface SnapshotEntry {
  version: number;
  key: string;
  engine: SerpEngine;
  params: Record<string, string>;
  fetchedAt: string;
  response: unknown;
}

export interface SnapshotCombo {
  city: CityId;
  treatment: TreatmentId;
  mapsKey: string;
  fetchedAt: string;
  /** Hospitals selected for this combo, in display order, with their reviews snapshot key. */
  hospitals: { dataId: string; reviewsKey: string }[];
  newsKeys?: { en?: string; hi?: string };
}

export interface SnapshotIndex {
  version: number;
  generatedAt: string;
  /** Gate probe result: the `num` sent with `query` on the first reviews page; null = num was rejected. */
  reviewsNum: number | null;
  combos: Record<string, SnapshotCombo>;
}

export function comboId(city: CityId, treatment: TreatmentId): string {
  return `${city}:${treatment}`;
}

// ---------- sanitisation ----------

const DROP_KEYS_EVERYWHERE = new Set(["user", "images", "api_key", "user_reviews", "username", "contributor_id"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A review's `response` (hospital reply) with the reviewer's name removed from its salutation. */
function scrubReply(reply: Record<string, unknown>): Record<string, unknown> {
  const out = { ...reply };
  if (typeof out.snippet === "string") out.snippet = scrubReplySnippet(out.snippet);
  if (isRecord(out.extracted_snippet)) {
    const ex = { ...out.extracted_snippet };
    for (const k of ["original", "translated"]) {
      const s = ex[k];
      if (typeof s === "string") ex[k] = scrubReplySnippet(s);
    }
    out.extracted_snippet = ex;
  }
  return out;
}

/**
 * Deep-copies a SerpApi response while removing reviewer identities (`user`,
 * and `user_reviews` / `username` / `contributor_id` from google_maps
 * place_results), reviewer names in hospital-reply salutations, review photos
 * (`images`), SerpApi account metadata, and any string that contains the API key.
 */
export function sanitizeResponse(value: unknown, apiKey: string | null): unknown {
  if (Array.isArray(value)) return value.map((v) => sanitizeResponse(v, apiKey));
  if (typeof value === "string") {
    return apiKey && value.includes(apiKey) ? "[redacted]" : value;
  }
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (DROP_KEYS_EVERYWHERE.has(k)) continue;
    if (k === "search_metadata" && typeof v === "object" && v !== null) {
      const meta = v as Record<string, unknown>;
      out[k] = { status: meta.status, created_at: meta.created_at, total_time_taken: meta.total_time_taken };
      continue;
    }
    // SerpApi's `response` key only appears on review items (the hospital's reply).
    out[k] = sanitizeResponse(k === "response" && isRecord(v) ? scrubReply(v) : v, apiKey);
  }
  return out;
}

// ---------- file IO ----------

function entryPath(key: string): string {
  if (!/^[a-f0-9]{8,64}$/.test(key)) throw new Error("Invalid snapshot key");
  return path.join(ENTRIES_DIR, `${key}.json`);
}

export async function readSnapshotEntry(key: string): Promise<SnapshotEntry | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(entryPath(key), "utf8")) as SnapshotEntry;
    return parsed.version === SNAPSHOT_VERSION && parsed.key === key ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeSnapshotEntry(entry: SnapshotEntry): Promise<void> {
  await fs.mkdir(ENTRIES_DIR, { recursive: true });
  await fs.writeFile(entryPath(entry.key), JSON.stringify(entry, null, 2) + "\n", "utf8");
}

export async function readSnapshotIndex(): Promise<SnapshotIndex | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(INDEX_FILE, "utf8")) as SnapshotIndex;
    return parsed.version === SNAPSHOT_VERSION ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeSnapshotIndex(index: SnapshotIndex): Promise<void> {
  await fs.mkdir(SNAPSHOT_DIR, { recursive: true });
  await fs.writeFile(INDEX_FILE, JSON.stringify(index, null, 2) + "\n", "utf8");
}
