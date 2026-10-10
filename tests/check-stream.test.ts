import { describe, expect, it } from "vitest";
import {
  checkStreamReducer,
  errorFromHttp,
  initialCheckState,
  parseCheckEventLine,
  parseNdjsonChunk,
  type CheckStreamState,
} from "@/hooks/useCheckStream";
import { orderResults } from "@/components/results/sort";
import {
  classifierOf,
  isOutsideWindow,
  pickTopQuotes,
  runClassifierOf,
  uncountedMentions,
} from "@/components/results/evidence";
import {
  approxAge,
  describeDelta,
  displayedDelta,
  formatIst,
  formatStars,
  newsDateText,
  safeExternalUrl,
} from "@/components/results/format";
import { buildWhatsAppSummary, RESULTS_CAVEAT } from "@/components/results/share";
import type {
  CheckEvent,
  ClassifiedMention,
  EvidenceClass,
  Hospital,
  HospitalResult,
  HospitalScore,
} from "@/types/domain";

// ---------- fixtures ----------

function counts(partial: Partial<Record<EvidenceClass, number>> = {}): Record<EvidenceClass, number> {
  return {
    CASHLESS_OK: 0,
    CHARGED_FOR_PACKAGE_ITEMS: 0,
    CHARGED_OUTSIDE_PACKAGE_OR_UNCLEAR: 0,
    REFUSED: 0,
    ELIGIBILITY_OR_SPECIALTY_DISPUTE: 0,
    DELAY: 0,
    NOT_PMJAY: 0,
    NAME_COLLISION: 0,
    MENTION_ONLY: 0,
    ...partial,
  };
}

function hospital(dataId: string, name = `Hospital ${dataId}`, reviewCount = 100): Hospital {
  return { dataId, name, types: ["Hospital"], isGovernment: false, nameCollision: false, rating: 4.2, reviewCount };
}

function score(dataId: string, over: Partial<HospitalScore> = {}): HospitalScore {
  return {
    dataId,
    n: 0,
    counts: counts(),
    problemCount: 0,
    cashlessOkCount: 0,
    ayushmanRating: null,
    overallRating: 4.2,
    deltaVsCityMedian: null,
    label: "too_few_reports",
    treatmentMentions: { k: 0, n: 0 },
    latestReportIso: null,
    amountsInr: [],
    ...over,
  };
}

function result(dataId: string, s: Partial<HospitalScore> = {}, name?: string): HospitalResult {
  return {
    hospital: hospital(dataId, name),
    mentions: [],
    score: score(dataId, s),
    reviewsFetchedAt: "2026-10-05T08:40:00.000Z",
    source: "snapshot",
  };
}

function mention(reviewId: string, cls: EvidenceClass, isoDate: string): ClassifiedMention {
  return {
    reviewId,
    hospitalDataId: "a",
    cls,
    sentenceIds: [0],
    quote: `quote ${reviewId}`,
    amountInr: null,
    treatmentMentioned: null,
    isoDate,
    classifier: "llm",
  };
}

const line = (ev: CheckEvent | Record<string, unknown>) => JSON.stringify(ev) + "\n";

function run(events: CheckEvent[], from: CheckStreamState = checkStreamReducer(initialCheckState(), { type: "start" })) {
  return events.reduce((s, event) => checkStreamReducer(s, { type: "event", event }), from);
}

// ---------- NDJSON parsing ----------

describe("parseNdjsonChunk", () => {
  it("reassembles a JSON line split across chunk boundaries", () => {
    const full = line({ type: "progress", step: "maps", message: "Finding hospitals" });
    const cut = 17;
    const a = parseNdjsonChunk("", full.slice(0, cut));
    expect(a.events).toEqual([]);
    expect(a.pending).toBe(full.slice(0, cut));

    const b = parseNdjsonChunk(a.pending, full.slice(cut));
    expect(b.events).toEqual([{ type: "progress", step: "maps", message: "Finding hospitals" }]);
    expect(b.pending).toBe("");
  });

  it("handles Devanagari text split across chunks", () => {
    const full = line({ type: "progress", step: "news", message: "आयुष्मान समाचार" });
    const mid = full.indexOf("समाचार");
    const a = parseNdjsonChunk("", full.slice(0, mid));
    const b = parseNdjsonChunk(a.pending, full.slice(mid));
    expect(b.events).toHaveLength(1);
    expect(b.events[0]).toMatchObject({ message: "आयुष्मान समाचार" });
  });

  it("parses multiple events in one chunk and keeps the trailing partial line", () => {
    const chunk =
      line({ type: "meta", city: "lucknow", treatment: "general", mode: "snapshot", llm: true, startedAt: "2026-10-05T08:40:00Z" }) +
      line({ type: "progress", step: "reviews", message: "Reading", done: 1, total: 8 }) +
      '{"type":"progress","step":"rev';
    const out = parseNdjsonChunk("", chunk);
    expect(out.events.map((e) => e.type)).toEqual(["meta", "progress"]);
    expect(out.pending).toBe('{"type":"progress","step":"rev');
  });

  it("tolerates CRLF line endings and blank lines", () => {
    const out = parseNdjsonChunk("", '{"type":"done","creditsUsed":0,"source":"snapshot","oldestFetchedAt":null,"durationMs":5}\r\n\r\n');
    expect(out.events).toHaveLength(1);
    expect(out.events[0].type).toBe("done");
  });
});

describe("parseCheckEventLine", () => {
  it("ignores unknown event types, malformed JSON and invalid shapes", () => {
    expect(parseCheckEventLine('{"type":"telemetry","x":1}')).toBeNull();
    expect(parseCheckEventLine("{not json")).toBeNull();
    expect(parseCheckEventLine("[1,2,3]")).toBeNull();
    expect(parseCheckEventLine('{"type":"progress","step":"teleport","message":"?"}')).toBeNull();
    expect(parseCheckEventLine('{"type":"hospital","result":{"hospital":{}}}')).toBeNull();
    expect(parseCheckEventLine("   ")).toBeNull();
  });

  it("maps an unknown error code to INTERNAL", () => {
    expect(parseCheckEventLine('{"type":"error","code":"WAT","message":"boom"}')).toEqual({
      type: "error",
      code: "INTERNAL",
      message: "boom",
    });
  });

  it("drops malformed hospitals but keeps the event", () => {
    const ev = parseCheckEventLine(
      JSON.stringify({ type: "hospitals", hospitals: [hospital("a"), { name: "no id" }], source: "snapshot", fetchedAt: "x" }),
    );
    expect(ev?.type).toBe("hospitals");
    expect(ev && ev.type === "hospitals" ? ev.hospitals.map((h) => h.dataId) : []).toEqual(["a"]);
  });
});

// ---------- reducer ----------

describe("checkStreamReducer", () => {
  it("unknown events never reach the reducer and leave state unchanged", () => {
    const before = run([]);
    const { events } = parseNdjsonChunk("", line({ type: "mystery", payload: 1 }));
    expect(events).toEqual([]);
    // Even if one slipped through, the reducer ignores it.
    const forged = { type: "mystery" } as unknown as CheckEvent;
    expect(checkStreamReducer(before, { type: "event", event: forged })).toBe(before);
  });

  it("tracks progress and completes earlier steps", () => {
    const s = run([
      { type: "progress", step: "maps", message: "Maps" },
      { type: "progress", step: "reviews", message: "Reviews", done: 3, total: 8 },
    ]);
    expect(s.progress.maps.state).toBe("complete");
    expect(s.progress.reviews).toMatchObject({ state: "active", done: 3, total: 8 });
    expect(s.progress.classify.state).toBe("pending");
  });

  it("keeps reviews active while classification overlaps it", () => {
    const s = run([
      { type: "progress", step: "reviews", message: "Reviews 1", done: 1, total: 8 },
      { type: "progress", step: "classify", message: "Classified 1", done: 1, total: 8 },
    ]);
    expect(s.progress.reviews.state).toBe("active");
    expect(s.progress.classify.state).toBe("active");
    expect(s.lastMessage).toBe("Classified 1");

    const scored = run([{ type: "progress", step: "score", message: "Scoring" }], s);
    expect(scored.progress.reviews.state).toBe("complete");
    expect(scored.progress.classify.state).toBe("complete");
  });

  it("collects hospitals and results as they arrive", () => {
    const s = run([
      { type: "hospitals", hospitals: [hospital("a"), hospital("b")], source: "snapshot", fetchedAt: "2026-10-05T08:40:00Z" },
      { type: "hospital", result: result("a", { n: 4 }) },
      { type: "hospital", result: result("c", { n: 1 }) },
    ]);
    expect(s.hospitalsSource).toBe("snapshot");
    expect(s.progress.maps.state).toBe("complete");
    expect([...s.results.keys()]).toEqual(["a", "c"]);
    // An unexpected hospital is appended to the list rather than lost.
    expect(s.hospitals.map((h) => h.dataId)).toEqual(["a", "b", "c"]);
  });

  it("baseline merges final scores into existing results", () => {
    const s = run([
      { type: "hospital", result: result("a", { n: 9, ayushmanRating: 2.0 }) },
      { type: "hospital", result: result("b", { n: 6, ayushmanRating: 4.0 }) },
      {
        type: "baseline",
        baseline: { medianAyushmanRating: 3.3, hospitalsWithRating: 5, hospitalsConsidered: 8 },
        scores: [
          score("a", { n: 9, ayushmanRating: 2.0, deltaVsCityMedian: -1.3 }),
          score("b", { n: 6, ayushmanRating: 4.0, deltaVsCityMedian: 0.7 }),
          score("zzz", { n: 1 }), // no matching card — ignored
        ],
      },
    ]);
    expect(s.baseline?.medianAyushmanRating).toBe(3.3);
    expect(s.results.get("a")?.score.deltaVsCityMedian).toBe(-1.3);
    expect(s.results.get("b")?.score.deltaVsCityMedian).toBe(0.7);
    expect(s.results.get("a")?.hospital.name).toBe("Hospital a");
    expect(s.results.has("zzz")).toBe(false);
    expect(s.scores).toHaveLength(3);
    expect(s.progress.score.state).toBe("complete");
  });

  it("done marks the run complete and skips steps that never ran", () => {
    const s = run([
      { type: "progress", step: "score", message: "Scoring" },
      { type: "done", creditsUsed: 0, source: "snapshot", oldestFetchedAt: "2026-10-05T08:40:00Z", durationMs: 1200 },
    ]);
    expect(s.status).toBe("done");
    expect(s.done?.creditsUsed).toBe(0);
    expect(s.progress.score.state).toBe("complete");
    expect(s.progress.news.state).toBe("skipped");
  });

  it("an error event moves to the error state and keeps partial results", () => {
    const s = run([
      { type: "progress", step: "reviews", message: "Reviews", done: 2, total: 8 },
      { type: "hospital", result: result("a", { n: 3 }) },
      { type: "error", code: "UPSTREAM", message: "SerpApi timed out" },
    ]);
    expect(s.status).toBe("error");
    expect(s.error).toEqual({ code: "UPSTREAM", message: "SerpApi timed out" });
    expect(s.progress.reviews.state).toBe("error");
    expect(s.results.size).toBe(1);
  });

  it("start resets everything", () => {
    const dirty = run([{ type: "hospital", result: result("a") }]);
    const fresh = checkStreamReducer(dirty, { type: "start" });
    expect(fresh.status).toBe("running");
    expect(fresh.results.size).toBe(0);
  });

  it("a late baseline does not overwrite a card refreshed live before it arrived", () => {
    const s0 = run([{ type: "hospital", result: result("a", { n: 3 }) }]);
    const refreshed: HospitalResult = {
      ...result("a", { n: 5 }),
      mentions: [mention("r1", "CASHLESS_OK", "2026-09-01T00:00:00Z")],
      source: "live",
    };
    const s1 = checkStreamReducer(s0, { type: "replaceResult", result: refreshed, creditsUsed: 1, at: "2026-10-05T09:00:00Z" });
    const s2 = run(
      [
        {
          type: "baseline",
          baseline: { medianAyushmanRating: 3.3, hospitalsWithRating: 1, hospitalsConsidered: 1 },
          scores: [score("a", { n: 3, deltaVsCityMedian: -1 })],
        },
      ],
      s1,
    );
    expect(s2.results.get("a")?.score.n).toBe(5);
    expect(s2.results.get("a")?.mentions.map((m) => m.reviewId)).toEqual(["r1"]);
    expect(s2.baseline?.medianAyushmanRating).toBe(3.3);
  });

  it("replaceResult swaps one card and adds refresh credits", () => {
    const s0 = run([{ type: "hospital", result: result("a", { n: 3 }) }]);
    const refreshed: HospitalResult = { ...result("a", { n: 5 }), source: "live" };
    const s1 = checkStreamReducer(s0, { type: "replaceResult", result: refreshed, creditsUsed: 1, at: "2026-10-05T09:00:00Z" });
    expect(s1.results.get("a")?.score.n).toBe(5);
    expect(s1.results.get("a")?.source).toBe("live");
    expect(s1.refreshedAt.a).toBe("2026-10-05T09:00:00Z");
    expect(s1.refreshCredits).toBe(1);
  });
});

describe("errorFromHttp", () => {
  it("uses the server's code and message when valid", () => {
    expect(errorFromHttp(429, { code: "RATE_LIMITED", message: "Slow down" })).toEqual({
      code: "RATE_LIMITED",
      message: "Slow down",
      httpStatus: 429,
    });
  });

  it("falls back by status for unexpected bodies", () => {
    expect(errorFromHttp(400, null).code).toBe("INVALID_INPUT");
    expect(errorFromHttp(429, "nope").code).toBe("RATE_LIMITED");
    expect(errorFromHttp(503, { code: "???" }).code).toBe("INTERNAL");
  });
});

// ---------- display helpers used on streamed results ----------

// The ordering rules themselves are tested with sortForDisplay in scoring.test.ts.
describe("orderResults", () => {
  const rs = [
    result("a", { n: 3, problemCount: 0, cashlessOkCount: 3 }, "Alpha"),
    result("b", { n: 9, problemCount: 4, cashlessOkCount: 3 }, "Beta"),
    result("c", { n: 5, problemCount: 5, cashlessOkCount: 0 }, "Gamma"),
  ];
  const listed = ["c", "b", "a"].map((id) => hospital(id));

  it("applies the scoring sort modes without mutating input", () => {
    expect(orderResults(rs, listed, "evidence").map((r) => r.hospital.dataId)).toEqual(["b", "c", "a"]);
    expect(orderResults(rs, listed, "problems").map((r) => r.hospital.dataId)).toEqual(["c", "b", "a"]);
    expect(orderResults(rs, listed, "cashless").map((r) => r.hospital.dataId)).toEqual(["a", "b", "c"]);
    expect(rs.map((r) => r.hospital.dataId)).toEqual(["a", "b", "c"]);
  });

  it("breaks ties by hospital list order, not arrival order", () => {
    const tied = ["x", "y", "z"].map((id) => result(id, { n: 4 }));
    const order = [hospital("z"), hospital("x"), hospital("y")];
    expect(orderResults(tied, order, "evidence").map((r) => r.hospital.dataId)).toEqual(["z", "x", "y"]);
    expect(orderResults([...tied].reverse(), order, "evidence").map((r) => r.hospital.dataId)).toEqual(["z", "x", "y"]);
  });
});

describe("pickTopQuotes", () => {
  it("prefers problem reports but always keeps a cashless report when one exists", () => {
    const ms = [
      mention("1", "REFUSED", "2026-09-01T00:00:00Z"),
      mention("2", "CHARGED_FOR_PACKAGE_ITEMS", "2026-08-01T00:00:00Z"),
      mention("3", "CHARGED_FOR_PACKAGE_ITEMS", "2026-07-01T00:00:00Z"),
      mention("4", "CASHLESS_OK", "2026-01-01T00:00:00Z"),
      mention("5", "NOT_PMJAY", "2026-09-15T00:00:00Z"),
      mention("6", "REFUSED", "2022-01-01T00:00:00Z"), // outside the 24-month window
    ];
    const top = pickTopQuotes(ms, "2026-10-05T08:40:00Z").map((m) => m.reviewId);
    expect(top).toEqual(["1", "2", "4"]);
  });
});

describe("classifier badges", () => {
  const llm = (id: string, cls: EvidenceClass) => mention(id, cls, "2026-09-01T00:00:00Z");
  const rules = (id: string, cls: EvidenceClass) => ({ ...llm(id, cls), classifier: "rules" as const });

  it("ignores deterministic pre-rule mentions when the AI classified the rest", () => {
    expect(classifierOf([llm("1", "CASHLESS_OK"), rules("2", "NAME_COLLISION"), rules("3", "NOT_PMJAY")], true)).toBe("llm");
    expect(classifierOf([llm("1", "CASHLESS_OK"), rules("2", "REFUSED")], true)).toBe("rules");
    expect(classifierOf([rules("1", "NAME_COLLISION")], false)).toBe("rules");
    expect(classifierOf([rules("1", "NAME_COLLISION")], true)).toBe("llm");
  });

  it("labels the run from the results, so committed AI classifications show as AI without a key", () => {
    const fromFiles = [{ mentions: [llm("1", "REFUSED")] }, { mentions: [rules("2", "NOT_PMJAY")] }];
    expect(runClassifierOf(fromFiles, false)).toBe("llm");
    expect(runClassifierOf([{ mentions: [rules("1", "DELAY")] }], true)).toBe("rules");
    expect(runClassifierOf([], false)).toBe("rules");
    expect(runClassifierOf([], undefined)).toBeUndefined();
  });
});

describe("format helpers", () => {
  it("formats IST deterministically", () => {
    expect(formatIst("2026-10-05T08:40:00Z")).toBe("05 Oct 2026, 14:10 IST");
    expect(formatIst("not a date")).toBe("");
  });

  it("describes ages approximately", () => {
    const now = Date.parse("2026-10-05T00:00:00Z");
    expect(approxAge("2026-06-05T00:00:00Z", now)).toBe("about 4 months ago");
    expect(approxAge("2024-10-01T00:00:00Z", now)).toBe("about 2 years ago");
    expect(approxAge(undefined, now)).toBeNull();
  });

  it("states deltas neutrally", () => {
    expect(describeDelta(-1.3)).toBe("1.3★ below city median");
    expect(describeDelta(0.4)).toBe("0.4★ above city median");
  });

  it("takes the delta from the ratings as displayed, so the on-screen subtraction checks out", () => {
    // 4.43 vs 3.165 is shown as 4.4★ vs 3.2★, so the delta must read 1.2, not 1.3.
    expect(describeDelta(displayedDelta(4.43, 3.165))).toBe("1.2★ above city median");
    expect(describeDelta(displayedDelta(3.33, 3.165))).toBe("0.1★ above city median");
    expect(describeDelta(displayedDelta(2.0, 3.165))).toBe("1.2★ below city median");
    expect(describeDelta(displayedDelta(3.22, 3.165))).toBe("about the same as the city median");
    expect(displayedDelta(4.4, 3.2)).toBe(1.2); // no float noise
    // One rounding rule everywhere: half away from zero, despite binary float error.
    expect(formatStars(1.15)).toBe("1.2★");
    expect(formatStars(3.15)).toBe("3.2★");
    expect(formatStars(3.165)).toBe("3.2★");
    expect(formatStars(-0.04)).toBe("0.0★");
  });

  it("dates headlines from iso_date in IST, falling back to SerpApi's raw string", () => {
    const raw = "09/30/2026, 07:00 AM, +0000 UTC";
    expect(newsDateText({ isoDate: "2026-09-30T05:02:24Z", dateText: raw })).toBe("Sep 2026");
    expect(newsDateText({ isoDate: "2026-09-30T20:00:00Z" })).toBe("Oct 2026"); // already 1 Oct in IST
    expect(newsDateText({ dateText: raw })).toBe(raw);
    expect(newsDateText({ isoDate: "nope" })).toBe("");
  });

  it("only allows http(s) links", () => {
    expect(safeExternalUrl("javascript:alert(1)")).toBeNull();
    expect(safeExternalUrl("https://maps.google.com/?cid=1")).toBe("https://maps.google.com/?cid=1");
  });

  it("matches the scoring window: undated counts, 731 days before the run does not", () => {
    const ref = "2026-10-05T00:00:00Z";
    expect(isOutsideWindow({ isoDate: undefined }, ref)).toBe(false);
    expect(isOutsideWindow({ isoDate: "2024-10-05T00:00:00Z" }, ref)).toBe(false); // exactly 730 days
    expect(isOutsideWindow({ isoDate: "2024-10-04T00:00:00Z" }, ref)).toBe(true);
  });

  it("uses the relative date like the server does when the ISO date is missing", () => {
    const ref = "2026-10-05T00:00:00Z";
    expect(isOutsideWindow({ relativeDate: "4 years ago" }, ref)).toBe(true);
    expect(isOutsideWindow({ relativeDate: "3 months ago" }, ref)).toBe(false);
    expect(isOutsideWindow({ relativeDate: "कुछ समय पहले" }, ref)).toBe(false); // unknown: kept, like n
    // A parseable ISO date wins over the relative label.
    expect(isOutsideWindow({ isoDate: "2026-09-01T00:00:00Z", relativeDate: "4 years ago" }, ref)).toBe(false);
  });

  it("builds a WhatsApp summary with n and the page URL", () => {
    const text = buildWhatsAppSummary({
      heading: "Lucknow · Any treatment",
      results: [
        result("a", { n: 9, problemCount: 4, cashlessOkCount: 3, ayushmanRating: 2, overallRating: 4.6 }, "Alpha"),
        result("b", { n: 2 }, "Beta"),
      ],
      sourceLine: "Snapshot fetched 05 Oct 2026, 14:10 IST · 0 searches used",
      url: "https://example.test/check?city=lucknow&treatment=general",
    });
    expect(text).toContain("1. Alpha: 9 reports — 3 cashless, 4 asked to pay or turned away.");
    expect(text).toContain("2.0★ vs overall 4.6★");
    expect(text).toContain("2. Beta: 2 reports — too few to compare.");
    expect(text).toContain("14555");
    expect(text).toContain(RESULTS_CAVEAT);
    expect(text).not.toContain("more hospital");
    expect(text.trim().endsWith("https://example.test/check?city=lucknow&treatment=general")).toBe(true);
  });

  it("shares in evidence order whatever the on-screen sort, and counts hospitals it leaves out", () => {
    const rs = [
      result("a", { n: 9, problemCount: 1, cashlessOkCount: 6 }, "Alpha"),
      result("b", { n: 8, problemCount: 6, cashlessOkCount: 1 }, "Beta"),
      result("c", { n: 7, problemCount: 5, cashlessOkCount: 0 }, "Gamma"),
      result("d", { n: 6, problemCount: 0, cashlessOkCount: 4 }, "Delta"),
      result("e", { n: 5, problemCount: 2, cashlessOkCount: 2 }, "Epsilon"),
      result("f", { n: 4, problemCount: 3, cashlessOkCount: 0 }, "Zeta"),
      result("g", { n: 0 }, "Eta"),
    ];
    const listed = rs.map((r) => r.hospital);
    const build = (results: HospitalResult[], limit?: number) =>
      buildWhatsAppSummary({ heading: "Lucknow · Any treatment", results, sourceLine: "Snapshot", url: "https://example.test/", limit });

    const byProblems = build(orderResults(rs, listed, "problems"), 5);
    expect(byProblems).toBe(build(orderResults(rs, listed, "evidence"), 5));
    expect(byProblems).toContain("1. Alpha:");
    expect(byProblems).toContain("5. Epsilon:");
    expect(byProblems).not.toContain("Zeta");
    // Zeta (cut by the limit) and Eta (no reports) are counted, not silently dropped.
    expect(byProblems).toContain("+ 2 more hospitals compared — see link below.");

    // By default every compared hospital with reports is listed.
    const all = build(rs);
    expect(all).toContain("6. Zeta:");
    expect(all).toContain("+ 1 more hospital compared — see link below.");
  });
});

describe("show-all list vs n", () => {
  it("splits uncounted reviews into not-about-the-scheme and older than the window", () => {
    const ms = [
      mention("1", "REFUSED", "2026-09-01T00:00:00Z"),
      mention("2", "NOT_PMJAY", "2026-09-01T00:00:00Z"),
      mention("3", "NAME_COLLISION", "2020-01-01T00:00:00Z"), // excluded wins over older
      mention("4", "CASHLESS_OK", "2022-01-01T00:00:00Z"),
      mention("5", "MENTION_ONLY", "2026-01-01T00:00:00Z"),
    ];
    expect(uncountedMentions(ms, "2026-10-05T00:00:00Z")).toEqual({ notAboutScheme: 2, older: 1 });
  });

  it("counts an undated review as older from its relative date, as the server does", () => {
    const undated = (id: string, relativeDate: string): ClassifiedMention => ({
      ...mention(id, "REFUSED", ""),
      isoDate: undefined,
      relativeDate,
    });
    const ms = [undated("1", "5 years ago"), undated("2", "a month ago"), undated("3", "kal")];
    expect(uncountedMentions(ms, "2026-10-05T00:00:00Z")).toEqual({ notAboutScheme: 0, older: 1 });
  });
});
