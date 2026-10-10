// Deterministic scoring: the LLM only assigns classes, everything numeric is
// decided here. Pure functions (no IO, no clock reads — `now` is passed in) so
// every rule in docs/ARCHITECTURE.md is unit-tested in tests/scoring.test.ts.
// No server dependencies: the UI imports the thresholds, sorter and summary
// from here so the cards and the server can never disagree.

import {
  EVIDENCE_CLASSES,
  EXCLUDED_CLASSES,
  PROBLEM_CLASSES,
  type CityBaseline,
  type ClassifiedMention,
  type EvidenceClass,
  type EvidenceLabel,
  type Hospital,
  type HospitalResult,
  type HospitalScore,
  type Treatment,
} from "@/types/domain";

/** Mentions older than this (24 months) are shown as "older" and excluded from n. */
export const WINDOW_DAYS = 730;
/** Below this n the label is always "too_few_reports". */
export const MIN_N_FOR_LABEL = 3;
/** Minimum n (and rated mentions) before the Ayushman rating split is shown. */
export const MIN_N_FOR_RATING = 5;

const DAY_MS = 86_400_000;
/** WINDOW_DAYS in months (24), for user-facing copy. */
export const WINDOW_MONTHS = Math.round(WINDOW_DAYS / 30.4);
/** A side must be strictly more than this multiple of the other to win the label. */
const LABEL_RATIO = 1.5;
const LABEL_MIN_COUNT = 2;

/**
 * Rounds half away from zero. The tiny nudge absorbs binary float error
 * (e.g. 3.33 − 3.335 = −0.004999…) so ratings round the way a person would.
 */
function roundTo(x: number, decimals: number): number {
  const f = 10 ** decimals;
  const r = Math.round(Math.abs(x) * f + 1e-9) / f;
  return r === 0 ? 0 : Math.sign(x) * r; // never -0
}
const round2 = (x: number): number => roundTo(x, 2);

function parseIso(iso: string | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

const RELATIVE_AGE = /^(?:edited\s+)?(a|an|one|\d+)\s+(day|week|month|year)s?\s+ago\b/i;
const DAYS_PER_UNIT: Record<string, number> = { day: 1, week: 7, month: 30.44, year: 365 };

/**
 * Approximate age in days of Google's relative date ("a year ago", "Edited 3
 * weeks ago"); null for anything else (Hindi, "yesterday", hours). Google
 * floors these labels, so a year counts as 365 days: "2 years ago" reads as
 * exactly 730 and stays inside the inclusive window, a deliberately lenient
 * boundary since the label never proves the review is older.
 */
function relativeAgeDays(rel: string | undefined): number | null {
  const match = rel?.trim().match(RELATIVE_AGE);
  if (!match) return null;
  const count = /^\d+$/.test(match[1]) ? Number(match[1]) : 1;
  return count * DAYS_PER_UNIT[match[2].toLowerCase()];
}

/**
 * True if the mention falls within the last WINDOW_DAYS (inclusive).
 * SerpApi sometimes omits `iso_date`; then the relative date string decides.
 * Only a mention with no usable date at all counts as in-window: dropping it
 * would silently shrink n, and reviews are requested with sort_by=newestFirst
 * (serpapi/params.ts REVIEWS_SORT), so an undated mention sits among the
 * newest ones. Future dates (clock skew) are also in-window.
 */
export function isInWindow(m: Pick<ClassifiedMention, "isoDate" | "relativeDate">, now: Date): boolean {
  const t = parseIso(m.isoDate);
  if (t !== null) return now.getTime() - t <= WINDOW_DAYS * DAY_MS;
  const age = relativeAgeDays(m.relativeDate);
  return age === null || age <= WINDOW_DAYS;
}

function emptyCounts(): Record<EvidenceClass, number> {
  const counts = {} as Record<EvidenceClass, number>;
  for (const cls of EVIDENCE_CLASSES) counts[cls] = 0;
  return counts;
}

function labelFor(n: number, problem: number, cashless: number): EvidenceLabel {
  if (n < MIN_N_FOR_LABEL) return "too_few_reports";
  if (problem >= LABEL_MIN_COUNT && problem > LABEL_RATIO * cashless) return "more_problem_reports";
  if (cashless >= LABEL_MIN_COUNT && cashless > LABEL_RATIO * problem) return "more_cashless_reports";
  return "mixed_reports";
}

/** Scores one hospital. `deltaVsCityMedian` is null until applyBaseline runs. */
export function scoreHospital(
  hospital: Hospital,
  mentions: ClassifiedMention[],
  treatment: Treatment,
  now: Date,
): HospitalScore {
  const inWindow = mentions.filter((m) => isInWindow(m, now));
  const qualifying = inWindow.filter((m) => !EXCLUDED_CLASSES.includes(m.cls));
  const n = qualifying.length;

  // Counts cover every in-window mention, so excluded classes (NOT_PMJAY,
  // NAME_COLLISION) are visible in the UI — but only `qualifying` adds to n.
  const counts = emptyCounts();
  for (const m of inWindow) counts[m.cls] += 1;

  const problemCount = PROBLEM_CLASSES.reduce((sum, cls) => sum + counts[cls], 0);
  const cashlessOkCount = counts.CASHLESS_OK;

  const ratings = qualifying
    .map((m) => m.rating)
    .filter((r): r is number => typeof r === "number" && Number.isFinite(r));
  const ayushmanRating =
    n >= MIN_N_FOR_RATING && ratings.length >= MIN_N_FOR_RATING
      ? round2(ratings.reduce((a, b) => a + b, 0) / ratings.length)
      : null;

  // "general" has no treatment keywords, so a per-treatment count is meaningless.
  const k =
    treatment.id === "general" ? 0 : qualifying.filter((m) => m.treatmentMentioned === true).length;

  let latestReportIso: string | null = null;
  let latestT = -Infinity;
  for (const m of qualifying) {
    const t = parseIso(m.isoDate);
    if (t !== null && t > latestT) {
      latestT = t;
      latestReportIso = m.isoDate ?? null;
    }
  }

  const amountsInr = qualifying
    .filter((m) => PROBLEM_CLASSES.includes(m.cls))
    .map((m) => m.amountInr)
    .filter((a): a is number => a !== null && Number.isFinite(a))
    .sort((a, b) => a - b);

  return {
    dataId: hospital.dataId,
    n,
    counts,
    problemCount,
    cashlessOkCount,
    ayushmanRating,
    overallRating: hospital.rating ?? null,
    deltaVsCityMedian: null,
    label: labelFor(n, problemCount, cashlessOkCount),
    treatmentMentions: { k, n },
    latestReportIso,
    amountsInr,
  };
}

/** City median of the Ayushman rating split across hospitals that have one. */
export function computeBaseline(scores: HospitalScore[]): CityBaseline {
  const rated = scores
    .map((s) => s.ayushmanRating)
    .filter((r): r is number => r !== null)
    .sort((a, b) => a - b);
  let median: number | null = null;
  if (rated.length > 0) {
    const mid = Math.floor(rated.length / 2);
    const raw = rated.length % 2 === 1 ? rated[mid] : (rated[mid - 1] + rated[mid]) / 2;
    // Inputs have 2 decimals, so an even-count median needs at most 3:
    // rounding to 3 only strips float noise, it never loses information.
    median = roundTo(raw, 3);
  }
  return {
    medianAyushmanRating: median,
    hospitalsWithRating: rated.length,
    hospitalsConsidered: scores.length,
  };
}

/** Returns copies with deltaVsCityMedian set (null when either side is missing). */
export function applyBaseline(scores: HospitalScore[], baseline: CityBaseline): HospitalScore[] {
  const median = baseline.medianAyushmanRating;
  return scores.map((s) => ({
    ...s,
    deltaVsCityMedian:
      s.ayushmanRating !== null && median !== null ? round2(s.ayushmanRating - median) : null,
  }));
}

export type SortMode = "evidence" | "problems" | "cashless";

type Compare = (a: HospitalResult, b: HospitalResult) => number;

const byEvidence: Compare = (a, b) =>
  b.score.n - a.score.n || (b.hospital.reviewCount ?? 0) - (a.hospital.reviewCount ?? 0);

/** Share-based order: hospitals with n < MIN_N_FOR_LABEL sink to the end; ties go to larger n. */
function byShare(count: (s: HospitalScore) => number): Compare {
  return (a, b) => {
    const aFew = a.score.n < MIN_N_FOR_LABEL;
    const bFew = b.score.n < MIN_N_FOR_LABEL;
    if (aFew || bFew) return Number(aFew) - Number(bFew);
    const share = (s: HospitalScore) => count(s) / s.n;
    return share(b.score) - share(a.score) || b.score.n - a.score.n;
  };
}

const COMPARATORS: Record<SortMode, Compare> = {
  evidence: byEvidence,
  problems: byShare((s) => s.problemCount),
  cashless: byShare((s) => s.cashlessOkCount),
};

/** Stable and non-mutating: equal items keep their input order. */
export function sortForDisplay(results: HospitalResult[], mode: SortMode): HospitalResult[] {
  return [...results].sort(COMPARATORS[mode]);
}

/** Neutral one-line summary: counts and n only — never a verdict on the hospital. */
export function evidenceSummary(score: HospitalScore): string {
  const { n, problemCount, cashlessOkCount } = score;
  if (n < MIN_N_FOR_LABEL) return `Too few reports (n=${n}) to summarise.`;
  const verb = (count: number) => (count === 1 ? "reports" : "report");
  return (
    `${problemCount} of ${n} reviewers in the last ${WINDOW_MONTHS} months ` +
    `${verb(problemCount)} being asked to pay or turned away; ` +
    `${cashlessOkCount} ${verb(cashlessOkCount)} cashless treatment.`
  );
}
