// Display vocabulary for the evidence taxonomy. Wording is deliberately
// neutral: we describe what reviewers report, never whether a hospital is
// "safe". Thresholds and the window come from lib/scoring (one definition).

import {
  EXCLUDED_CLASSES,
  PROBLEM_CLASSES,
  type ClassifiedMention,
  type ClassifierKind,
  type EvidenceClass,
  type EvidenceLabel,
  type HospitalScore,
} from "@/types/domain";
import { isInWindow, WINDOW_MONTHS } from "@/lib/scoring/score";
import { plural } from "./format";

export type EvidenceGroupId = "cashless" | "charged" | "unclear" | "refused" | "dispute" | "mention";

export interface EvidenceGroup {
  id: EvidenceGroupId;
  label: string;
  classes: EvidenceClass[];
  /** CSS class from globals.css: hue + pattern. */
  swatch: string;
}

/** Bar order: cashless first, then charges, refusals, disputes, plain mentions. */
export const EVIDENCE_GROUPS: EvidenceGroup[] = [
  { id: "cashless", label: "Cashless OK", classes: ["CASHLESS_OK"], swatch: "ev-cashless" },
  { id: "charged", label: "Asked to pay for package items", classes: ["CHARGED_FOR_PACKAGE_ITEMS"], swatch: "ev-charged" },
  { id: "unclear", label: "Unclear or outside-package charges", classes: ["CHARGED_OUTSIDE_PACKAGE_OR_UNCLEAR"], swatch: "ev-unclear" },
  { id: "refused", label: "Turned away", classes: ["REFUSED"], swatch: "ev-refused" },
  { id: "dispute", label: "Disputes & delays", classes: ["ELIGIBILITY_OR_SPECIALTY_DISPUTE", "DELAY"], swatch: "ev-dispute" },
  { id: "mention", label: "Mentions only", classes: ["MENTION_ONLY"], swatch: "ev-mention" },
];

export interface ClassInfo {
  label: string;
  description: string;
  swatch: string;
  counted: boolean;
}

export const CLASS_INFO: Record<EvidenceClass, ClassInfo> = {
  CASHLESS_OK: {
    label: "Cashless OK",
    description: "Treated cashless on the Ayushman card.",
    swatch: "ev-cashless",
    counted: true,
  },
  CHARGED_FOR_PACKAGE_ITEMS: {
    label: "Asked to pay for package items",
    description: "Asked to pay for things a PM-JAY package normally covers — medicines, tests, implants, bed or surgery.",
    swatch: "ev-charged",
    counted: true,
  },
  CHARGED_OUTSIDE_PACKAGE_OR_UNCLEAR: {
    label: "Unclear or outside-package charge",
    description: "Paid for something that may be outside the package, or the review doesn't say what the charge was for.",
    swatch: "ev-unclear",
    counted: true,
  },
  REFUSED: {
    label: "Turned away",
    description: "The card was not accepted or the patient was turned away.",
    swatch: "ev-refused",
    counted: true,
  },
  ELIGIBILITY_OR_SPECIALTY_DISPUTE: {
    label: "Eligibility or specialty dispute",
    description: "Told the card, patient or treatment isn't covered at this hospital.",
    swatch: "ev-dispute",
    counted: true,
  },
  DELAY: {
    label: "Delay",
    description: "Approval, paperwork or admission delays linked to the card.",
    swatch: "ev-dispute",
    counted: true,
  },
  NOT_PMJAY: {
    label: "Not about PM-JAY",
    description:
      "Uses the word Ayushman in another sense (e.g. ABHA health ID or OPD registration), or doesn't mention the card or scheme at all. Not counted.",
    swatch: "ev-mention",
    counted: false,
  },
  NAME_COLLISION: {
    label: "Hospital name only",
    description: "Mentions the hospital's own name, not the scheme. Not counted.",
    swatch: "ev-mention",
    counted: false,
  },
  MENTION_ONLY: {
    label: "Mentions only",
    description: "Mentions the card without saying what happened.",
    swatch: "ev-mention",
    counted: true,
  },
};

/** Each label names what it compares, so it never reads as a ranking against other hospitals. */
export const LABEL_TEXT: Record<EvidenceLabel, string> = {
  more_problem_reports: "Problem reports outnumber cashless",
  more_cashless_reports: "Cashless reports outnumber problems",
  mixed_reports: "Mixed problem and cashless reports",
  too_few_reports: "Too few reports",
};

export function isExcluded(cls: EvidenceClass): boolean {
  return EXCLUDED_CLASSES.includes(cls);
}

export function isProblem(cls: EvidenceClass): boolean {
  return PROBLEM_CLASSES.includes(cls);
}

export interface GroupCount extends EvidenceGroup {
  count: number;
}

export function groupCounts(score: HospitalScore): GroupCount[] {
  return EVIDENCE_GROUPS.map((g) => ({
    ...g,
    count: g.classes.reduce((sum, cls) => sum + (score.counts[cls] ?? 0), 0),
  }));
}

/** Accessible description of the evidence bar, e.g. "9 reports: Cashless OK 3, …". */
export function describeGroups(groups: GroupCount[], n: number): string {
  const parts = groups.filter((g) => g.count > 0).map((g) => `${g.label} ${g.count}`);
  return `${n} ${plural(n, "report", "reports")} in the last ${WINDOW_MONTHS} months: ${parts.join(", ") || "none"}.`;
}

function timeOf(iso?: string): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : 0;
}

/**
 * True when the review is older than the scoring window, relative to the run's
 * start (or now). Same rule as the server's n (isInWindow): the ISO date wins,
 * then Google's relative date ("4 years ago"); a mention with neither stays in.
 */
export function isOutsideWindow(
  m: Pick<ClassifiedMention, "isoDate" | "relativeDate">,
  referenceIso: string | undefined,
): boolean {
  return !isInWindow(m, new Date(timeOf(referenceIso) || Date.now()));
}

const QUOTE_PRIORITY: Record<EvidenceClass, number> = {
  REFUSED: 0,
  CHARGED_FOR_PACKAGE_ITEMS: 0,
  CASHLESS_OK: 1,
  CHARGED_OUTSIDE_PACKAGE_OR_UNCLEAR: 2,
  ELIGIBILITY_OR_SPECIALTY_DISPUTE: 2,
  DELAY: 3,
  MENTION_ONLY: 4,
  NOT_PMJAY: 9,
  NAME_COLLISION: 9,
};

/**
 * Top quotes for a card: problem reports first, then cashless, newest first.
 * If a cashless report exists but would not make the cut, it takes the last
 * slot so both sides are always visible.
 */
export function pickTopQuotes(mentions: ClassifiedMention[], referenceIso?: string, limit = 3): ClassifiedMention[] {
  const eligible = mentions.filter(
    (m) => !isExcluded(m.cls) && m.quote.trim() !== "" && !isOutsideWindow(m, referenceIso),
  );
  const sorted = [...eligible].sort(
    (a, b) => QUOTE_PRIORITY[a.cls] - QUOTE_PRIORITY[b.cls] || timeOf(b.isoDate) - timeOf(a.isoDate),
  );
  const top = sorted.slice(0, limit);
  if (top.length === limit && !top.some((m) => m.cls === "CASHLESS_OK")) {
    const cashless = sorted.find((m) => m.cls === "CASHLESS_OK");
    if (cashless) top[limit - 1] = cashless;
  }
  return top;
}

/** Why the "show all" list can be longer than n: reviews not about the scheme, and counted-class reviews outside the window. */
export function uncountedMentions(
  mentions: readonly ClassifiedMention[],
  referenceIso?: string,
): { notAboutScheme: number; older: number } {
  let notAboutScheme = 0;
  let older = 0;
  for (const m of mentions) {
    if (isExcluded(m.cls)) notAboutScheme++;
    else if (isOutsideWindow(m, referenceIso)) older++;
  }
  return { notAboutScheme, older };
}

/** Every report for the "show all" list: counted ones newest first, then older, then not-counted. */
export function orderAllMentions(mentions: ClassifiedMention[], referenceIso?: string): ClassifiedMention[] {
  const rank = (m: ClassifiedMention) => (isExcluded(m.cls) ? 2 : isOutsideWindow(m, referenceIso) ? 1 : 0);
  return [...mentions].sort((a, b) => rank(a) - rank(b) || timeOf(b.isoDate) - timeOf(a.isoDate));
}

/**
 * Which classifier produced a card's evidence. NOT_PMJAY / NAME_COLLISION come
 * from deterministic pre-rules (tagged "rules" even when Claude is up), so they
 * say nothing about the AI; any other "rules" mention means the fallback ran.
 */
export function classifierOf(mentions: readonly ClassifiedMention[], llmEnabled: boolean | undefined): ClassifierKind {
  const decided = mentions.filter((m) => !isExcluded(m.cls));
  if (decided.some((m) => m.classifier === "rules")) return "rules";
  if (decided.length > 0) return "llm";
  return llmEnabled === false ? "rules" : "llm";
}

/**
 * Run-level classifier for the progress step. Committed AI classifications are
 * served even without an API key, so the results win over `meta.llm` once known.
 */
export function runClassifierOf(results: Iterable<{ mentions: readonly ClassifiedMention[] }>, llmEnabled: boolean | undefined): ClassifierKind | undefined {
  let seen = false;
  for (const r of results) {
    if (!r.mentions.some((m) => !isExcluded(m.cls))) continue;
    seen = true;
    if (classifierOf(r.mentions, llmEnabled) === "llm") return "llm";
  }
  if (seen) return "rules";
  return llmEnabled === undefined ? undefined : llmEnabled ? "llm" : "rules";
}
