/*
 * Day-1 data gate + snapshot generator.
 *
 * Run on a network that can reach serpapi.com (NOT the office network):
 *   npx tsx scripts/gate.ts                       # default: 3 cities, "general", news en+hi, ≤40 credits
 *   npx tsx scripts/gate.ts --dry-run             # print the plan, spend nothing
 *   npx tsx scripts/gate.ts --cities lucknow --treatments dialysis,cataract --no-news
 *   npx tsx scripts/gate.ts --variants 2          # also test Devanagari / "golden card" / most-relevant order
 *
 * Reads SERPAPI_KEY from the environment or .env.local. Never prints the key.
 * Writes sanitised responses (no reviewer names/photos) to data/snapshots/ and a
 * pass/fail report to data/gate/report.{json,md}. Re-running reuses existing
 * snapshots (0 credits) unless --refresh is given. The index is saved after each
 * combo. A failed request (timeout, 5xx, unknown API error) only skips that
 * hospital or headline set and is listed in the report: re-run to fill the gaps.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { CITIES, HOSPITALS_PER_RUN, SCHEME_TERMS, TREATMENTS } from "@/config/presets";
import {
  CITY_IDS,
  TREATMENT_IDS,
  type CityId,
  type Hospital,
  type HospitalScore,
  type Review,
  type Treatment,
  type TreatmentId,
} from "@/types/domain";
import { classifyWithRules } from "@/lib/ai/rules";
import { reviewSentences } from "@/lib/ai/sentences";
import { applyBaseline, computeBaseline, isInWindow, scoreHospital } from "@/lib/scoring/score";
import { getAccountInfo, readSerpApiKey, SerpApiError, serpApiSearch } from "@/lib/serpapi/client";
import {
  mapsSearchRequest,
  newsRequest,
  requestKey,
  REVIEWS_SORT,
  reviewsRequest,
  storableParams,
  type ReviewsRequestOptions,
  type SerpRequest,
} from "@/lib/serpapi/params";
import { normalizeMapsResults, normalizeReviews, reviewsNextPageToken } from "@/lib/serpapi/normalize";
import {
  comboId,
  readSnapshotEntry,
  readSnapshotIndex,
  sanitizeResponse,
  SNAPSHOT_VERSION,
  writeSnapshotEntry,
  writeSnapshotIndex,
  type SnapshotIndex,
} from "@/lib/serpapi/snapshot";

// ---------- args & env ----------

interface Args {
  cities: CityId[];
  treatments: TreatmentId[];
  hospitals: number;
  maxCredits: number;
  variants: number;
  news: boolean;
  refresh: boolean;
  dryRun: boolean;
}

function parseList<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T[]): T[] {
  if (!value) return fallback;
  const items = value.split(",").map((s) => s.trim()).filter(Boolean);
  for (const item of items) {
    if (!allowed.includes(item as T)) throw new Error(`Unknown value "${item}". Allowed: ${allowed.join(", ")}`);
  }
  return items as T[];
}

function parseArgs(argv: string[]): Args {
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const has = (name: string) => argv.includes(`--${name}`);
  const int = (name: string, fallback: number, min: number, max: number) => {
    const raw = get(name);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`--${name} must be an integer ${min}–${max}`);
    return n;
  };
  return {
    cities: parseList(get("cities"), CITY_IDS, ["lucknow", "patna", "ghaziabad"]),
    treatments: parseList(get("treatments"), TREATMENT_IDS, ["general"]),
    hospitals: int("hospitals", HOSPITALS_PER_RUN, 1, 20),
    maxCredits: int("max-credits", 40, 1, 200),
    variants: int("variants", 0, 0, 8),
    // On by default: the app shows headlines for a snapshot combo only if the gate fetched them.
    news: !has("no-news"),
    refresh: has("refresh"),
    dryRun: has("dry-run"),
  };
}

async function loadEnvLocal(): Promise<void> {
  if (process.env.SERPAPI_KEY) return;
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

// ---------- credit-guarded fetch through the snapshot store ----------

class Budget {
  used = 0;
  reused = 0;
  /** Wall-clock ms of each live call (successful or not) by engine, to tune RUN_BUDGET_MS in server/pipeline.ts. */
  readonly latencies = new Map<string, number[]>();
  constructor(readonly max: number) {}

  recordLatency(engine: string, ms: number): void {
    const list = this.latencies.get(engine) ?? [];
    list.push(ms);
    this.latencies.set(engine, list);
  }
}

interface LatencySummary {
  calls: number;
  medianMs: number;
  p90Ms: number;
  maxMs: number;
}

function summarizeLatencies(latencies: Map<string, number[]>): Record<string, LatencySummary> {
  const out: Record<string, LatencySummary> = {};
  for (const [engine, list] of latencies) {
    const sorted = [...list].sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
    out[engine] = { calls: sorted.length, medianMs: at(0.5), p90Ms: at(0.9), maxMs: sorted[sorted.length - 1] };
  }
  return out;
}

async function fetchOrReuse(req: SerpRequest, budget: Budget, args: Args, apiKey: string): Promise<{ response: unknown; fetchedAt: string; key: string; reused: boolean }> {
  const key = requestKey(req);
  if (!args.refresh) {
    const existing = await readSnapshotEntry(key);
    if (existing) {
      budget.reused++;
      return { response: existing.response, fetchedAt: existing.fetchedAt, key, reused: true };
    }
  }
  if (budget.used >= budget.max) throw new Error(`Credit cap reached (${budget.max}). Re-run with a higher --max-credits if needed.`);
  budget.used++;
  const started = performance.now();
  let raw: unknown;
  try {
    raw = await serpApiSearch(req.engine, req.params, { apiKey, timeoutMs: 45_000 });
  } finally {
    const ms = Math.round(performance.now() - started);
    budget.recordLatency(req.engine, ms);
    console.log(`    ${req.engine} live call: ${ms} ms`);
  }
  const fetchedAt = new Date().toISOString();
  const response = sanitizeResponse(raw, apiKey);
  await writeSnapshotEntry({ version: SNAPSHOT_VERSION, key, engine: req.engine, params: storableParams(req.params), fetchedAt, response });
  return { response, fetchedAt, key, reused: false };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------- failures ----------

interface Failure {
  name: string;
  code: string;
  message: string;
}

/** Account-level failures (bad key, out of searches, throughput limit, our own credit cap) stop the run. */
function isFatal(err: unknown): boolean {
  if (!(err instanceof SerpApiError)) return true;
  return err.code === "NO_KEY" || err.status === 401 || err.status === 403 || err.status === 429 || /run out of searches/i.test(err.message);
}

/**
 * Rethrows fatal errors; otherwise logs the failure and returns it so the run
 * continues without that request. No automatic retry: a timed-out search may
 * already have cost a credit, and a re-run reuses every snapshot it has.
 */
function nonFatal(err: unknown, name: string): Failure {
  if (isFatal(err)) throw err;
  const e = err as SerpApiError;
  console.log(`  skipped ${name.slice(0, 48)}: ${e.code} ${e.message}`); // message is already key-redacted by the client
  return { name, code: e.code, message: e.message };
}

function isNumRejected(err: unknown): boolean {
  return err instanceof SerpApiError && err.code === "API" && /\bnum\b/i.test(err.message);
}

// ---------- stats ----------

const SCHEME_RE = new RegExp(SCHEME_TERMS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "i");
const AYUSHMAN_RE = /aa?yushmaa?n|आयुष्मान/i;

interface HospitalStat {
  name: string;
  dataId: string;
  overallRating?: number;
  reviewCount?: number;
  types: string[];
  nameCollision: boolean;
  /** Raw diagnostics: every review SerpApi returned. */
  mentions: number;
  mentionsWithSchemeTerm: number;
  /** In the app's 24-month window (undated reviews count, as in score.ts). */
  mentionsLast24Months: number;
  meanMentionRating: number | null;
  /** What the app shows without the LLM (rules classifier → scoreHospital): n, in-window NOT_PMJAY/NAME_COLLISION, rating split. */
  appN: number;
  excluded: number;
  appRating: number | null;
  deltaVsCityMedian: number | null;
  translated: number;
  devanagari: number;
  withIsoDate: number;
  oldest?: string;
  newest?: string;
  withOwnerReply: number;
  /** Google returned a next page: more matching reviews exist than the one page the app reads. */
  morePages: boolean;
}

interface Scored {
  stat: HospitalStat;
  score: HospitalScore;
}

function round(n: number | null, d = 2): number | null {
  return n === null ? null : Math.round(n * 10 ** d) / 10 ** d;
}

function statFor(h: Hospital, reviews: Review[], morePages: boolean, treatment: Treatment, now: Date): Scored {
  const rated = reviews.filter((r) => typeof r.rating === "number");
  const dates = reviews.map((r) => r.isoDate).filter((d): d is string => Boolean(d)).sort();
  const mentions = reviews.map((r) => classifyWithRules(h, r, reviewSentences(r), treatment));
  const score = scoreHospital(h, mentions, treatment, now);
  return {
    score,
    stat: {
      name: h.name,
      dataId: h.dataId,
      overallRating: h.rating,
      reviewCount: h.reviewCount,
      types: h.types,
      nameCollision: h.nameCollision,
      mentions: reviews.length,
      mentionsWithSchemeTerm: reviews.filter((r) => SCHEME_RE.test(`${r.text} ${r.textTranslated ?? ""}`) || (!h.nameCollision && AYUSHMAN_RE.test(r.text))).length,
      mentionsLast24Months: reviews.filter((r) => isInWindow(r, now)).length,
      meanMentionRating: rated.length ? round(rated.reduce((a, r) => a + (r.rating as number), 0) / rated.length) : null,
      appN: score.n,
      excluded: score.counts.NOT_PMJAY + score.counts.NAME_COLLISION,
      appRating: score.ayushmanRating,
      deltaVsCityMedian: null,
      translated: reviews.filter((r) => r.textTranslated).length,
      devanagari: reviews.filter((r) => /[ऀ-ॿ]/.test(r.textOriginal ?? r.text)).length,
      withIsoDate: dates.length,
      oldest: dates[0],
      newest: dates[dates.length - 1],
      withOwnerReply: reviews.filter((r) => r.ownerResponse).length,
      morePages,
    },
  };
}

interface ComboReport {
  combo: string;
  mapsResults: number;
  dropped: { name: string; reason: string }[];
  /** Requests skipped after an error; the numbers below exclude them. */
  failed: Failure[];
  hospitals: HospitalStat[];
  cityMedianAyushmanRating: number | null;
  hospitalsWithRatingSplit: number;
  hospitalsAtLeast1StarBelowMedian: string[];
  verdict: "PASS" | "SOFT_PASS" | "FAIL";
}

/** Verdict on the app's own numbers: city baseline and deltas exactly as the cards show them. */
function verdictFor(scored: Scored[]): Pick<ComboReport, "hospitals" | "cityMedianAyushmanRating" | "hospitalsWithRatingSplit" | "hospitalsAtLeast1StarBelowMedian" | "verdict"> {
  const scores = scored.map((s) => s.score);
  const baseline = computeBaseline(scores);
  const withDelta = applyBaseline(scores, baseline);
  const hospitals = scored.map((s, i) => ({ ...s.stat, deltaVsCityMedian: withDelta[i].deltaVsCityMedian }));
  const below = hospitals.filter((h) => h.deltaVsCityMedian !== null && h.deltaVsCityMedian <= -1.0).map((h) => h.name);
  const enough = baseline.hospitalsWithRating;
  const verdict = enough >= 4 && below.length > 0 ? "PASS" : enough >= 4 ? "SOFT_PASS" : "FAIL";
  return { hospitals, cityMedianAyushmanRating: baseline.medianAyushmanRating, hospitalsWithRatingSplit: enough, hospitalsAtLeast1StarBelowMedian: below, verdict };
}

// ---------- variants ----------

// Each variant changes one thing vs. the base request (query "ayushman", REVIEWS_SORT).
const VARIANTS = [
  ["devanagari", { query: "आयुष्मान" }],
  ["golden_card", { query: "golden card" }],
  ["most_relevant", { sortBy: "qualityScore" }],
] as const satisfies readonly (readonly [string, ReviewsRequestOptions])[];
type VariantLabel = (typeof VARIANTS)[number][0];

interface VariantStat {
  returned: number;
  newVsBase: number;
  isoDates: number;
  last24Months: number;
}

interface VariantRow {
  hospital: string;
  base: number;
  baseLast24Months: number;
  results: Partial<Record<VariantLabel, VariantStat | { error: string }>>;
}

// ---------- main ----------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await loadEnvLocal();

  // + 3: up to 3 in-flight reviews requests may be retried without num.
  const planCredits = args.cities.length * args.treatments.length * (1 + args.hospitals) + (args.news ? args.cities.length * 2 : 0) + args.variants * VARIANTS.length + 3;
  console.log(`Plan: cities=${args.cities.join(",")} treatments=${args.treatments.join(",")} hospitals/run=${args.hospitals} news=${args.news ? "en+hi" : "off"}`);
  console.log(`Worst-case credits ≈ ${planCredits} (cap ${args.maxCredits}; existing snapshots are reused for free)`);
  if (args.dryRun) return;

  const apiKey = readSerpApiKey();
  if (!apiKey) {
    console.error('SERPAPI_KEY is not set. Set SERPAPI_KEY in your local environment or ".env.local", then re-run.');
    process.exitCode = 1;
    return;
  }

  const account = await getAccountInfo({ apiKey });
  console.log(`Account: plan=${account.planName ?? "?"} searches left=${account.totalSearchesLeft ?? "?"} this hour=${account.thisHourSearches ?? "?"}/${account.rateLimitPerHour ?? "?"}`);
  if (typeof account.totalSearchesLeft === "number" && account.totalSearchesLeft < Math.min(planCredits, args.maxCredits) + 5) {
    throw new Error("Not enough SerpApi searches left for this plan. Lower --max-credits or the number of cities.");
  }

  const budget = new Budget(args.maxCredits);
  const existing = await readSnapshotIndex();
  const index: SnapshotIndex = existing ?? { version: SNAPSHOT_VERSION, generatedAt: "", reviewsNum: null, combos: {} };

  // Probe once: does google_maps_reviews accept num=20 together with query on the first page?
  // Only this script writes index.json, so a stored null means "rejected" (delete index.json to re-probe).
  let reviewsNum: number | undefined = existing ? (existing.reviewsNum ?? undefined) : 20;
  const now = new Date();
  const reports: ComboReport[] = [];
  const reviewsByHospital = new Map<string, Review[]>();

  for (const cityId of args.cities) {
    for (const treatmentId of args.treatments) {
      const city = CITIES[cityId];
      const treatment = TREATMENTS[treatmentId];
      const id = comboId(cityId, treatmentId);
      const failed: Failure[] = [];
      console.log(`\n== ${id} ==`);

      let maps: Awaited<ReturnType<typeof fetchOrReuse>>;
      try {
        maps = await fetchOrReuse(mapsSearchRequest(city, treatment), budget, args, apiKey);
      } catch (err) {
        failed.push(nonFatal(err, "google_maps"));
        reports.push({ combo: id, mapsResults: 0, dropped: [], failed, hospitals: [], cityMedianAyushmanRating: null, hospitalsWithRatingSplit: 0, hospitalsAtLeast1StarBelowMedian: [], verdict: "FAIL" });
        continue;
      }
      const raw = maps.response as { local_results?: unknown[] };
      const mapsResults = Array.isArray(raw.local_results) ? raw.local_results.length : 0;
      const { hospitals, dropped } = normalizeMapsResults(maps.response, treatment);
      const selected = hospitals.slice(0, args.hospitals);
      console.log(`google_maps: ${mapsResults} results → ${hospitals.length} hospitals kept, ${dropped.length} dropped${maps.reused ? " (snapshot)" : ""}`);

      const results = await mapLimit(selected, 3, async (h) => {
        // Decide the num fallback from what THIS request sent: up to 3 run in parallel with num,
        // each falls back on its own, and later requests read the settled value.
        const triedNum = reviewsNum;
        try {
          let res;
          try {
            res = await fetchOrReuse(reviewsRequest(h.dataId, { num: triedNum }), budget, args, apiKey);
          } catch (err) {
            if (triedNum === undefined || !isNumRejected(err)) throw err;
            if (reviewsNum !== undefined) console.log("  note: num is not accepted with query on the first page → retrying without num");
            reviewsNum = undefined;
            res = await fetchOrReuse(reviewsRequest(h.dataId, {}), budget, args, apiKey);
          }
          const reviews = normalizeReviews(res.response, h.dataId);
          reviewsByHospital.set(h.dataId, reviews);
          return { h, key: res.key, reviews, morePages: reviewsNextPageToken(res.response) !== undefined };
        } catch (err) {
          failed.push(nonFatal(err, h.name));
          return null;
        }
      });
      const ok = results.filter((r): r is NonNullable<typeof r> => r !== null);

      const v = verdictFor(ok.map(({ h, reviews, morePages }) => statFor(h, reviews, morePages, treatment, now)));
      for (const s of v.hospitals) {
        console.log(
          `  ${s.name.slice(0, 48).padEnd(48)} ★${s.overallRating ?? "-"} (${s.reviewCount ?? "-"}) | raw ${String(s.mentions).padStart(2)}, scheme-term ${s.mentionsWithSchemeTerm}, mean ★${s.meanMentionRating ?? "-"} | app n=${s.appN}, excluded ${s.excluded}, ★${s.appRating ?? "-"}${s.morePages ? " | more pages" : ""}${s.nameCollision ? " | NAME COLLISION" : ""}`,
        );
      }

      // Keys from an earlier run stay usable if a headline fetch fails this time.
      const newsKeys: { en?: string; hi?: string } = { ...index.combos[id]?.newsKeys };
      if (args.news) {
        for (const lang of ["en", "hi"] as const) {
          try {
            newsKeys[lang] = (await fetchOrReuse(newsRequest(city, lang), budget, args, apiKey)).key;
          } catch (err) {
            failed.push(nonFatal(err, `google_news ${lang}`));
          }
        }
      }

      // If every selected hospital failed, keep the previous entry rather than an empty combo.
      if (ok.length > 0 || selected.length === 0) {
        index.combos[id] = {
          city: cityId,
          treatment: treatmentId,
          mapsKey: maps.key,
          fetchedAt: maps.fetchedAt,
          hospitals: ok.map((r) => ({ dataId: r.h.dataId, reviewsKey: r.key })),
          ...(newsKeys.en || newsKeys.hi ? { newsKeys } : {}),
        };
        // Checkpoint: finished combos stay usable even if a later request aborts the run.
        await writeSnapshotIndex({ ...index, generatedAt: new Date().toISOString(), reviewsNum: reviewsNum ?? null });
      }
      reports.push({ combo: id, mapsResults, dropped, failed, ...v });
      console.log(
        `  → ${v.verdict}: ${v.hospitalsWithRatingSplit} hospitals with a rating split (app n ≥ 5); median ★${v.cityMedianAyushmanRating ?? "-"}; ≥1★ below median: ${v.hospitalsAtLeast1StarBelowMedian.join("; ") || "none"}${failed.length ? `; ${failed.length} skipped after errors` : ""}`,
      );
    }
  }

  // Optional variant tests on the best combo's top hospitals.
  const variantReport: VariantRow[] = [];
  const best = [...reports].sort((a, b) => b.hospitalsWithRatingSplit - a.hospitalsWithRatingSplit)[0];
  if (args.variants > 0 && best) {
    const targets = [...best.hospitals].sort((a, b) => b.appN - a.appN).slice(0, args.variants);
    console.log(`\n== variants on ${best.combo} (top ${targets.length}) ==`);
    for (const t of targets) {
      const baseReviews = reviewsByHospital.get(t.dataId) ?? [];
      const base = new Set(baseReviews.map((r) => r.reviewId));
      const row: VariantRow = { hospital: t.name, base: base.size, baseLast24Months: baseReviews.filter((r) => isInWindow(r, now)).length, results: {} };
      for (const [label, opts] of VARIANTS) {
        try {
          const res = await fetchOrReuse(reviewsRequest(t.dataId, { ...opts, num: reviewsNum }), budget, args, apiKey);
          const reviews = normalizeReviews(res.response, t.dataId);
          row.results[label] = {
            returned: reviews.length,
            newVsBase: reviews.filter((r) => !base.has(r.reviewId)).length,
            isoDates: reviews.filter((r) => r.isoDate).length,
            last24Months: reviews.filter((r) => isInWindow(r, now)).length,
          };
        } catch (err) {
          const f = nonFatal(err, `${t.name} ${label}`);
          row.results[label] = { error: `${f.code} ${f.message}` };
        }
      }
      variantReport.push(row);
      console.log(`  ${JSON.stringify(row)}`);
    }
  }

  index.generatedAt = new Date().toISOString();
  index.reviewsNum = reviewsNum ?? null;
  await writeSnapshotIndex(index);

  const overall = reports.some((r) => r.verdict === "PASS") ? "PASS" : reports.some((r) => r.verdict === "SOFT_PASS") ? "SOFT_PASS" : "FAIL";
  const latencyMs = summarizeLatencies(budget.latencies);
  const report = { generatedAt: index.generatedAt, overall, creditsUsed: budget.used, snapshotsReused: budget.reused, reviewsNum: index.reviewsNum, reviewsSort: REVIEWS_SORT, latencyMs, combos: reports, variants: variantReport };
  const outDir = path.join(process.cwd(), "data", "gate");
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, "report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");

  const variantCell = (r: VariantStat | { error: string } | undefined) =>
    !r ? "-" : "error" in r ? `error: ${r.error}` : `${r.returned} / +${r.newVsBase} / ${r.last24Months}`;
  const md = [
    `# Day-1 data gate — ${overall}`,
    "",
    `Generated ${index.generatedAt}. Credits used: ${budget.used} (reused ${budget.reused} snapshots). reviews num=${index.reviewsNum ?? "not accepted"}, sort_by=${REVIEWS_SORT}.`,
    "",
    "Kill criteria: PASS needs ≥4 hospitals with an Ayushman rating split (app n ≥ 5: in-window, excluding NOT_PMJAY/NAME_COLLISION, classified by the rules fallback) AND ≥1 hospital ≥1.0★ below the city median. SOFT_PASS = ≥4 hospitals with a rating split, weaker contrast. The LLM may exclude more reviews as NOT_PMJAY than the rules do, so a margin of one hospital is borderline.",
    "",
    ...reports.flatMap((r) => [
      `## ${r.combo} — ${r.verdict}`,
      "",
      `Ayushman ★ city median: ${r.cityMedianAyushmanRating ?? "n/a"} · hospitals with a rating split: ${r.hospitalsWithRatingSplit} · ≥1★ below median: ${r.hospitalsAtLeast1StarBelowMedian.join("; ") || "none"}`,
      "",
      "| Hospital | Overall ★ | Reviews | Mentions (raw) | n (app) | Excluded | Last 24 mo | Scheme term | Mention ★ (raw) | Ayushman ★ (app) | Δ vs median | Hindi | Owner replies | More pages |",
      "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
      ...r.hospitals.map(
        (h) =>
          `| ${h.name}${h.nameCollision ? " ⚠ name" : ""} | ${h.overallRating ?? "-"} | ${h.reviewCount ?? "-"} | ${h.mentions} | ${h.appN} | ${h.excluded} | ${h.mentionsLast24Months} | ${h.mentionsWithSchemeTerm} | ${h.meanMentionRating ?? "-"} | ${h.appRating ?? "-"} | ${h.deltaVsCityMedian ?? "-"} | ${h.devanagari} | ${h.withOwnerReply} | ${h.morePages ? "yes" : "no"} |`,
      ),
      "",
      ...(r.failed.length
        ? ["Skipped after errors (a FAIL may be missing data, not missing evidence; re-run to fill in):", "", ...r.failed.map((f) => `- ${f.name}: ${f.code} ${f.message}`), ""]
        : []),
    ]),
    ...(Object.keys(latencyMs).length
      ? [
          "## Live call latency",
          "",
          "Wall-clock time of each live SerpApi call this run. Tune RUN_BUDGET_MS in src/lib/server/pipeline.ts from these and from the Claude timings that npm run classify prints.",
          "",
          "| Engine | Calls | Median ms | p90 ms | Max ms |",
          "|---|---|---|---|---|",
          ...Object.entries(latencyMs).map(([engine, l]) => `| ${engine} | ${l.calls} | ${l.medianMs} | ${l.p90Ms} | ${l.maxMs} |`),
          "",
        ]
      : []),
    ...(variantReport.length && best
      ? [
          `## Variants on ${best.combo}`,
          "",
          `Base = query "ayushman", sort_by=${REVIEWS_SORT}. Each cell: returned / new vs base / in last 24 months.`,
          "",
          `| Hospital | Base (in last 24 mo) | ${VARIANTS.map(([label]) => label).join(" | ")} |`,
          `|---|---|${VARIANTS.map(() => "---|").join("")}`,
          ...variantReport.map((row) => `| ${row.hospital} | ${row.base} (${row.baseLast24Months}) | ${VARIANTS.map(([label]) => variantCell(row.results[label])).join(" | ")} |`),
          "",
        ]
      : []),
  ].join("\n");
  await fs.writeFile(path.join(outDir, "report.md"), md + "\n", "utf8");

  for (const [engine, l] of Object.entries(latencyMs)) {
    console.log(`Latency ${engine}: ${l.calls} live calls, median ${l.medianMs} ms, p90 ${l.p90Ms} ms, max ${l.maxMs} ms`);
  }
  console.log(`\nOVERALL: ${overall}. Credits used this run: ${budget.used}. Report: data/gate/report.md`);
  console.log("Next: npm run classify (needs ANTHROPIC_API_KEY), then commit data/snapshots and data/classifications.");
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Gate failed: ${message}`);
  process.exitCode = 1;
});
