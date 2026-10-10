// Pure display helpers (no React). Deterministic so server and client render
// identical text: IST is computed from a fixed +05:30 offset, not the locale.

import type { CityId, NewsItem, TreatmentId } from "@/types/domain";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const IST_OFFSET_MS = 330 * 60_000;

function parseTime(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** "05 Oct 2026, 14:10 IST" (or "" for a missing/invalid date). */
export function formatIst(iso: string | null | undefined): string {
  const t = parseTime(iso);
  if (t === null) return "";
  const d = new Date(t + IST_OFFSET_MS);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} IST`;
}

/** "Oct 2026" — month precision for headlines and owner replies. */
export function formatMonthYear(iso: string | null | undefined): string {
  const t = parseTime(iso);
  if (t === null) return "";
  const d = new Date(t + IST_OFFSET_MS);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Headline date: "Sep 2026" from iso_date; SerpApi's raw date string only when iso_date is missing. */
export function newsDateText(item: Pick<NewsItem, "isoDate" | "dateText">): string {
  return formatMonthYear(item.isoDate) || item.dateText || "";
}

/** Approximate age: "about 4 months ago". Reviews only carry coarse dates, so we never imply precision. */
export function approxAge(iso: string | null | undefined, now: number = Date.now()): string | null {
  const t = parseTime(iso);
  if (t === null) return null;
  const days = Math.floor((now - t) / 86_400_000);
  if (days < 1) return "today";
  if (days < 2) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 30) {
    const w = Math.round(days / 7);
    return w <= 1 ? "about a week ago" : `about ${w} weeks ago`;
  }
  if (days < 365) {
    const m = Math.max(1, Math.round(days / 30.44));
    return m === 1 ? "about a month ago" : `about ${m} months ago`;
  }
  const y = Math.round(days / 365.25);
  return y <= 1 ? "about a year ago" : `about ${y} years ago`;
}

/** Age of a review: from its ISO date if present, else SerpApi's relative string. */
export function reviewAge(isoDate?: string, relativeDate?: string, now?: number): string | null {
  return approxAge(isoDate, now) ?? relativeDate ?? null;
}

const countFormat = new Intl.NumberFormat("en-IN");
const inrFormat = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });

export function formatCount(n: number): string {
  return countFormat.format(n);
}

export function formatInr(amount: number): string {
  return `₹${inrFormat.format(amount)}`;
}

/**
 * One decimal, half away from zero (same rule as lib/scoring). The nudge
 * absorbs binary float error, so 1.15 → 1.2 where toFixed(1) gives "1.1".
 */
export function round1(x: number): number {
  const r = Math.round(Math.abs(x) * 10 + 1e-9) / 10;
  return r === 0 ? 0 : Math.sign(x) * r; // never -0
}

/** "4.6★" with one decimal. */
export function formatStars(rating: number): string {
  return `${round1(rating).toFixed(1)}★`;
}

/**
 * Difference between the two values as formatStars shows them, so the
 * on-screen subtraction checks out (4.43 vs 3.165 is shown as 4.4 vs 3.2 → 1.2).
 */
export function displayedDelta(rating: number, median: number): number {
  return round1(round1(rating) - round1(median));
}

/** Neutral text for a rating delta vs the city median: "1.3★ below city median". */
export function describeDelta(delta: number): string {
  const abs = Math.abs(delta);
  if (abs < 0.05) return "about the same as the city median";
  return `${abs.toFixed(1)}★ ${delta < 0 ? "below" : "above"} city median`;
}

const DEVANAGARI = /[ऀ-ॿ]/;

/** True when the text contains Devanagari — used to set lang="hi". */
export function hasDevanagari(text: string | null | undefined): boolean {
  return Boolean(text && DEVANAGARI.test(text));
}

export function langFor(text: string | null | undefined): "hi" | undefined {
  return hasDevanagari(text) ? "hi" : undefined;
}

/** Only http(s) links are rendered; anything else (e.g. javascript:) is dropped. */
export function safeExternalUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export function checkHref(city: CityId, treatment: TreatmentId): string {
  return `/check?city=${encodeURIComponent(city)}&treatment=${encodeURIComponent(treatment)}`;
}

export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}
