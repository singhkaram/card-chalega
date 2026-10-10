import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SnapshotEntry, SnapshotIndex } from "@/lib/serpapi";
import { createGuardState, setGuardStateForTests, type GuardState } from "@/lib/server/guards";
import { clearLastRuns, runCheck, runRefresh, setRunBudgetForTests } from "@/lib/server/pipeline";
import { clearMemory } from "@/lib/server/store";
import type {
  CheckEvent,
  ClassifiedMention,
  EvidenceClass,
  Hospital,
  HospitalScore,
  Review,
  Treatment,
} from "@/types/domain";

const mocks = vi.hoisted(() => ({
  serpApiSearch: vi.fn<(engine: string, params: Record<string, string | number | undefined>) => Promise<unknown>>(),
  readSnapshotIndex: vi.fn<() => Promise<unknown>>(),
  classify: vi.fn<(h: Hospital, reviews: Review[], t: Treatment, opts?: { signal?: AbortSignal }) => Promise<ClassifiedMention[]>>(),
}));

// No network and no LLM: SerpApi client, snapshot index, classifier and scoring are stubbed.
vi.mock("@/lib/serpapi/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/serpapi/client")>()),
  serpApiSearch: mocks.serpApiSearch,
}));
vi.mock("@/lib/serpapi/snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/serpapi/snapshot")>()),
  readSnapshotIndex: mocks.readSnapshotIndex,
}));
vi.mock("@/lib/ai/classifier", () => ({
  isLlmConfigured: () => false,
  classifyHospitalReviews: mocks.classify,
}));
vi.mock("@/lib/scoring/score", () => ({
  scoreHospital: (h: Hospital, mentions: ClassifiedMention[]): HospitalScore => ({
    dataId: h.dataId,
    n: mentions.length,
    counts: {} as Record<EvidenceClass, number>,
    problemCount: 0,
    cashlessOkCount: 0,
    ayushmanRating: mentions.length >= 5 ? 3 : null,
    overallRating: h.rating ?? null,
    deltaVsCityMedian: null,
    label: "mixed_reports",
    treatmentMentions: { k: 0, n: mentions.length },
    latestReportIso: null,
    amountsInr: [],
  }),
  computeBaseline: (scores: HospitalScore[]) => ({ medianAyushmanRating: 3, hospitalsWithRating: 0, hospitalsConsidered: scores.length }),
  applyBaseline: (scores: HospitalScore[]) => scores.map((s) => ({ ...s, deltaVsCityMedian: 0 })),
}));

// ---------- sample data as fake live responses ----------

const SAMPLE = path.join(process.cwd(), "data", "sample");
const sampleIndex = JSON.parse(readFileSync(path.join(SAMPLE, "index.json"), "utf8")) as SnapshotIndex;
const sampleEntry = (key: string) => JSON.parse(readFileSync(path.join(SAMPLE, "entries", `${key}.json`), "utf8")) as SnapshotEntry;
const lko = sampleIndex.combos["lucknow:general"];

function fakeLive(engine: string, params: Record<string, string | number | undefined>): Promise<unknown> {
  if (engine === "google_maps") return Promise.resolve(sampleEntry(lko.mapsKey).response);
  if (engine === "google_news") return Promise.resolve(sampleEntry(lko.newsKeys![params.hl === "hi" ? "hi" : "en"]!).response);
  const h = lko.hospitals.find((x) => x.dataId === params.data_id);
  return h ? Promise.resolve(sampleEntry(h.reviewsKey).response) : Promise.reject(new Error("unknown"));
}

function mentionFor(r: Review): ClassifiedMention {
  return {
    reviewId: r.reviewId,
    hospitalDataId: r.hospitalDataId,
    cls: "MENTION_ONLY",
    sentenceIds: [1],
    quote: r.text.slice(0, 40),
    amountInr: null,
    treatmentMentioned: null,
    rating: r.rating,
    isoDate: r.isoDate,
    classifier: "rules",
  };
}

/** A classifier that only answers (with rules-like mentions) once its signal aborts. */
function classifyUntilAborted(_h: Hospital, reviews: Review[], _t: Treatment, opts?: { signal?: AbortSignal }): Promise<ClassifiedMention[]> {
  return new Promise((resolve) => {
    const answer = () => resolve(reviews.map(mentionFor));
    if (!opts?.signal || opts.signal.aborted) answer();
    else opts.signal.addEventListener("abort", answer, { once: true });
  });
}

async function collect(input: Parameters<typeof runCheck>[0]): Promise<CheckEvent[]> {
  const events: CheckEvent[] = [];
  await runCheck(input, (e) => events.push(e));
  return events;
}

const kinds = (events: CheckEvent[]) => events.filter((e) => e.type !== "progress").map((e) => e.type);

let guards: GuardState;

beforeEach(() => {
  clearMemory();
  clearLastRuns();
  guards = createGuardState({ fetchAccount: async () => ({ totalSearchesLeft: 1000 }) });
  setGuardStateForTests(guards);
  mocks.serpApiSearch.mockReset();
  mocks.serpApiSearch.mockRejectedValue(new Error("network must not be touched"));
  mocks.readSnapshotIndex.mockReset();
  mocks.readSnapshotIndex.mockResolvedValue(null);
  mocks.classify.mockReset();
  mocks.classify.mockImplementation(async (_h, reviews) => reviews.map(mentionFor));
});
afterEach(() => {
  vi.unstubAllEnvs();
  setGuardStateForTests(null);
  setRunBudgetForTests(null);
});

function sampleMode() {
  vi.stubEnv("DATA_SOURCE", "sample");
  vi.stubEnv("LIVE_SEARCH", "off");
}
function liveMode() {
  vi.stubEnv("DATA_SOURCE", "");
  vi.stubEnv("LIVE_SEARCH", "on");
  vi.stubEnv("SERPAPI_KEY", "test-key");
}

describe("runCheck — sample mode", () => {
  it("streams meta → hospitals → hospital×N → baseline → news → done", async () => {
    sampleMode();
    const events = await collect({ city: "lucknow", treatment: "general", ip: "1.1.1.1" });
    expect(kinds(events)).toEqual(["meta", "hospitals", ...Array(8).fill("hospital"), "baseline", "news", "done"]);

    const meta = events[0];
    expect(meta).toMatchObject({ type: "meta", mode: "sample", llm: false, city: "lucknow", treatment: "general" });
    const hospitals = events.find((e) => e.type === "hospitals");
    expect(hospitals?.type === "hospitals" && hospitals.hospitals.every((h) => h.name.endsWith("(Sample)"))).toBe(true);
    expect(hospitals?.type === "hospitals" && hospitals.source).toBe("sample");

    const results = events.flatMap((e) => (e.type === "hospital" ? [e.result] : []));
    expect(results.every((r) => r.source === "sample" && r.score.deltaVsCityMedian === null)).toBe(true);
    // Sample responses have no next page, so no card claims Google has more reviews.
    expect(results.every((r) => r.moreReviews === false)).toBe(true);
    const baseline = events.find((e) => e.type === "baseline");
    expect(baseline?.type === "baseline" && baseline.scores.length).toBe(8);

    const news = events.find((e) => e.type === "news");
    expect(news?.type === "news" && news.items.length).toBe(5);

    const done = events[events.length - 1];
    expect(done).toMatchObject({ type: "done", creditsUsed: 0, source: "sample" });
    expect(done.type === "done" && done.oldestFetchedAt).toMatch(/^2026-/);

    const progress = events.filter((e) => e.type === "progress");
    expect(progress[0]).toMatchObject({ step: "maps" });
    expect(progress.some((p) => p.type === "progress" && p.step === "reviews" && p.done === 8 && p.total === 8)).toBe(true);
    expect(mocks.classify).toHaveBeenCalledTimes(8);
    expect(mocks.serpApiSearch).not.toHaveBeenCalled();
  });

  it("refuses combos that are not in the sample set", async () => {
    sampleMode();
    const events = await collect({ city: "jaipur", treatment: "cataract", ip: "1.1.1.1" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", code: "NOT_AVAILABLE_OFFLINE" });
    expect(events[0].type === "error" && events[0].message).toContain("Lucknow");
  });

  it("stops launching work when the client disconnects", async () => {
    sampleMode();
    const controller = new AbortController();
    mocks.classify.mockImplementation(async (_h, reviews) => {
      controller.abort();
      return reviews.map(mentionFor);
    });
    const events = await collect({ city: "lucknow", treatment: "general", ip: "1.1.1.1", signal: controller.signal });
    expect(mocks.classify).toHaveBeenCalledTimes(1);
    expect(kinds(events)).toEqual(["meta", "hospitals"]);
  });

  it("skips a hospital whose analysis fails and still finishes", async () => {
    sampleMode();
    mocks.classify.mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    const events = await collect({ city: "patna", treatment: "dialysis", ip: "1.1.1.1" });
    expect(kinds(events)).toEqual(["meta", "hospitals", ...Array(5).fill("hospital"), "baseline", "news", "done"]);
    expect(events.some((e) => e.type === "progress" && e.message.startsWith("Skipped"))).toBe(true);
  });
});

describe("runCheck — snapshot / live gating", () => {
  it("returns NOT_AVAILABLE_OFFLINE when live is off and nothing is pre-fetched", async () => {
    vi.stubEnv("DATA_SOURCE", "");
    vi.stubEnv("LIVE_SEARCH", "off");
    const events = await collect({ city: "indore", treatment: "general", ip: "1.1.1.1" });
    expect(events).toEqual([{ type: "error", code: "NOT_AVAILABLE_OFFLINE", message: expect.stringContaining("pre-fetched") }]);
  });

  it("returns RATE_LIMITED when the IP has no live runs left", async () => {
    liveMode();
    vi.stubEnv("LIVE_RUNS_PER_IP_PER_HOUR", "0");
    const events = await collect({ city: "indore", treatment: "general", ip: "1.1.1.1" });
    expect(events).toEqual([{ type: "error", code: "RATE_LIMITED", message: expect.any(String) }]);
    expect(mocks.serpApiSearch).not.toHaveBeenCalled();
  });

  it("returns NO_RESULTS when Maps finds no hospitals, and releases unspent credits", async () => {
    liveMode();
    mocks.serpApiSearch.mockResolvedValue({ search_metadata: { status: "Success" }, local_results: [] });
    const events = await collect({ city: "indore", treatment: "general", ip: "1.1.1.1" });
    expect(kinds(events)).toEqual(["meta", "error"]);
    expect(events[events.length - 1]).toMatchObject({ type: "error", code: "NO_RESULTS" });
    expect(guards.credits.usedToday()).toBe(1);
    expect(guards.credits.remaining(40)).toBe(39);
  });

  it("maps upstream failures to UPSTREAM without details", async () => {
    liveMode();
    const events = await collect({ city: "indore", treatment: "general", ip: "1.1.1.1" });
    const last = events[events.length - 1];
    expect(last).toMatchObject({ type: "error", code: "UPSTREAM" });
    expect(JSON.stringify(last)).not.toContain("network must not be touched");
  });

  it("runs live once (11 credits), then serves the repeat from memory for 0", async () => {
    liveMode();
    mocks.serpApiSearch.mockImplementation(fakeLive);
    const first = await collect({ city: "lucknow", treatment: "general", ip: "9.9.9.9" });
    expect(kinds(first)).toEqual(["meta", "hospitals", ...Array(8).fill("hospital"), "baseline", "news", "done"]);
    expect(first[0]).toMatchObject({ mode: "live" });
    expect(first[first.length - 1]).toMatchObject({ type: "done", creditsUsed: 11, source: "live" });
    expect(mocks.serpApiSearch).toHaveBeenCalledTimes(11);

    const second = await collect({ city: "lucknow", treatment: "general", ip: "9.9.9.9" });
    expect(second[second.length - 1]).toMatchObject({ type: "done", creditsUsed: 0, source: "cache" });
    expect(mocks.serpApiSearch).toHaveBeenCalledTimes(11);
    expect(guards.credits.usedToday()).toBe(11);
    // Only the credit-spending run counted against the IP.
    expect(guards.limiter.allows("9.9.9.9", 2)).toBe(true);
  });
});

describe("runCheck — more reviews on Google", () => {
  it("sets moreReviews only for hospitals whose reviews response has a next page", async () => {
    liveMode();
    const paged = lko.hospitals[0].dataId;
    mocks.serpApiSearch.mockImplementation(async (engine, params) => {
      const res = await fakeLive(engine, params);
      return engine === "google_maps_reviews" && params.data_id === paged
        ? { ...(res as object), serpapi_pagination: { next_page_token: "token-for-page-2" } }
        : res;
    });
    const events = await collect({ city: "lucknow", treatment: "general", ip: "8.8.4.4" });
    const results = events.flatMap((e) => (e.type === "hospital" ? [e.result] : []));
    expect(results).toHaveLength(8);
    for (const r of results) expect(r.moreReviews).toBe(r.hospital.dataId === paged);

    const refreshed = await runRefresh({ city: "lucknow", treatment: "general", dataId: paged, ip: "8.8.4.4" });
    expect(refreshed.ok && refreshed.result.moreReviews).toBe(true);
  });
});

describe("runRefresh", () => {
  it("is refused when live is off", async () => {
    vi.stubEnv("LIVE_SEARCH", "off");
    const res = await runRefresh({ city: "lucknow", treatment: "general", dataId: lko.hospitals[0].dataId, ip: "1.1.1.1" });
    expect(res).toMatchObject({ ok: false, code: "NOT_AVAILABLE_OFFLINE" });
  });

  it("accepts only hospitals from the combo's last run or snapshot, and spends 1 credit", async () => {
    liveMode();
    mocks.serpApiSearch.mockImplementation(fakeLive);
    // A fresh instance holds neither the run nor a snapshot: not a bad request, just ask for a re-check.
    const unknownFirst = await runRefresh({ city: "lucknow", treatment: "general", dataId: lko.hospitals[0].dataId, ip: "2.2.2.2" });
    expect(unknownFirst).toMatchObject({ ok: false, code: "NOT_AVAILABLE_OFFLINE" });

    await collect({ city: "lucknow", treatment: "general", ip: "2.2.2.2" });
    const calls = mocks.serpApiSearch.mock.calls.length;
    // Once the run is held, an id outside it is refused before any credit is reserved.
    const stranger = await runRefresh({ city: "lucknow", treatment: "general", dataId: "0x1:0x2", ip: "2.2.2.2" });
    expect(stranger).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(mocks.serpApiSearch.mock.calls.length).toBe(calls);
    const res = await runRefresh({ city: "lucknow", treatment: "general", dataId: lko.hospitals[1].dataId, ip: "2.2.2.2" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.creditsUsed).toBe(1);
      expect(res.result.source).toBe("live");
      expect(res.result.hospital.dataId).toBe(lko.hospitals[1].dataId);
      expect(res.result.score.deltaVsCityMedian).toBeNull();
    }
    expect(mocks.serpApiSearch.mock.calls.length).toBe(calls + 1);

    const other = await runRefresh({ city: "patna", treatment: "dialysis", dataId: lko.hospitals[1].dataId, ip: "2.2.2.2" });
    expect(other).toMatchObject({ ok: false, code: "NOT_AVAILABLE_OFFLINE" });
  });

  it("falls back to the rules when classification outlives the run budget", async () => {
    liveMode();
    mocks.serpApiSearch.mockImplementation(fakeLive);
    await collect({ city: "lucknow", treatment: "general", ip: "3.3.3.3" });
    setRunBudgetForTests(500);
    mocks.classify.mockImplementation(classifyUntilAborted);
    const res = await runRefresh({ city: "lucknow", treatment: "general", dataId: lko.hospitals[2].dataId, ip: "3.3.3.3" });
    expect(res).toMatchObject({ ok: true, creditsUsed: 1 });
  });
});

describe("runCheck — run deadline", () => {
  it("degrades a slow run instead of overrunning: rules fallback, baseline and done, no error", async () => {
    sampleMode();
    setRunBudgetForTests(500);
    mocks.classify.mockImplementation(classifyUntilAborted);
    const events = await collect({ city: "lucknow", treatment: "general", ip: "1.1.1.1" });
    expect(kinds(events)).toEqual(["meta", "hospitals", ...Array(8).fill("hospital"), "baseline", "news", "done"]);
    const done = events[events.length - 1];
    expect(done.type === "done" && done.durationMs).toBeLessThan(5_000);
    expect(mocks.classify.mock.calls.every(([, , , opts]) => opts?.signal?.aborted === true)).toBe(true);
  });

  it("skips live news when the deadline has passed, so no credit is spent on it", async () => {
    liveMode();
    setRunBudgetForTests(500);
    mocks.serpApiSearch.mockImplementation(fakeLive);
    mocks.classify.mockImplementation(classifyUntilAborted);
    const events = await collect({ city: "lucknow", treatment: "general", ip: "4.4.4.4" });
    expect(kinds(events)).toEqual(["meta", "hospitals", ...Array(8).fill("hospital"), "baseline", "done"]);
    expect(events[events.length - 1]).toMatchObject({ type: "done", creditsUsed: 9 });
    expect(mocks.serpApiSearch).toHaveBeenCalledTimes(9);
    expect(mocks.serpApiSearch.mock.calls.some(([engine]) => engine === "google_news")).toBe(false);
  });
});

describe("POST /api/check", () => {
  const post = (body: string, type = "application/json") =>
    new Request("http://localhost/api/check", { method: "POST", headers: { "content-type": type }, body });

  it("streams NDJSON events", async () => {
    sampleMode();
    const { POST } = await import("@/app/api/check/route");
    const res = await POST(post(JSON.stringify({ city: "patna", treatment: "dialysis" })));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    expect(text.endsWith("\n")).toBe(true);
    const events = text.trim().split("\n").map((l) => JSON.parse(l) as CheckEvent);
    expect(events[0].type).toBe("meta");
    expect(events[events.length - 1].type).toBe("done");
  });

  it("rejects invalid input with 400 / 415", async () => {
    const { POST } = await import("@/app/api/check/route");
    const bad = await POST(post(JSON.stringify({ city: "delhi", treatment: "general" })));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: "INVALID_INPUT" });
    const extra = await POST(post(JSON.stringify({ city: "patna", treatment: "dialysis", q: "x" })));
    expect(extra.status).toBe(400);
    const plain = await POST(post(JSON.stringify({ city: "patna", treatment: "dialysis" }), "text/plain"));
    expect(plain.status).toBe(415);
  });
});
