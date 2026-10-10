import { describe, expect, it } from "vitest";
import { TREATMENTS } from "@/config/presets";
import {
  MIN_N_FOR_LABEL,
  MIN_N_FOR_RATING,
  WINDOW_DAYS,
  applyBaseline,
  computeBaseline,
  evidenceSummary,
  isInWindow,
  scoreHospital,
  sortForDisplay,
} from "@/lib/scoring/score";
import {
  EVIDENCE_CLASSES,
  type ClassifiedMention,
  type EvidenceClass,
  type Hospital,
  type HospitalResult,
  type HospitalScore,
} from "@/types/domain";

// ---------- fixtures ----------

const NOW = new Date("2026-10-04T12:00:00Z");
const DAY_MS = 86_400_000;
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY_MS).toISOString();

const GENERAL = TREATMENTS.general;
const DIALYSIS = TREATMENTS.dialysis;

function hospital(overrides: Partial<Hospital> = {}): Hospital {
  return {
    dataId: "0xabc:0x123",
    name: "City Care Hospital",
    rating: 4.6,
    reviewCount: 2341,
    types: ["Hospital"],
    isGovernment: false,
    nameCollision: false,
    ...overrides,
  };
}

let seq = 0;
function mention(cls: EvidenceClass, overrides: Partial<ClassifiedMention> = {}): ClassifiedMention {
  seq += 1;
  return {
    reviewId: `r${seq}`,
    hospitalDataId: "0xabc:0x123",
    cls,
    sentenceIds: [0],
    quote: "quote",
    amountInr: null,
    treatmentMentioned: null,
    isoDate: daysAgo(30),
    classifier: "llm",
    ...overrides,
  };
}

/** n mentions of one class (all dated 30 days ago unless overridden). */
const many = (count: number, cls: EvidenceClass, overrides: Partial<ClassifiedMention> = {}) =>
  Array.from({ length: count }, () => mention(cls, overrides));

const score = (mentions: ClassifiedMention[], h: Hospital = hospital(), t = GENERAL) =>
  scoreHospital(h, mentions, t, NOW);

/** A minimal HospitalScore for baseline / sort / summary tests. */
function fakeScore(overrides: Partial<HospitalScore> = {}): HospitalScore {
  const counts = Object.fromEntries(EVIDENCE_CLASSES.map((c) => [c, 0])) as Record<EvidenceClass, number>;
  return {
    dataId: "h",
    n: 0,
    counts,
    problemCount: 0,
    cashlessOkCount: 0,
    ayushmanRating: null,
    overallRating: null,
    deltaVsCityMedian: null,
    label: "too_few_reports",
    treatmentMentions: { k: 0, n: 0 },
    latestReportIso: null,
    amountsInr: [],
    ...overrides,
  };
}

function result(id: string, s: Partial<HospitalScore>, reviewCount?: number): HospitalResult {
  return {
    hospital: hospital({ dataId: id, name: id, reviewCount }),
    mentions: [],
    score: fakeScore({ dataId: id, ...s }),
    reviewsFetchedAt: NOW.toISOString(),
    source: "snapshot",
  };
}
const ids = (rs: HospitalResult[]) => rs.map((r) => r.hospital.dataId);

// ---------- constants ----------

describe("constants", () => {
  it("match the documented thresholds", () => {
    expect(WINDOW_DAYS).toBe(730);
    expect(MIN_N_FOR_LABEL).toBe(3);
    expect(MIN_N_FOR_RATING).toBe(5);
  });
});

// ---------- isInWindow ----------

describe("isInWindow", () => {
  it("accepts a recent mention", () => {
    expect(isInWindow(mention("CASHLESS_OK", { isoDate: daysAgo(10) }), NOW)).toBe(true);
  });

  it("is inclusive at exactly WINDOW_DAYS and excludes one day more", () => {
    expect(isInWindow(mention("CASHLESS_OK", { isoDate: daysAgo(730) }), NOW)).toBe(true);
    expect(isInWindow(mention("CASHLESS_OK", { isoDate: daysAgo(731) }), NOW)).toBe(false);
  });

  it("treats undated and unparseable dates as in-window", () => {
    expect(isInWindow(mention("CASHLESS_OK", { isoDate: undefined }), NOW)).toBe(true);
    expect(isInWindow(mention("CASHLESS_OK", { isoDate: "" }), NOW)).toBe(true);
    expect(isInWindow(mention("CASHLESS_OK", { isoDate: "not a date" }), NOW)).toBe(true);
  });

  it("treats future dates (clock skew) as in-window", () => {
    expect(isInWindow(mention("CASHLESS_OK", { isoDate: daysAgo(-3) }), NOW)).toBe(true);
  });

  it("falls back to the relative date when isoDate is missing or unparseable", () => {
    const rel = (relativeDate: string, isoDate?: string) =>
      isInWindow(mention("CASHLESS_OK", { isoDate, relativeDate }), NOW);
    expect(rel("4 years ago")).toBe(false);
    expect(rel("3 years ago", "not a date")).toBe(false);
    expect(rel("a year ago")).toBe(true);
    expect(rel("3 months ago")).toBe(true);
    expect(rel("Edited 2 weeks ago")).toBe(true);
    expect(rel("2 years ago")).toBe(true); // floored label: lenient at the boundary
  });

  it("keeps a mention whose relative date is not understood", () => {
    expect(isInWindow(mention("CASHLESS_OK", { isoDate: undefined, relativeDate: "gibberish" }), NOW)).toBe(true);
    expect(isInWindow(mention("CASHLESS_OK", { isoDate: undefined, relativeDate: "2 साल पहले" }), NOW)).toBe(true);
  });

  it("lets a parseable isoDate win over a conflicting relative date", () => {
    expect(isInWindow(mention("CASHLESS_OK", { isoDate: daysAgo(10), relativeDate: "5 years ago" }), NOW)).toBe(true);
    expect(isInWindow(mention("CASHLESS_OK", { isoDate: daysAgo(900), relativeDate: "a week ago" }), NOW)).toBe(false);
  });
});

// ---------- scoreHospital: basics ----------

describe("scoreHospital — empty and excluded input", () => {
  it("returns a zeroed score for no mentions", () => {
    const s = score([]);
    expect(s).toEqual({
      dataId: "0xabc:0x123",
      n: 0,
      counts: fakeScore().counts,
      problemCount: 0,
      cashlessOkCount: 0,
      ayushmanRating: null,
      overallRating: 4.6,
      deltaVsCityMedian: null,
      label: "too_few_reports",
      treatmentMentions: { k: 0, n: 0 },
      latestReportIso: null,
      amountsInr: [],
    });
    expect(Object.keys(s.counts).sort()).toEqual([...EVIDENCE_CLASSES].sort());
  });

  it("uses null for a hospital without an overall rating", () => {
    expect(score([], hospital({ rating: undefined })).overallRating).toBeNull();
  });

  it("counts excluded classes but keeps them out of n", () => {
    const s = score([
      ...many(4, "NOT_PMJAY", { rating: 5, amountInr: 500 }),
      ...many(2, "NAME_COLLISION", { rating: 5 }),
    ]);
    expect(s.n).toBe(0);
    expect(s.counts.NOT_PMJAY).toBe(4);
    expect(s.counts.NAME_COLLISION).toBe(2);
    expect(s.label).toBe("too_few_reports");
    expect(s.ayushmanRating).toBeNull();
    expect(s.latestReportIso).toBeNull();
    expect(s.amountsInr).toEqual([]);
  });

  it("n equals the sum of non-excluded counts", () => {
    const s = score([
      mention("CASHLESS_OK"),
      mention("REFUSED"),
      mention("DELAY"),
      mention("MENTION_ONLY"),
      mention("NOT_PMJAY"),
    ]);
    const nonExcluded = EVIDENCE_CLASSES.filter((c) => c !== "NOT_PMJAY" && c !== "NAME_COLLISION");
    expect(s.n).toBe(4);
    expect(nonExcluded.reduce((sum, c) => sum + s.counts[c], 0)).toBe(s.n);
  });
});

describe("scoreHospital — window", () => {
  it("ignores mentions older than the window everywhere", () => {
    const old = { isoDate: daysAgo(800), rating: 1, amountInr: 9999, treatmentMentioned: true };
    const s = score([...many(5, "REFUSED", old), mention("CASHLESS_OK")], hospital(), DIALYSIS);
    expect(s.n).toBe(1);
    expect(s.counts.REFUSED).toBe(0);
    expect(s.problemCount).toBe(0);
    expect(s.amountsInr).toEqual([]);
    expect(s.treatmentMentions).toEqual({ k: 0, n: 1 });
    expect(s.latestReportIso).toBe(daysAgo(30));
  });

  it("counts undated mentions in n", () => {
    const s = score(many(3, "CASHLESS_OK", { isoDate: undefined }));
    expect(s.n).toBe(3);
    expect(s.label).toBe("more_cashless_reports");
    expect(s.latestReportIso).toBeNull();
  });

  it("drops undated mentions whose relative date is outside the window", () => {
    const s = score([
      ...many(3, "REFUSED", { isoDate: undefined, relativeDate: "5 years ago", amountInr: 9000 }),
      mention("CASHLESS_OK", { isoDate: undefined, relativeDate: "a month ago" }),
    ]);
    expect(s.n).toBe(1);
    expect(s.counts.REFUSED).toBe(0);
    expect(s.amountsInr).toEqual([]);
  });
});

describe("scoreHospital — problem and cashless counts", () => {
  it("problems are CHARGED_FOR_PACKAGE_ITEMS + REFUSED only", () => {
    const s = score([
      mention("CHARGED_FOR_PACKAGE_ITEMS"),
      mention("REFUSED"),
      mention("REFUSED"),
      mention("CHARGED_OUTSIDE_PACKAGE_OR_UNCLEAR"),
      mention("ELIGIBILITY_OR_SPECIALTY_DISPUTE"),
      mention("DELAY"),
      mention("CASHLESS_OK"),
    ]);
    expect(s.problemCount).toBe(3);
    expect(s.cashlessOkCount).toBe(1);
    expect(s.n).toBe(7);
  });
});

// ---------- label ----------

describe("scoreHospital — label", () => {
  const labelOf = (problem: number, cashless: number, other = 0) =>
    score([
      ...many(problem, "REFUSED"),
      ...many(cashless, "CASHLESS_OK"),
      ...many(other, "MENTION_ONLY"),
    ]).label;

  it("is too_few_reports below n=3, even when one-sided", () => {
    expect(labelOf(2, 0)).toBe("too_few_reports");
    expect(labelOf(0, 2)).toBe("too_few_reports");
  });

  it("applies from exactly n=3", () => {
    expect(labelOf(2, 0, 1)).toBe("more_problem_reports");
    expect(labelOf(0, 2, 1)).toBe("more_cashless_reports");
  });

  it("needs at least 2 reports on the winning side", () => {
    expect(labelOf(1, 0, 2)).toBe("mixed_reports");
    expect(labelOf(0, 1, 2)).toBe("mixed_reports");
  });

  it("requires strictly more than 1.5× the other side (ties are mixed)", () => {
    expect(labelOf(3, 2)).toBe("mixed_reports"); // 3 = 1.5 × 2
    expect(labelOf(2, 3)).toBe("mixed_reports"); // 3 = 1.5 × 2
    expect(labelOf(4, 2)).toBe("more_problem_reports"); // 4 > 3
    expect(labelOf(2, 4)).toBe("more_cashless_reports");
    expect(labelOf(2, 1)).toBe("more_problem_reports"); // 2 > 1.5
    expect(labelOf(1, 2)).toBe("more_cashless_reports");
  });

  it("is mixed when sides are equal or nothing is decisive", () => {
    expect(labelOf(2, 2)).toBe("mixed_reports");
    expect(labelOf(0, 0, 5)).toBe("mixed_reports");
  });

  it("does not let excluded classes lift n over the threshold", () => {
    const s = score([...many(2, "REFUSED"), ...many(3, "NOT_PMJAY")]);
    expect(s.n).toBe(2);
    expect(s.label).toBe("too_few_reports");
  });
});

// ---------- rating split ----------

describe("scoreHospital — ayushmanRating", () => {
  const rated = (ratings: number[], cls: EvidenceClass = "MENTION_ONLY") =>
    ratings.map((rating) => mention(cls, { rating }));

  it("is null at n=4 even when every mention is rated", () => {
    expect(score(rated([1, 2, 3, 4])).ayushmanRating).toBeNull();
  });

  it("is the mean at exactly n=5 with 5 ratings", () => {
    expect(score(rated([1, 2, 2, 3, 3])).ayushmanRating).toBe(2.2);
  });

  it("rounds to 2 decimals", () => {
    expect(score(rated([5, 5, 5, 5, 4, 1])).ayushmanRating).toBe(4.17); // 25/6
    expect(score(rated([1, 1, 1, 2, 2, 4])).ayushmanRating).toBe(1.83); // 11/6
  });

  it("is null when n ≥ 5 but fewer than 5 mentions are rated", () => {
    const s = score([...rated([1, 2, 3, 4]), mention("MENTION_ONLY"), mention("DELAY")]);
    expect(s.n).toBe(6);
    expect(s.ayushmanRating).toBeNull();
  });

  it("averages only the rated qualifying mentions", () => {
    const s = score([...rated([2, 2, 2, 2, 2]), mention("MENTION_ONLY")]);
    expect(s.n).toBe(6);
    expect(s.ayushmanRating).toBe(2);
  });

  it("ignores ratings on excluded and out-of-window mentions", () => {
    const s = score([
      ...rated([1, 1, 1, 1, 1]),
      ...rated([5, 5, 5], "NOT_PMJAY"),
      mention("CASHLESS_OK", { rating: 5, isoDate: daysAgo(900) }),
    ]);
    expect(s.ayushmanRating).toBe(1);
  });

  it("does not let excluded rated mentions satisfy the minimum", () => {
    const s = score([...rated([3, 3, 3, 3]), ...rated([3], "NAME_COLLISION")]);
    expect(s.ayushmanRating).toBeNull();
  });
});

// ---------- treatment, latest date, amounts ----------

describe("scoreHospital — treatmentMentions", () => {
  const ms = () => [
    mention("CASHLESS_OK", { treatmentMentioned: true }),
    mention("REFUSED", { treatmentMentioned: true }),
    mention("DELAY", { treatmentMentioned: false }),
    mention("MENTION_ONLY", { treatmentMentioned: null }),
    mention("NOT_PMJAY", { treatmentMentioned: true }),
  ];

  it("counts qualifying mentions with treatmentMentioned === true", () => {
    expect(score(ms(), hospital(), DIALYSIS).treatmentMentions).toEqual({ k: 2, n: 4 });
  });

  it("is always k = 0 for the general treatment", () => {
    expect(score(ms(), hospital(), GENERAL).treatmentMentions).toEqual({ k: 0, n: 4 });
  });
});

describe("scoreHospital — latestReportIso", () => {
  it("is the newest qualifying date, as the original string", () => {
    const s = score([
      mention("CASHLESS_OK", { isoDate: "2026-01-15T10:00:00Z" }),
      mention("REFUSED", { isoDate: "2026-09-01T08:30:00.000Z" }),
      mention("DELAY", { isoDate: undefined }),
      mention("NOT_PMJAY", { isoDate: "2026-10-01T00:00:00Z" }), // excluded
    ]);
    expect(s.latestReportIso).toBe("2026-09-01T08:30:00.000Z");
  });
});

describe("scoreHospital — amountsInr", () => {
  it("collects non-null problem amounts in ascending order", () => {
    const s = score([
      mention("REFUSED", { amountInr: 15000 }),
      mention("CHARGED_FOR_PACKAGE_ITEMS", { amountInr: 2000 }),
      mention("CHARGED_FOR_PACKAGE_ITEMS", { amountInr: null }),
      mention("CHARGED_FOR_PACKAGE_ITEMS", { amountInr: 8000 }),
      mention("CHARGED_OUTSIDE_PACKAGE_OR_UNCLEAR", { amountInr: 500 }), // not a problem class
      mention("NOT_PMJAY", { amountInr: 100 }), // excluded
      mention("REFUSED", { amountInr: 50000, isoDate: daysAgo(1000) }), // out of window
    ]);
    expect(s.amountsInr).toEqual([2000, 8000, 15000]);
  });
});

// ---------- baseline ----------

describe("computeBaseline", () => {
  it("is null for no scores", () => {
    expect(computeBaseline([])).toEqual({
      medianAyushmanRating: null,
      hospitalsWithRating: 0,
      hospitalsConsidered: 0,
    });
  });

  it("is null when no hospital has a rating split", () => {
    expect(computeBaseline([fakeScore(), fakeScore(), fakeScore()])).toEqual({
      medianAyushmanRating: null,
      hospitalsWithRating: 0,
      hospitalsConsidered: 3,
    });
  });

  it("takes the middle value for an odd count, ignoring nulls and input order", () => {
    const b = computeBaseline([
      fakeScore({ ayushmanRating: 4.5 }),
      fakeScore(),
      fakeScore({ ayushmanRating: 2 }),
      fakeScore({ ayushmanRating: 3.1 }),
    ]);
    expect(b).toEqual({ medianAyushmanRating: 3.1, hospitalsWithRating: 3, hospitalsConsidered: 4 });
  });

  it("averages the two middle values for an even count", () => {
    const b = computeBaseline([5, 2, 4, 3].map((r) => fakeScore({ ayushmanRating: r })));
    expect(b.medianAyushmanRating).toBe(3.5);
    expect(b.hospitalsWithRating).toBe(4);
  });

  it("keeps the third decimal of an even-count median without float noise", () => {
    const b = computeBaseline([fakeScore({ ayushmanRating: 3.33 }), fakeScore({ ayushmanRating: 3.34 })]);
    expect(b.medianAyushmanRating).toBe(3.335);
  });

  it("handles a single rated hospital", () => {
    expect(computeBaseline([fakeScore({ ayushmanRating: 2.75 })]).medianAyushmanRating).toBe(2.75);
  });
});

describe("applyBaseline", () => {
  const baseline = (median: number | null) => ({
    medianAyushmanRating: median,
    hospitalsWithRating: median === null ? 0 : 3,
    hospitalsConsidered: 3,
  });

  it("sets delta = rating − median, rounded to 2 decimals", () => {
    const [a, b] = applyBaseline(
      [fakeScore({ ayushmanRating: 2 }), fakeScore({ ayushmanRating: 4.17 })],
      baseline(3.3),
    );
    expect(a.deltaVsCityMedian).toBe(-1.3);
    expect(b.deltaVsCityMedian).toBe(0.87); // 0.8699999… in floats
  });

  it("rounds half-way deltas away from zero, symmetrically", () => {
    const [lo, hi] = applyBaseline(
      [fakeScore({ ayushmanRating: 3.33 }), fakeScore({ ayushmanRating: 3.34 })],
      baseline(3.335),
    );
    expect(lo.deltaVsCityMedian).toBe(-0.01);
    expect(hi.deltaVsCityMedian).toBe(0.01);
  });

  it("gives 0 (not -0) when the rating equals the median", () => {
    const [s] = applyBaseline([fakeScore({ ayushmanRating: 3.3 })], baseline(3.3));
    expect(Object.is(s.deltaVsCityMedian, 0)).toBe(true);
  });

  it("is null when the hospital has no rating split or the city has no median", () => {
    expect(applyBaseline([fakeScore()], baseline(3))[0].deltaVsCityMedian).toBeNull();
    const stale = fakeScore({ ayushmanRating: 4, deltaVsCityMedian: 1 });
    expect(applyBaseline([stale], baseline(null))[0].deltaVsCityMedian).toBeNull();
  });

  it("returns new objects and leaves the input untouched", () => {
    const input = [fakeScore({ ayushmanRating: 4 })];
    const out = applyBaseline(input, baseline(3));
    expect(out[0]).not.toBe(input[0]);
    expect(input[0].deltaVsCityMedian).toBeNull();
    expect(out[0]).toEqual({ ...input[0], deltaVsCityMedian: 1 });
  });

  it("works end to end with scoreHospital and computeBaseline", () => {
    const rated = (rs: number[]) => rs.map((rating) => mention("MENTION_ONLY", { rating }));
    const scores = [
      score(rated([2, 2, 2, 2, 2])),
      score(rated([4, 4, 4, 4, 4])),
      score(rated([3, 3, 3, 3, 3])),
      score(rated([5, 5])), // n < 5 → no rating split
    ];
    const b = computeBaseline(scores);
    expect(b).toEqual({ medianAyushmanRating: 3, hospitalsWithRating: 3, hospitalsConsidered: 4 });
    expect(applyBaseline(scores, b).map((s) => s.deltaVsCityMedian)).toEqual([-1, 1, 0, null]);
  });
});

// ---------- sorting ----------

describe("sortForDisplay", () => {
  it("returns an empty array for no results", () => {
    expect(sortForDisplay([], "evidence")).toEqual([]);
  });

  it("evidence: n desc, then review count desc, then input order", () => {
    const input = [
      result("a", { n: 3 }, 100),
      result("b", { n: 9 }, 50),
      result("c", { n: 3 }, 500),
      result("d", { n: 3 }, undefined), // missing count sorts as 0
      result("e", { n: 9 }, 50),
    ];
    expect(ids(sortForDisplay(input, "evidence"))).toEqual(["b", "e", "c", "a", "d"]);
  });

  it("does not mutate the input array", () => {
    const input = [result("a", { n: 1 }), result("b", { n: 5 })];
    const out = sortForDisplay(input, "evidence");
    expect(ids(input)).toEqual(["a", "b"]);
    expect(out).not.toBe(input);
  });

  it("problems: problem share desc, n < 3 last in input order", () => {
    const input = [
      result("few1", { n: 2, problemCount: 2 }), // 100% but too few
      result("low", { n: 10, problemCount: 1 }), // 10%
      result("high", { n: 4, problemCount: 3 }), // 75%
      result("zero", { n: 0 }),
      result("mid", { n: 5, problemCount: 2 }), // 40%
    ];
    expect(ids(sortForDisplay(input, "problems"))).toEqual(["high", "mid", "low", "few1", "zero"]);
  });

  it("problems: equal shares put larger n first, then keep input order", () => {
    const input = [
      result("small", { n: 4, problemCount: 2 }), // 50%
      result("big", { n: 8, problemCount: 4 }), // 50%
      result("big2", { n: 8, problemCount: 4 }), // 50%, same n as big
    ];
    expect(ids(sortForDisplay(input, "problems"))).toEqual(["big", "big2", "small"]);
  });

  it("cashless: cashless share desc, n < 3 last", () => {
    const input = [
      result("few", { n: 1, cashlessOkCount: 1 }),
      result("half", { n: 6, cashlessOkCount: 3 }),
      result("all", { n: 3, cashlessOkCount: 3 }),
      result("none", { n: 7, cashlessOkCount: 0 }),
    ];
    expect(ids(sortForDisplay(input, "cashless"))).toEqual(["all", "half", "none", "few"]);
  });

  it("is stable for fully tied items in every mode", () => {
    const input = ["p", "q", "r", "s"].map((id) =>
      result(id, { n: 5, problemCount: 1, cashlessOkCount: 1 }, 10),
    );
    for (const mode of ["evidence", "problems", "cashless"] as const) {
      expect(ids(sortForDisplay(input, mode))).toEqual(["p", "q", "r", "s"]);
    }
  });
});

// ---------- summary ----------

describe("evidenceSummary", () => {
  it("matches the documented wording", () => {
    expect(evidenceSummary(fakeScore({ n: 9, problemCount: 4, cashlessOkCount: 3 }))).toBe(
      "4 of 9 reviewers in the last 24 months report being asked to pay or turned away; 3 report cashless treatment.",
    );
  });

  it("declines to summarise below n=3", () => {
    expect(evidenceSummary(fakeScore({ n: 2, problemCount: 2 }))).toBe("Too few reports (n=2) to summarise.");
    expect(evidenceSummary(fakeScore({ n: 0 }))).toBe("Too few reports (n=0) to summarise.");
  });

  it("uses singular verbs for a count of 1", () => {
    expect(evidenceSummary(fakeScore({ n: 3, problemCount: 1, cashlessOkCount: 1 }))).toBe(
      "1 of 3 reviewers in the last 24 months reports being asked to pay or turned away; 1 reports cashless treatment.",
    );
  });

  it("never uses verdict words", () => {
    const forbidden = /safe|bad|scam|fraud|good|avoid|trust/i;
    for (let n = 0; n <= 10; n++) {
      for (let problemCount = 0; problemCount <= n; problemCount++) {
        const cashlessOkCount = n - problemCount;
        const s = evidenceSummary(fakeScore({ n, problemCount, cashlessOkCount }));
        expect(s).not.toMatch(forbidden);
      }
    }
  });

  it("agrees with scoreHospital output", () => {
    const s = score([...many(4, "REFUSED"), ...many(3, "CASHLESS_OK"), ...many(2, "DELAY")]);
    expect(evidenceSummary(s)).toBe(
      "4 of 9 reviewers in the last 24 months report being asked to pay or turned away; 3 report cashless treatment.",
    );
  });
});
