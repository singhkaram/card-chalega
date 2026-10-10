// Claude classification of review evidence. AI classifies and cites sentence
// ids; code validates, assembles quotes, and falls back to the deterministic
// rules whenever the LLM is unavailable, refuses or returns invalid output.
// `server-only` keeps ANTHROPIC_API_KEY handling out of any client bundle.
import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import type { ClassifiedMention, Hospital, Review, Treatment } from "@/types/domain";
import {
  cacheKey,
  createClaudeClient,
  createLimiter,
  readClassificationFile,
  requestClassifications,
  runClassification,
  type ClassificationRecord,
  type FallbackEvent,
} from "./llm-core";

// One run reads every hospital's reviews at once (HOSPITALS_PER_RUN = 8), so all
// of its Claude calls go out in one wave instead of two before the run deadline.
const MAX_CONCURRENT_CALLS = 8;
// Request-time calls must finish well inside the run deadline (server/pipeline.ts
// RUN_BUDGET_MS) and the route's maxDuration: one attempt, no SDK retries.
// Batch scripts (classify-snapshots) create their own, more patient client.
const REQUEST_TIMEOUT_MS = 30_000;
const MEMORY_CACHE_LIMIT = 5_000;
const COOLDOWN_MS = 60_000;
const FAILED_TTL_MS = 30 * 60_000;

// Treatment-independent LLM records by cache key; rules results are cheap and never cached.
const memory = new Map<string, ClassificationRecord>();
// Cache keys the LLM refused or answered invalidly → retry time; until then they go to the rules.
const failedUntil = new Map<string, number>();
// One shared run per hospital + treatment + review set, so concurrent requests make one call.
const inflight = new Map<string, Promise<ClassifiedMention[]>>();
// Committed data/classifications files, read once per hospital.
const fileCaches = new Map<string, Promise<Map<string, ClassificationRecord>>>();
const limiter = createLimiter(MAX_CONCURRENT_CALLS);

let client: Anthropic | null = null;
/** Set on 401/403: the key is wrong, so stop calling until the server restarts. */
let disabled = false;
/** Set on rate limits, timeouts, 5xx and 400s: skip the LLM briefly instead of making every run wait. */
let cooldownUntil = 0;
let warnedMissingKey = false;

export function isLlmConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

function llmAvailable(): boolean {
  if (!isLlmConfigured()) {
    if (!warnedMissingKey) {
      warnedMissingKey = true;
      console.warn("[classifier] ANTHROPIC_API_KEY is not set; using the rules-based classifier.");
    }
    return false;
  }
  return !disabled && Date.now() >= cooldownUntil;
}

function getClient(): Anthropic {
  client ??= createClaudeClient({ timeoutMs: REQUEST_TIMEOUT_MS, maxRetries: 0 });
  return client;
}

function loadFileRecords(dataId: string): Promise<Map<string, ClassificationRecord>> {
  let pending = fileCaches.get(dataId);
  if (!pending) {
    pending = readClassificationFile(dataId).catch(() => new Map<string, ClassificationRecord>());
    fileCaches.set(dataId, pending);
  }
  return pending;
}

/** Map.set with oldest-first eviction at MEMORY_CACHE_LIMIT. */
function setBounded<V>(map: Map<string, V>, key: string, value: V): void {
  if (!map.has(key) && map.size >= MEMORY_CACHE_LIMIT) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

function recentlyFailed(key: string): boolean {
  const until = failedUntil.get(key);
  if (until === undefined) return false;
  if (until > Date.now()) return true;
  failedUntil.delete(key);
  return false;
}

// Logs the reason (never the error message or request) and adjusts availability.
function noteFallback(event: FallbackEvent): void {
  const err = event.error;
  let reason: string = event.reason;
  if (err instanceof Anthropic.APIUserAbortError) {
    reason = "aborted";
  } else if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    disabled = true;
    reason = `authentication failed (${err.status}); LLM disabled until restart`;
  } else if (err instanceof Anthropic.RateLimitError) {
    cooldownUntil = Date.now() + COOLDOWN_MS;
    reason = "rate limited";
  } else if (err instanceof Anthropic.APIConnectionTimeoutError) {
    cooldownUntil = Date.now() + COOLDOWN_MS;
    reason = "timeout";
  } else if (err instanceof Anthropic.APIConnectionError) {
    cooldownUntil = Date.now() + COOLDOWN_MS;
    reason = "connection error";
  } else if (err instanceof Anthropic.InternalServerError) {
    cooldownUntil = Date.now() + COOLDOWN_MS;
    reason = `server error (${err.status})`;
  } else if (err instanceof Anthropic.BadRequestError) {
    // Usually persistent (request shape, model access): don't resend it on every run.
    cooldownUntil = Date.now() + COOLDOWN_MS;
    reason = "bad request (400)";
  } else if (err instanceof Anthropic.APIError) {
    reason = `API error (${err.status ?? "?"})`;
  } else if (err instanceof Anthropic.AnthropicError) {
    reason = "unparseable output";
  } else if (err !== undefined) {
    reason = "unexpected error";
  }
  console.warn(`[classifier] rules fallback for ${event.reviews} review(s): ${reason}`);
}

// Not tied to any caller's signal: one caller leaving must not cancel the call
// the others wait for, and a finished call is cached for the next run.
async function classifyShared(hospital: Hospital, reviews: Review[], treatment: Treatment): Promise<ClassifiedMention[]> {
  const fileRecords = await loadFileRecords(hospital.dataId);
  const useLlm = llmAvailable();
  return runClassification(hospital, reviews, treatment, {
    lookup: (key) => memory.get(key) ?? fileRecords.get(key),
    store: (key, record) => setBounded(memory, key, record),
    skip: recentlyFailed,
    markFailed: (key) => setBounded(failedUntil, key, Date.now() + FAILED_TTL_MS),
    callLlm: useLlm ? (h, batch) => limiter.run(() => requestClassifications(getClient(), h, batch)) : undefined,
    onFallback: noteFallback,
  });
}

/** Cached answers (memory, committed files) plus the rules; never calls the LLM. */
async function classifyWithoutLlm(hospital: Hospital, reviews: Review[], treatment: Treatment): Promise<ClassifiedMention[]> {
  try {
    const fileRecords = await loadFileRecords(hospital.dataId);
    return await runClassification(hospital, reviews, treatment, {
      lookup: (key) => memory.get(key) ?? fileRecords.get(key),
    });
  } catch {
    return runClassification(hospital, reviews, treatment); // rules only
  }
}

/**
 * Waits for the shared run, or until the caller's signal aborts (client gone
 * or the run's deadline): then this caller gets cached answers plus the rules
 * at once, while the shared call carries on for the others and is cached.
 */
function waitOrFallBack(
  run: Promise<ClassifiedMention[]>,
  signal: AbortSignal,
  fallback: () => Promise<ClassifiedMention[]>,
): Promise<ClassifiedMention[]> {
  return new Promise((resolve) => {
    const onAbort = () => resolve(fallback());
    signal.addEventListener("abort", onAbort, { once: true });
    run.then(
      (mentions) => {
        signal.removeEventListener("abort", onAbort);
        resolve(mentions);
      },
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve(fallback());
      },
    );
  });
}

/**
 * Classifies one hospital's reviews. Never throws; returns exactly one
 * mention per input review, in the same order. Pre-rules and cached results
 * skip the LLM; the rest go to one Claude call per hospital (shared by
 * concurrent requests for the same reviews), and anything the LLM cannot
 * answer is classified by the rules. A caller whose signal is aborted, before
 * or during the call, gets cached answers plus the rules and stops waiting;
 * the shared call itself is never cancelled by one caller.
 */
export async function classifyHospitalReviews(
  hospital: Hospital,
  reviews: Review[],
  treatment: Treatment,
  opts: { signal?: AbortSignal } = {},
): Promise<ClassifiedMention[]> {
  const { signal } = opts;
  const fallback = () => classifyWithoutLlm(hospital, reviews, treatment);
  if (signal?.aborted) return fallback();
  try {
    const key = JSON.stringify([hospital.dataId, treatment.id, reviews.map((r) => cacheKey(r))]);
    let run = inflight.get(key);
    if (!run) {
      run = classifyShared(hospital, reviews, treatment).finally(() => inflight.delete(key));
      inflight.set(key, run);
    }
    return signal ? await waitOrFallBack(run, signal, fallback) : await run;
  } catch {
    return fallback();
  }
}
