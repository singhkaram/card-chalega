// Orchestrates one check: maps → reviews → classify → score → baseline → news,
// streaming CheckEvents as results become ready. Data comes from the store
// (memory → snapshot/sample files → live); live credits are spent only after
// guards.authorizeLive() grants a budget.
import "server-only";

import { CITIES, HOSPITALS_PER_RUN, TREATMENTS } from "@/config/presets";
import { classifyHospitalReviews, isLlmConfigured } from "@/lib/ai/classifier";
import { applyBaseline, computeBaseline, scoreHospital } from "@/lib/scoring/score";
import {
  comboId,
  mapsSearchRequest,
  newsRequest,
  normalizeMapsResults,
  normalizeNews,
  normalizeReviews,
  requestKey,
  reviewsNextPageToken,
  reviewsRequest,
  type SerpRequest,
  type SnapshotCombo,
  type SnapshotIndex,
} from "@/lib/serpapi";
import type {
  CheckErrorCode,
  CheckEvent,
  CityId,
  DataSource,
  Hospital,
  HospitalResult,
  NewsItem,
  RefreshResponse,
  TreatmentId,
} from "@/types/domain";
import { forEachLimit } from "./concurrency";
import { authorizeLive, NO_BUDGET, readConfig, type CreditBudget, type DataMode, type GuardConfig } from "./guards";
import { isInMemory, readIndex, resolve, StoreError, type ResolveOptions, type Resolved } from "./store";

// All reviews calls in one wave; the credit cost is the same as running them in batches.
const REVIEW_CONCURRENCY = HOSPITALS_PER_RUN;
const NEWS_PER_LANG = 5;
/** Worst case for a cold live run: maps + one reviews call per hospital + news (en, hi). */
export const LIVE_RUN_CREDITS = 1 + HOSPITALS_PER_RUN + 2;
/** Wall-clock budget for a check or refresh, with headroom under the routes' maxDuration (60 s). */
export const RUN_BUDGET_MS = 50_000;
/** A live news call cut off by the deadline still costs a credit, so it needs this much time left. */
const NEWS_MIN_REMAINING_MS = 6_000;
let runBudgetMs = RUN_BUDGET_MS;

/** Test hook: shorten (or reset with null) the run budget. */
export function setRunBudgetForTests(ms: number | null): void {
  runBudgetMs = ms ?? RUN_BUDGET_MS;
}

// Hospitals shown by the latest run per combo on this instance (bounded: ≤ cities × treatments).
// /api/refresh only accepts these ids or the snapshot index's — never arbitrary ones.
const lastRuns = new Map<string, Map<string, Hospital>>();

/** Test hook. */
export function clearLastRuns(): void {
  lastRuns.clear();
}

// ---------- helpers ----------

type Failure = { code: CheckErrorCode; message: string };

function failureFrom(err: unknown): Failure {
  if (err instanceof StoreError) return { code: err.code, message: err.message };
  return { code: "INTERNAL", message: "Something went wrong. Please try again." };
}

function comboLabel(c: { city: CityId; treatment: TreatmentId }): string {
  return `${CITIES[c.city]?.name ?? c.city} · ${TREATMENTS[c.treatment]?.label ?? c.treatment}`;
}

function offlineMessage(index: SnapshotIndex | null, sample: boolean): string {
  const combos = Object.values(index?.combos ?? {}).map(comboLabel);
  const lead = sample
    ? "Sample mode: only the synthetic sample combinations are available"
    : "Live search is off, so only pre-fetched cities are available";
  return combos.length > 0 ? `${lead}: ${combos.join(", ")}.` : `${lead}, and none are installed on this server.`;
}

// Weakest label wins so a mixed run is never presented as fresher than it is.
const SOURCE_RANK: Record<DataSource, number> = { sample: 3, snapshot: 2, cache: 1, live: 0 };

function overallSource(seen: Resolved[], fallback: DataSource): DataSource {
  if (seen.length === 0) return fallback;
  return seen.reduce<DataSource>((acc, r) => (SOURCE_RANK[r.source] > SOURCE_RANK[acc] ? r.source : acc), "live");
}

function oldest(seen: Resolved[]): string | null {
  let best: string | null = null;
  for (const r of seen) {
    const t = Date.parse(r.fetchedAt);
    if (Number.isFinite(t) && (best === null || t < Date.parse(best))) best = r.fetchedAt;
  }
  return best;
}

// ---------- planning ----------

interface Plan {
  mode: "live" | "snapshot" | "sample";
  dataMode: DataMode;
  combo: SnapshotCombo | null;
  reviewsNum: number | undefined;
  allowLive: boolean;
  budget: CreditBudget;
  release: () => void;
}

function reviewsLookup(plan: Pick<Plan, "combo" | "reviewsNum">, dataId: string): { req: SerpRequest; key?: string } {
  return {
    req: reviewsRequest(dataId, { num: plan.reviewsNum }),
    key: plan.combo?.hospitals.find((h) => h.dataId === dataId)?.reviewsKey,
  };
}

/** A repeat live run whose maps + reviews are all still in memory costs nothing. */
function servedFromMemory(id: string, mapsReq: SerpRequest, reviewsNum: number | undefined): boolean {
  const hospitals = lastRuns.get(id);
  if (!hospitals || hospitals.size === 0 || !isInMemory(requestKey(mapsReq))) return false;
  return [...hospitals.keys()].every((dataId) => isInMemory(requestKey(reviewsRequest(dataId, { num: reviewsNum }))));
}

async function planRun(
  input: { city: CityId; treatment: TreatmentId; ip: string },
  cfg: GuardConfig,
): Promise<{ ok: true; plan: Plan } | ({ ok: false } & Failure)> {
  const id = comboId(input.city, input.treatment);
  const offline = { allowLive: false, budget: NO_BUDGET, release: () => undefined };

  if (cfg.dataMode === "sample") {
    const index = await readIndex("sample");
    const combo = index?.combos[id];
    if (!index || !combo) return { ok: false, code: "NOT_AVAILABLE_OFFLINE", message: offlineMessage(index, true) };
    return { ok: true, plan: { mode: "sample", dataMode: "sample", combo, reviewsNum: index.reviewsNum ?? undefined, ...offline } };
  }

  const index = await readIndex("snapshot");
  const combo = index?.combos[id];
  const reviewsNum = index?.reviewsNum ?? undefined;
  if (combo) {
    return { ok: true, plan: { mode: "snapshot", dataMode: "snapshot", combo, reviewsNum, ...offline } };
  }
  if (!cfg.liveEnabled) return { ok: false, code: "NOT_AVAILABLE_OFFLINE", message: offlineMessage(index, false) };

  const mapsReq = mapsSearchRequest(CITIES[input.city], TREATMENTS[input.treatment]);
  if (servedFromMemory(id, mapsReq, reviewsNum)) {
    return { ok: true, plan: { mode: "live", dataMode: "snapshot", combo: null, reviewsNum, ...offline } };
  }

  const decision = await authorizeLive(input.ip, LIVE_RUN_CREDITS, cfg);
  if (!decision.ok) {
    const hint = decision.code === "NOT_AVAILABLE_OFFLINE" ? offlineMessage(index, false) : decision.message;
    return { ok: false, code: decision.code, message: hint };
  }
  const budget = decision.budget;
  return {
    ok: true,
    plan: { mode: "live", dataMode: "snapshot", combo: null, reviewsNum, allowLive: true, budget, release: () => budget.release() },
  };
}

// ---------- the run ----------

export interface CheckInput {
  city: CityId;
  treatment: TreatmentId;
  ip: string;
  signal?: AbortSignal;
}

export async function runCheck(input: CheckInput, emit: (e: CheckEvent) => void): Promise<void> {
  const started = Date.now();
  const planned = await planRun(input, readConfig());
  if (!planned.ok) {
    emit({ type: "error", code: planned.code, message: planned.message });
    return;
  }
  const plan = planned.plan;
  try {
    await execute(input, plan, started, emit);
  } finally {
    plan.release(); // unspent reserved credits go back to the daily pool
  }
}

async function execute(input: CheckInput, plan: Plan, started: number, emit: (e: CheckEvent) => void): Promise<void> {
  const { signal } = input;
  const city = CITIES[input.city];
  const treatment = TREATMENTS[input.treatment];
  const id = comboId(input.city, input.treatment);
  const seen: Resolved[] = [];
  // The deadline degrades the run (skipped hospitals, rules fallback, no live news)
  // but never ends it silently: only the client's `signal` stops event emission.
  const deadline = AbortSignal.timeout(Math.max(0, started + runBudgetMs - Date.now()));
  const work = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const opts = (key?: string): ResolveOptions => ({ allowLive: plan.allowLive, budget: plan.budget, signal: work, key, mode: plan.dataMode });

  emit({ type: "meta", city: input.city, treatment: input.treatment, mode: plan.mode, llm: isLlmConfigured(), startedAt: new Date(started).toISOString() });
  emit({ type: "progress", step: "maps", message: plan.mode === "live" ? "Searching Google Maps for hospitals" : "Loading saved Google Maps results" });

  // 1. Maps → hospital list
  let maps: Resolved;
  try {
    maps = await resolve(mapsSearchRequest(city, treatment), opts(plan.combo?.mapsKey));
  } catch (err) {
    if (!signal?.aborted) emit({ type: "error", ...failureFrom(err) });
    return;
  }
  if (signal?.aborted) return;
  seen.push(maps);

  const found = normalizeMapsResults(maps.response, treatment).hospitals;
  let hospitals: Hospital[];
  if (plan.combo) {
    // Snapshot combos fix the selection and order the gate script chose.
    const byId = new Map(found.map((h) => [h.dataId, h]));
    hospitals = plan.combo.hospitals.map((h) => byId.get(h.dataId)).filter((h): h is Hospital => h !== undefined);
  } else {
    hospitals = found.slice(0, HOSPITALS_PER_RUN);
  }
  if (hospitals.length === 0) {
    const what = treatment.id === "general" ? "No hospitals" : `No hospitals for ${treatment.label.toLowerCase()}`;
    emit({ type: "error", code: "NO_RESULTS", message: `${what} were found near ${city.name}.` });
    return;
  }
  lastRuns.set(id, new Map(hospitals.map((h) => [h.dataId, h])));
  emit({ type: "hospitals", hospitals, source: maps.source, fetchedAt: maps.fetchedAt });

  // 2–4. Reviews → classify → score, per hospital, emitted as each completes
  const total = hospitals.length;
  const results: (HospitalResult | undefined)[] = new Array(total);
  const launched: boolean[] = new Array(total).fill(false);
  const skipped: string[] = [];
  let reviewsDone = 0;
  let classified = 0;
  const now = new Date();
  emit({ type: "progress", step: "reviews", message: `Reading Ayushman reviews for ${total} hospitals`, done: 0, total });

  await forEachLimit(
    hospitals,
    REVIEW_CONCURRENCY,
    async (hospital, i) => {
      launched[i] = true;
      const { req, key } = reviewsLookup(plan, hospital.dataId);
      let res: Resolved;
      try {
        res = await resolve(req, opts(key));
      } catch {
        if (signal?.aborted) return;
        skipped.push(hospital.name);
        reviewsDone += 1;
        emit({ type: "progress", step: "reviews", message: `Skipped ${hospital.name}: reviews unavailable`, done: reviewsDone, total });
        return;
      }
      if (signal?.aborted) return;
      seen.push(res);
      reviewsDone += 1;
      emit({ type: "progress", step: "reviews", message: `Reviews loaded for ${hospital.name}`, done: reviewsDone, total });

      try {
        const reviews = normalizeReviews(res.response, hospital.dataId);
        const mentions = await classifyHospitalReviews(hospital, reviews, treatment, { signal: work });
        if (signal?.aborted) return;
        classified += 1;
        emit({ type: "progress", step: "classify", message: `Classified ${reviews.length} reviews for ${hospital.name}`, done: classified, total });
        const score = scoreHospital(hospital, mentions, treatment, now);
        const result: HospitalResult = {
          hospital,
          mentions,
          score,
          reviewsFetchedAt: res.fetchedAt,
          source: res.source,
          moreReviews: reviewsNextPageToken(res.response) !== undefined,
        };
        results[i] = result;
        emit({ type: "hospital", result });
      } catch {
        if (signal?.aborted) return;
        skipped.push(hospital.name);
        emit({ type: "progress", step: "classify", message: `Skipped ${hospital.name}: could not analyse reviews`, done: classified, total });
      }
    },
    work,
  );
  if (signal?.aborted) return;
  // Hospitals the deadline stopped from starting are skipped too.
  hospitals.forEach((h, i) => {
    if (!launched[i]) skipped.push(h.name);
  });

  const completed = results.filter((r): r is HospitalResult => r !== undefined);
  if (completed.length === 0) {
    emit({ type: "error", code: "UPSTREAM", message: "Reviews could not be loaded for any hospital. Please try again later." });
    return;
  }

  // 5. City baseline (scores in display order)
  const skippedNote = skipped.length > 0 ? ` (${skipped.length} skipped: ${skipped.join(", ")})` : "";
  emit({ type: "progress", step: "score", message: `Comparing ${completed.length} hospitals with the city median${skippedNote}` });
  const scores = completed.map((r) => r.score);
  const baseline = computeBaseline(scores);
  emit({ type: "baseline", baseline, scores: applyBaseline(scores, baseline) });

  // 6. News (best-effort context; failures are ignored). Near the deadline only stored news is used.
  const liveNews = plan.allowLive && started + runBudgetMs - Date.now() >= NEWS_MIN_REMAINING_MS;
  const newsReqs: { lang: "en" | "hi"; req: SerpRequest; key?: string }[] = [];
  for (const lang of ["en", "hi"] as const) {
    if (plan.combo) {
      const key = plan.combo.newsKeys?.[lang];
      if (key) newsReqs.push({ lang, req: newsRequest(city, lang), key });
    } else {
      newsReqs.push({ lang, req: newsRequest(city, lang) });
    }
  }
  if (newsReqs.length > 0) {
    emit({ type: "progress", step: "news", message: `Checking recent news for ${city.name}` });
    const settled = await Promise.allSettled(newsReqs.map((n) => resolve(n.req, { ...opts(n.key), allowLive: liveNews })));
    if (signal?.aborted) return;
    const items: NewsItem[] = [];
    const newsSeen: Resolved[] = [];
    settled.forEach((s, i) => {
      if (s.status !== "fulfilled") return;
      newsSeen.push(s.value);
      items.push(...normalizeNews(s.value.response, newsReqs[i].lang, NEWS_PER_LANG));
    });
    if (newsSeen.length > 0) {
      seen.push(...newsSeen);
      emit({ type: "news", items, source: overallSource(newsSeen, newsSeen[0].source), fetchedAt: oldest(newsSeen) ?? newsSeen[0].fetchedAt });
    }
  }

  emit({
    type: "done",
    creditsUsed: plan.budget.used,
    source: overallSource(seen, plan.mode),
    oldestFetchedAt: oldest(seen),
    durationMs: Date.now() - started,
  });
}

// ---------- 1-credit refresh of one hospital ----------

export interface RefreshInput {
  city: CityId;
  treatment: TreatmentId;
  dataId: string;
  ip: string;
  signal?: AbortSignal;
}

/** The hospital, if `dataId` belongs to this combo's last run or its snapshot. */
async function knownHospital(
  input: RefreshInput,
  combo: SnapshotCombo | undefined,
): Promise<Hospital | null> {
  const fromRun = lastRuns.get(comboId(input.city, input.treatment))?.get(input.dataId);
  if (fromRun) return fromRun;
  if (!combo?.hospitals.some((h) => h.dataId === input.dataId)) return null;
  const treatment = TREATMENTS[input.treatment];
  try {
    const maps = await resolve(mapsSearchRequest(CITIES[input.city], treatment), {
      allowLive: false,
      budget: NO_BUDGET,
      key: combo.mapsKey,
      mode: "snapshot",
    });
    return normalizeMapsResults(maps.response, treatment).hospitals.find((h) => h.dataId === input.dataId) ?? null;
  } catch {
    return null;
  }
}

export async function runRefresh(input: RefreshInput): Promise<RefreshResponse> {
  // Same deadline as a check: a slow LLM falls back to the rules before the route times out.
  const deadline = AbortSignal.timeout(runBudgetMs);
  const work = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
  const cfg = readConfig();
  if (!cfg.liveEnabled || cfg.dataMode === "sample") {
    return { ok: false, code: "NOT_AVAILABLE_OFFLINE", message: "Live refresh is turned off on this server." };
  }

  const index = await readIndex("snapshot");
  const combo = index?.combos[comboId(input.city, input.treatment)];
  const hospital = await knownHospital(input, combo);
  if (!hospital) {
    // Membership can only be judged when this instance holds the combo's run or a snapshot.
    const knowsCombo = combo !== undefined || lastRuns.has(comboId(input.city, input.treatment));
    return knowsCombo
      ? { ok: false, code: "INVALID_INPUT", message: "That hospital is not part of this city and treatment." }
      : { ok: false, code: "NOT_AVAILABLE_OFFLINE", message: "The server no longer holds this run. Press Check again, then refresh." };
  }

  const decision = await authorizeLive(input.ip, 1, cfg);
  if (!decision.ok) return { ok: false, code: decision.code, message: decision.message };
  const budget = decision.budget;
  try {
    const treatment = TREATMENTS[input.treatment];
    const { req, key } = reviewsLookup({ combo: combo ?? null, reviewsNum: index?.reviewsNum ?? undefined }, hospital.dataId);
    const res = await resolve(req, { allowLive: true, budget, prefer: "live", key, signal: work, mode: "snapshot" });
    const reviews = normalizeReviews(res.response, hospital.dataId);
    const mentions = await classifyHospitalReviews(hospital, reviews, treatment, { signal: work });
    // Baseline is not re-applied: delta stays null for a single refreshed hospital.
    const score = scoreHospital(hospital, mentions, treatment, new Date());
    return {
      ok: true,
      result: {
        hospital,
        mentions,
        score,
        reviewsFetchedAt: res.fetchedAt,
        source: res.source,
        moreReviews: reviewsNextPageToken(res.response) !== undefined,
      },
      creditsUsed: budget.used,
    };
  } catch (err) {
    return { ok: false, ...failureFrom(err) };
  } finally {
    budget.release();
  }
}
