// Plain-text builders (call-ahead script, WhatsApp summary) and a clipboard
// helper with a fallback for older browsers / non-secure contexts.

import type { HospitalResult, Treatment } from "@/types/domain";
import { HOSPITALS_PER_RUN, RIGHTS } from "@/config/presets";
import { MIN_N_FOR_LABEL, sortForDisplay, WINDOW_MONTHS } from "@/lib/scoring/score";
import { formatStars, plural } from "./format";

/** Shown on the results page and shared on WhatsApp, so the two cannot drift apart. */
export const RESULTS_CAVEAT = `From Google Maps reviews that mention Ayushman (last ${WINDOW_MONTHS} months). Self-reported and unverified; not a verdict on any hospital.`;

export interface CallScript {
  hi: string[];
  en: string[];
}

/** Short treatment name for sentences: "Delivery / maternity" → "delivery". */
function shortName(label: string): string {
  return label.split(" / ")[0].trim();
}

export function buildCallScript(treatment: Treatment): CallScript {
  const general = treatment.id === "general";
  const hiX = general ? "मेरा इलाज" : shortName(treatment.labelHi);
  const enX = general ? "my treatment" : shortName(treatment.label).toLowerCase();
  return {
    hi: [
      "नमस्ते, मेरे पास आयुष्मान कार्ड (PM-JAY) है।",
      `क्या आपका अस्पताल आयुष्मान भारत योजना में सूचीबद्ध है, और क्या ${hiX} इसमें शामिल है?`,
      `क्या ${hiX} आयुष्मान कार्ड पर पूरी तरह कैशलेस होगा?`,
      "क्या दवाइयों, जाँच, इम्प्लांट या बेड के लिए अलग से पैसे देने होंगे?",
      "आयुष्मान मित्र डेस्क पर किससे बात करूँ, और उनका नंबर क्या है?",
    ],
    en: [
      "Hello, I have an Ayushman card (PM-JAY).",
      `Is your hospital empanelled under Ayushman Bharat PM-JAY, and is ${enX} covered here?`,
      `Will ${enX} be fully cashless on the Ayushman card?`,
      "Will I have to pay separately for medicines, tests, implants or the bed?",
      "Who should I speak to at the Ayushman Mitra desk, and what is their number?",
    ],
  };
}

export function callScriptText(script: CallScript): string {
  return [
    "हिंदी:",
    ...script.hi,
    "",
    "English:",
    ...script.en,
    "",
    `PM-JAY helpline: ${RIGHTS.helpline}`,
  ].join("\n");
}

export interface SummaryInput {
  heading: string;
  results: readonly HospitalResult[];
  sourceLine: string;
  url: string;
  limit?: number;
}

function hospitalLine(r: HospitalResult, i: number): string {
  const { score, hospital } = r;
  const name = hospital.name;
  if (score.n === 0) return `${i}. ${name}: no Ayushman reports in the last ${WINDOW_MONTHS} months.`;
  const reports = `${score.n} ${plural(score.n, "report", "reports")}`;
  if (score.n < MIN_N_FOR_LABEL) return `${i}. ${name}: ${reports} — too few to compare.`;
  let line = `${i}. ${name}: ${reports} — ${score.cashlessOkCount} cashless, ${score.problemCount} asked to pay or turned away.`;
  const overall = score.overallRating ?? hospital.rating;
  if (score.ayushmanRating !== null && overall !== undefined && overall !== null) {
    line += ` Ayushman-mentioning reviews ${formatStars(score.ayushmanRating)} vs overall ${formatStars(overall)}.`;
  }
  return line;
}

/**
 * Neutral plain-text summary for sharing on WhatsApp. Always in "most
 * evidence" order, whatever sort is on screen, so a shared list never reads
 * as a ranking of problems; hospitals left out are counted, not dropped silently.
 */
export function buildWhatsAppSummary({ heading, results, sourceLine, url, limit = HOSPITALS_PER_RUN }: SummaryInput): string {
  const withReports = results.filter((r) => r.score.n > 0);
  const pool = withReports.length > 0 ? withReports : [...results];
  const chosen = sortForDisplay(pool, "evidence").slice(0, limit);
  const omitted = results.length - chosen.length;
  return [
    `Card Chalega? — Ayushman card reports: ${heading}`,
    RESULTS_CAVEAT,
    "",
    ...chosen.map((r, i) => hospitalLine(r, i + 1)),
    ...(omitted > 0 ? [`+ ${omitted} more ${plural(omitted, "hospital", "hospitals")} compared — see link below.`] : []),
    "",
    sourceLine,
    `PM-JAY helpline: ${RIGHTS.helpline}`,
    url,
  ].join("\n");
}

/** Copies text; falls back to a hidden textarea when the async Clipboard API is unavailable. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  if (typeof document === "undefined") return false;
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "0";
  area.style.opacity = "0";
  document.body.appendChild(area);
  try {
    area.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(area);
    previous?.focus();
  }
}
