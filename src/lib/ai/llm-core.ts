// Shared core of the Claude classifier: request, output schema, validation,
// cache keys, the committed classification files and the per-hospital pipeline.
// No `server-only` here so scripts/classify-snapshots.ts can import it under
// plain Node; the Next.js entry point is classifier.ts (server-only).

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { AutoParseableBetaOutputFormat } from "@anthropic-ai/sdk/lib/beta-parser";
import { z } from "zod";
import {
  EVIDENCE_CLASSES,
  TREATMENT_IDS,
  type ClassifiedMention,
  type ClassifierKind,
  type Hospital,
  type Review,
  type Sentence,
  type Treatment,
  type TreatmentId,
} from "@/types/domain";
import { buildUserMessage, CLASSIFIABLE_TREATMENT_IDS, PROMPT_VERSION, SYSTEM_PROMPT } from "./prompt";
import { acceptAmount, classifyWithRules, isEvidenceClass, preClassify, recordToMention, type ClassificationRecord } from "./rules";
import { reviewSentences, SENTENCE_SPLITTER_VERSION } from "./sentences";

export type { ClassificationRecord } from "./rules";

export const CLAUDE_MODEL = "claude-opus-5-5";
/** Normally one call per hospital (≤ 20 reviews per page); larger inputs are split. */
export const MAX_REVIEWS_PER_CALL = 30;
const MAX_TOKENS = 8000;
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export interface LlmEntry {
  review: Review;
  sentences: Sentence[];
}

// ---------- structured output ----------

// Hand-written so the API enforces the enums while decoding (the SDK's zod
// helper moves `enum` into a description). Items are validated one by one in
// code, so a single bad item falls back to the rules alone.
const OUTPUT_JSON_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          review_index: { type: "integer" },
          class: { type: "string", enum: [...EVIDENCE_CLASSES] },
          sentence_ids: { type: "array", items: { type: "integer" } },
          amount_inr: { anyOf: [{ type: "number" }, { type: "null" }] },
          treatments_mentioned: { type: "array", items: { type: "string", enum: [...CLASSIFIABLE_TREATMENT_IDS] } },
        },
        required: ["review_index", "class", "sentence_ids", "amount_inr", "treatments_mentioned"],
        additionalProperties: false,
      },
    },
  },
  required: ["results"],
  additionalProperties: false,
};

const OutputEnvelope = z.object({ results: z.array(z.unknown()) });
const OutputItem = z.object({
  review_index: z.number(),
  class: z.string(),
  sentence_ids: z.array(z.number()),
  amount_inr: z.number().nullable(),
  treatments_mentioned: z.array(z.string()),
});
export type LlmOutput = z.infer<typeof OutputEnvelope>;

/** Output format for client.beta.messages.parse: the SDK calls `parse` on the text block. */
export const CLASSIFICATION_FORMAT: AutoParseableBetaOutputFormat<LlmOutput> = {
  type: "json_schema",
  schema: OUTPUT_JSON_SCHEMA,
  parse: (content: string) => OutputEnvelope.parse(JSON.parse(content)),
};

// ---------- validation ----------

interface CandidateRecord {
  cls: string;
  sentenceIds: readonly number[];
  amountInr: number | null;
  treatmentsMentioned: readonly string[];
}

function isClassifiableTreatment(value: string): value is TreatmentId {
  return (CLASSIFIABLE_TREATMENT_IDS as readonly string[]).includes(value);
}

/**
 * Code decides: unknown classes, NAME_COLLISION for a hospital not named
 * "Ayushman", and records with no valid sentence id are rejected (→ rules).
 * Invalid ids are dropped; the amount survives only if it is written in the
 * cited sentences.
 */
export function sanitizeRecord(
  candidate: CandidateRecord,
  sentences: Sentence[],
  hospital: Pick<Hospital, "nameCollision">,
  classifier: ClassifierKind,
): ClassificationRecord | null {
  if (!isEvidenceClass(candidate.cls)) return null;
  if (candidate.cls === "NAME_COLLISION" && !hospital.nameCollision) return null;
  const valid = new Set(sentences.map((s) => s.id));
  const ids = [...new Set(candidate.sentenceIds.filter((id) => Number.isInteger(id) && valid.has(id)))].sort((a, b) => a - b);
  if (ids.length === 0) return null;
  const cited = sentences.filter((s) => ids.includes(s.id)).map((s) => s.text).join("\n");
  return {
    cls: candidate.cls,
    sentenceIds: ids,
    amountInr: acceptAmount(candidate.amountInr, cited, candidate.cls),
    treatmentsMentioned: [...new Set(candidate.treatmentsMentioned.filter(isClassifiableTreatment))],
    classifier,
  };
}

/**
 * Validates parsed LLM output against the batch it answers. Returns records
 * keyed by batch position; missing, duplicate or invalid items are absent.
 */
export function validateLlmOutput(
  output: unknown,
  batch: readonly LlmEntry[],
  hospital: Pick<Hospital, "nameCollision">,
): Map<number, ClassificationRecord> {
  const records = new Map<number, ClassificationRecord>();
  const envelope = OutputEnvelope.safeParse(output);
  if (!envelope.success) return records;

  const items = envelope.data.results.flatMap((raw) => {
    const item = OutputItem.safeParse(raw);
    return item.success && Number.isInteger(item.data.review_index) && item.data.review_index >= 0 && item.data.review_index < batch.length
      ? [item.data]
      : [];
  });
  // An index answered twice is ambiguous: neither answer is used.
  const counts = new Map<number, number>();
  for (const item of items) counts.set(item.review_index, (counts.get(item.review_index) ?? 0) + 1);

  for (const item of items) {
    if (counts.get(item.review_index) !== 1) continue;
    const record = sanitizeRecord(
      { cls: item.class, sentenceIds: item.sentence_ids, amountInr: item.amount_inr, treatmentsMentioned: item.treatments_mentioned },
      batch[item.review_index].sentences,
      hospital,
      "llm",
    );
    if (record) records.set(item.review_index, record);
  }
  return records;
}

/** A cached record is reused only if every cited id still exists; returns it re-validated. */
export function revalidateRecord(
  record: ClassificationRecord,
  sentences: Sentence[],
  hospital: Pick<Hospital, "nameCollision">,
): ClassificationRecord | null {
  const checked = sanitizeRecord(record, sentences, hospital, record.classifier);
  return checked && checked.sentenceIds.length === record.sentenceIds.length ? checked : null;
}

// ---------- cache keys & committed files ----------

/** Treatment-independent cache key for one review's classification. */
export function cacheKey(review: Review, model: string = CLAUDE_MODEL): string {
  const basis = JSON.stringify([
    review.hospitalDataId,
    review.reviewId,
    review.text,
    review.textOriginal ?? "",
    review.textTranslated ?? "",
    PROMPT_VERSION,
    SENTENCE_SPLITTER_VERSION,
    model,
  ]);
  return createHash("sha256").update(basis).digest("hex").slice(0, 32);
}

export const CLASSIFICATIONS_DIR = path.join(process.cwd(), "data", "classifications");
const KEY_PATTERN = /^[a-f0-9]{32}$/;

const RecordSchema = z.object({
  cls: z.enum(EVIDENCE_CLASSES),
  sentenceIds: z.array(z.int().nonnegative()),
  amountInr: z.number().nullable(),
  treatmentsMentioned: z.array(z.enum(TREATMENT_IDS)),
  classifier: z.enum(["llm", "rules"]),
});

/** "0x39…:0x2b…" → "0x39…_0x2b…" (safe on every filesystem). */
export function classificationFileName(dataId: string): string {
  const safe = dataId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);
  return `${safe || "unknown"}.json`;
}

/** Reads data/classifications/<dataId>.json (cache key → record). Never throws. */
export async function readClassificationFile(dataId: string, dir: string = CLASSIFICATIONS_DIR): Promise<Map<string, ClassificationRecord>> {
  const records = new Map<string, ClassificationRecord>();
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(path.join(dir, classificationFileName(dataId)), "utf8"));
  } catch {
    return records; // no file yet, or unreadable — classify live instead
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return records;
  for (const [key, value] of Object.entries(raw)) {
    const parsed = RecordSchema.safeParse(value);
    if (KEY_PATTERN.test(key) && parsed.success) records.set(key, parsed.data);
  }
  return records;
}

export async function writeClassificationFile(
  dataId: string,
  records: ReadonlyMap<string, ClassificationRecord>,
  dir: string = CLASSIFICATIONS_DIR,
): Promise<void> {
  // Sorted keys keep diffs of the committed files small.
  const sorted = Object.fromEntries([...records.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, classificationFileName(dataId)), JSON.stringify(sorted, null, 2) + "\n", "utf8");
}

// ---------- Claude call ----------

/** Reads ANTHROPIC_API_KEY from the environment; the key is never passed around or logged. */
export function createClaudeClient(opts: { timeoutMs?: number; maxRetries?: number } = {}): Anthropic {
  return new Anthropic({ timeout: opts.timeoutMs ?? 45_000, maxRetries: opts.maxRetries ?? 1 });
}

/**
 * One structured-output call for a batch of reviews. Returns the parsed
 * output, or null on a refusal or empty output. Throws the SDK's typed errors.
 */
export async function requestClassifications(
  client: Anthropic,
  hospital: Pick<Hospital, "name" | "nameCollision">,
  batch: readonly LlmEntry[],
  signal?: AbortSignal,
): Promise<LlmOutput | null> {
  const response = await client.beta.messages.parse(
    {
      model: CLAUDE_MODEL,
      max_tokens: MAX_TOKENS,
      betas: [FALLBACK_BETA],
      // Server-side retry on Anthropic's recommended model if the request is declined.
      fallbacks: "default",
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      output_config: { effort: "low", format: CLASSIFICATION_FORMAT },
      messages: [
        {
          role: "user",
          content: buildUserMessage(hospital, batch.map((entry, index) => ({ index, sentences: entry.sentences }))),
        },
      ],
    },
    { signal },
  );
  if (response.stop_reason === "refusal") return null;
  return response.parsed_output;
}

// ---------- per-hospital pipeline ----------

export interface FallbackEvent {
  reason: "error" | "no_output" | "invalid_items";
  /** Reviews that fell back to the rules. */
  reviews: number;
  error?: unknown;
}

export interface ClassificationDeps {
  /** Cached record for a cache key (memory, committed file…). */
  lookup?: (key: string) => ClassificationRecord | undefined;
  /** Called for every new validated LLM record. */
  store?: (key: string, record: ClassificationRecord) => void;
  /** True = do not send this key to the LLM now (e.g. it failed recently); it goes to the rules. */
  skip?: (key: string) => boolean;
  /** Called for each key the LLM answered without a usable record (refusal, invalid item); not on errors. */
  markFailed?: (key: string) => void;
  /** One LLM call for a batch → parsed output (null = refusal/empty). Absent = LLM unavailable. */
  callLlm?: (hospital: Hospital, batch: LlmEntry[]) => Promise<unknown>;
  onFallback?: (event: FallbackEvent) => void;
}

function safeSentences(review: Review): Sentence[] {
  try {
    return reviewSentences(review);
  } catch {
    return [];
  }
}

function safeRules(hospital: Hospital, entry: LlmEntry, treatment: Treatment): ClassifiedMention {
  try {
    return classifyWithRules(hospital, entry.review, entry.sentences, treatment);
  } catch {
    // Last resort: an uncited mention that never counts as a problem.
    return recordToMention(
      entry.review,
      [],
      { cls: "MENTION_ONLY", sentenceIds: [], amountInr: null, treatmentsMentioned: [], classifier: "rules" },
      treatment,
    );
  }
}

function notify(deps: ClassificationDeps, event: FallbackEvent): void {
  try {
    deps.onFallback?.(event);
  } catch {
    /* logging must never break classification */
  }
}

function reportFailed(deps: ClassificationDeps, keys: readonly string[]): void {
  for (const key of keys) {
    try {
      deps.markFailed?.(key);
    } catch {
      /* a failed mark only costs a later retry */
    }
  }
}

/**
 * Classifies one hospital's reviews: pre-rules → cache → one LLM batch (minus
 * skipped keys) → rules fallback for whatever is left. Never throws; returns
 * exactly one mention per review, in input order.
 */
export async function runClassification(
  hospital: Hospital,
  reviews: readonly Review[],
  treatment: Treatment,
  deps: ClassificationDeps = {},
): Promise<ClassifiedMention[]> {
  const entries: LlmEntry[] = reviews.map((review) => ({ review, sentences: safeSentences(review) }));
  const out: (ClassifiedMention | undefined)[] = new Array(entries.length);

  try {
    const pending: { index: number; key: string }[] = [];
    entries.forEach((entry, index) => {
      try {
        if (preClassify(hospital, entry.review)) {
          out[index] = classifyWithRules(hospital, entry.review, entry.sentences, treatment);
          return;
        }
        const key = cacheKey(entry.review);
        const cached = deps.lookup?.(key);
        const record = cached ? revalidateRecord(cached, entry.sentences, hospital) : null;
        if (record) {
          out[index] = recordToMention(entry.review, entry.sentences, record, treatment);
          return;
        }
        if (deps.skip?.(key)) return;
        pending.push({ index, key });
      } catch {
        /* this review falls back to the rules below */
      }
    });

    const callLlm = deps.callLlm;
    if (pending.length > 0 && callLlm) {
      const chunks: (typeof pending)[] = [];
      for (let i = 0; i < pending.length; i += MAX_REVIEWS_PER_CALL) chunks.push(pending.slice(i, i + MAX_REVIEWS_PER_CALL));

      await Promise.all(
        chunks.map(async (chunk) => {
          const batch = chunk.map((p) => entries[p.index]);
          let output: unknown;
          try {
            output = await callLlm(hospital, batch);
          } catch (error) {
            notify(deps, { reason: "error", reviews: batch.length, error });
            return;
          }
          if (output === null || output === undefined) {
            notify(deps, { reason: "no_output", reviews: batch.length });
            reportFailed(deps, chunk.map((p) => p.key));
            return;
          }
          const records = validateLlmOutput(output, batch, hospital);
          if (records.size < batch.length) {
            notify(deps, { reason: "invalid_items", reviews: batch.length - records.size });
            reportFailed(deps, chunk.filter((_, position) => !records.has(position)).map((p) => p.key));
          }
          for (const [position, record] of records) {
            const { index, key } = chunk[position];
            out[index] = recordToMention(entries[index].review, entries[index].sentences, record, treatment);
            try {
              deps.store?.(key, record);
            } catch {
              /* a failed cache write only costs a later re-classification */
            }
          }
        }),
      );
    }
  } catch (error) {
    notify(deps, { reason: "error", reviews: out.filter((m) => m === undefined).length, error });
  }

  return entries.map((entry, index) => out[index] ?? safeRules(hospital, entry, treatment));
}

// ---------- concurrency ----------

/** Process-wide cap on concurrent calls; a queued call is dropped if its signal aborts. */
export function createLimiter(max: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  // A finishing call hands its slot straight to the next waiter.
  const release = () => {
    const next = queue.shift();
    if (next) next();
    else active--;
  };
  return {
    async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      if (active < max) {
        active++;
      } else {
        await new Promise<void>((resolve, reject) => {
          const start = () => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
          };
          const onAbort = () => {
            const i = queue.indexOf(start);
            if (i >= 0) queue.splice(i, 1);
            reject(signal?.reason);
          };
          if (signal?.aborted) return onAbort();
          signal?.addEventListener("abort", onAbort, { once: true });
          queue.push(start);
        });
      }
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}
