/*
 * Pre-classifies the snapshot reviews with Claude and writes the results as
 * committed files, so the demo serves LLM classifications without calling the
 * API at request time.
 *
 *   npx tsx scripts/classify-snapshots.ts             # classify everything not cached yet
 *   npx tsx scripts/classify-snapshots.ts --dry-run   # show what would be sent, call nothing
 *
 * Reads ANTHROPIC_API_KEY from the environment or .env.local. Never prints the key.
 * Writes data/classifications/<dataId>.json (cache key → treatment-independent
 * record), the read-through cache of src/lib/ai/classifier.ts. Idempotent:
 * cached keys are skipped and only validated LLM results are written, so a
 * re-run retries whatever fell back to the rules.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { TREATMENTS } from "@/config/presets";
import type { EvidenceClass, Hospital, Review } from "@/types/domain";
import { normalizeMapsResults, normalizeReviews } from "@/lib/serpapi/normalize";
import { readSnapshotEntry, readSnapshotIndex, type SnapshotIndex } from "@/lib/serpapi/snapshot";
// llm-core (not classifier.ts): classifier.ts imports "server-only", which throws under plain Node.
import {
  cacheKey,
  CLASSIFICATIONS_DIR,
  classificationFileName,
  createClaudeClient,
  readClassificationFile,
  requestClassifications,
  runClassification,
  writeClassificationFile,
} from "@/lib/ai/llm-core";
import { preClassify } from "@/lib/ai/rules";

const HOSPITAL_CONCURRENCY = 4;

async function loadEnvLocal(): Promise<void> {
  if (process.env.ANTHROPIC_API_KEY) return;
  try {
    const text = await fs.readFile(path.join(process.cwd(), ".env.local"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    /* no .env.local — fine */
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

interface Job {
  hospital: Hospital;
  reviews: Review[];
}

/** Every snapshot hospital with its reviews, deduplicated across combos. */
async function collectJobs(index: SnapshotIndex): Promise<{ jobs: Job[]; warnings: string[] }> {
  const jobs = new Map<string, Job>();
  const warnings: string[] = [];
  for (const [id, combo] of Object.entries(index.combos)) {
    const maps = await readSnapshotEntry(combo.mapsKey);
    if (!maps) {
      warnings.push(`${id}: maps snapshot ${combo.mapsKey} is missing`);
      continue;
    }
    const hospitals = new Map(normalizeMapsResults(maps.response, TREATMENTS[combo.treatment]).hospitals.map((h) => [h.dataId, h]));
    for (const { dataId, reviewsKey } of combo.hospitals) {
      const hospital = hospitals.get(dataId);
      const entry = await readSnapshotEntry(reviewsKey);
      if (!hospital || !entry) {
        warnings.push(`${id}: ${hospital ? `reviews snapshot ${reviewsKey}` : `hospital ${dataId}`} is missing`);
        continue;
      }
      const job = jobs.get(dataId) ?? { hospital, reviews: [] };
      const seen = new Set(job.reviews.map((r) => r.reviewId));
      for (const review of normalizeReviews(entry.response, dataId)) {
        if (!seen.has(review.reviewId)) {
          seen.add(review.reviewId);
          job.reviews.push(review);
        }
      }
      jobs.set(dataId, job);
    }
  }
  return { jobs: [...jobs.values()], warnings };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  await loadEnvLocal();

  if (!dryRun && !process.env.ANTHROPIC_API_KEY?.trim()) {
    console.error('ANTHROPIC_API_KEY is not set. Set it in your environment or ".env.local", then re-run (or use --dry-run).');
    process.exitCode = 1;
    return;
  }

  const index = await readSnapshotIndex();
  if (!index) {
    console.error("No snapshot index at data/snapshots/index.json. Run `npm run gate` first (on a network that can reach serpapi.com).");
    process.exitCode = 1;
    return;
  }

  const { jobs, warnings } = await collectJobs(index);
  for (const w of warnings) console.warn(`warning: ${w}`);
  console.log(`${jobs.length} hospitals, ${jobs.reduce((n, j) => n + j.reviews.length, 0)} reviews in snapshots${dryRun ? " (dry run)" : ""}`);

  const client = dryRun ? null : createClaudeClient({ timeoutMs: 120_000, maxRetries: 2 });
  const classes = new Map<EvidenceClass, number>();
  let written = 0;
  let fellBack = 0;
  const callMs: number[] = [];

  await mapLimit(jobs, HOSPITAL_CONCURRENCY, async ({ hospital, reviews }) => {
    const records = await readClassificationFile(hospital.dataId);
    const preRules = reviews.filter((r) => preClassify(hospital, r) !== null).length;
    const todo = reviews.filter((r) => preClassify(hospital, r) === null && !records.has(cacheKey(r))).length;
    const label = hospital.name.slice(0, 48).padEnd(48);

    if (!client || todo === 0) {
      console.log(`  ${label} reviews ${String(reviews.length).padStart(2)} | pre-rules ${preRules} | cached ${reviews.length - preRules - todo} | to classify ${todo}`);
      return;
    }

    let added = 0;
    let fallback = 0;
    await runClassification(hospital, reviews, TREATMENTS.general, {
      lookup: (key) => records.get(key),
      store: (key, record) => {
        records.set(key, record);
        classes.set(record.cls, (classes.get(record.cls) ?? 0) + 1);
        added++;
      },
      callLlm: async (h, batch) => {
        const started = performance.now();
        try {
          return await requestClassifications(client, h, batch);
        } finally {
          // Includes SDK retries; feeds RUN_BUDGET_MS tuning in src/lib/server/pipeline.ts.
          const ms = Math.round(performance.now() - started);
          callMs.push(ms);
          console.log(`  ${hospital.name.slice(0, 48)}: Claude call for ${batch.length} review(s) took ${ms} ms`);
        }
      },
      onFallback: (event) => {
        fallback += event.reviews;
        const err = event.error;
        const why =
          err instanceof Anthropic.APIError
            ? `API error ${err.status ?? "(no status)"}`
            : err instanceof Anthropic.AnthropicError
              ? "unparseable output"
              : event.reason;
        console.warn(`  ${hospital.name}: ${event.reviews} review(s) not classified by the LLM (${why})`);
      },
    });
    if (added > 0) await writeClassificationFile(hospital.dataId, records);
    written += added;
    fellBack += fallback;
    const target = added > 0 ? ` → ${classificationFileName(hospital.dataId)}` : "";
    console.log(`  ${label} reviews ${String(reviews.length).padStart(2)} | pre-rules ${preRules} | new ${added} | not classified ${fallback}${target}`);
  });

  if (dryRun) return;
  const summary = [...classes.entries()].map(([cls, n]) => `${cls}=${n}`).join(" ") || "none";
  console.log(`\nWrote ${written} new classifications to ${path.relative(process.cwd(), CLASSIFICATIONS_DIR)} (${summary}).`);
  if (callMs.length > 0) {
    const sorted = [...callMs].sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
    console.log(
      `Claude latency: ${sorted.length} calls, median ${at(0.5)} ms, p90 ${at(0.9)} ms, max ${sorted[sorted.length - 1]} ms (request-time calls give up after 30 s; see lib/ai/classifier.ts).`,
    );
  }
  if (fellBack > 0) {
    console.warn(`${fellBack} review(s) fell back to the rules; re-run to retry them.`);
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Classification failed: ${message}`);
  process.exitCode = 1;
});
