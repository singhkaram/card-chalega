// Numbered sentences for grounding. The LLM (and the rules fallback) cite
// sentence ids; code assembles quotes from them, so every quote shown in the
// UI is verbatim review text or Google's translation of it, labelled as such —
// never text written by a model.

import type { Review, Sentence } from "@/types/domain";
// Google's "(Translated by Google) … (Original) …" layout, shared with hospital replies.
import { splitGoogleSnippet, stripMarkers } from "@/lib/google-translation";

/** Bump whenever splitting changes: cached classifications store sentence ids. */
export const SENTENCE_SPLITTER_VERSION = 1;

export const MAX_SENTENCES = 40;
const MIN_FRAGMENT_CHARS = 12;
export const QUOTE_SEPARATOR = " … ";

const TERMINATORS = new Set([".", "!", "?", "।", "॥"]);
const CLOSERS = new Set(['"', "'", ")", "]", "”", "’", "»"]);
// A dot after these is an abbreviation ("Rs. 500", "Dr. Sharma"), not a sentence end.
const ABBREVIATION_BEFORE_DOT =
  /(?:^|[^\p{L}])(?:rs|dr|mr|mrs|ms|no|vs|sr|jr|st|prof|govt|approx|pvt|ltd|hosp|dept|opp|nr|inr)$/iu;

function clean(text: unknown): string {
  if (typeof text !== "string") return "";
  return text
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\f\v\u00a0\u200b\ufeff]+/g, " ");
}

function isNonBreakingDot(text: string, i: number, buffer: string): boolean {
  if (/\d/.test(text[i - 1] ?? "") && /\d/.test(text[i + 1] ?? "")) return true; // 4.5, 1.5
  return ABBREVIATION_BEFORE_DOT.test(buffer.slice(0, -1));
}

/** Splits on . ! ? । ॥ and newlines, then merges short fragments into neighbours. */
export function splitSentences(input: string): string[] {
  const text = clean(input);
  const pieces: string[] = [];
  let buffer = "";
  const flush = () => {
    const piece = buffer.replace(/\s+/g, " ").trim();
    if (piece) pieces.push(piece);
    buffer = "";
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n") {
      flush();
      continue;
    }
    buffer += ch;
    if (!TERMINATORS.has(ch)) continue;
    if (ch === "." && isNonBreakingDot(text, i, buffer)) continue;
    // Keep runs like "!!", "?!", "..." and closing quotes with the sentence.
    while (i + 1 < text.length && (TERMINATORS.has(text[i + 1]) || CLOSERS.has(text[i + 1]))) buffer += text[++i];
    flush();
  }
  flush();

  const merged: string[] = [];
  for (const piece of pieces) {
    const last = merged.length - 1;
    if (last >= 0 && (piece.length < MIN_FRAGMENT_CHARS || merged[last].length < MIN_FRAGMENT_CHARS)) {
      merged[last] = `${merged[last]} ${piece}`;
    } else {
      merged.push(piece);
    }
  }
  return merged;
}

/**
 * The review as numbered sentences. With a Google translation, original
 * sentences come first, then translated ones; ids are continuous from 0.
 */
export function reviewSentences(review: Review): Sentence[] {
  const original = stripMarkers(clean(review.textOriginal)).trim();
  const translated = stripMarkers(clean(review.textTranslated)).trim();

  let parts: { lang: Sentence["lang"]; text: string }[];
  if (original && translated && original !== translated) {
    parts = [{ lang: "original", text: original }, { lang: "translated", text: translated }];
  } else if (original && translated) {
    parts = [{ lang: "original", text: original }];
  } else {
    const text = clean(review.text);
    const snippet = splitGoogleSnippet(text);
    parts = snippet
      ? [{ lang: "original", text: snippet.original }, { lang: "translated", text: snippet.translated }]
      : [{ lang: "original", text: stripMarkers(text) }];
  }

  // Share the cap between languages so a long original cannot crowd out its translation.
  const perLanguage = Math.floor(MAX_SENTENCES / parts.length);
  const out: Sentence[] = [];
  for (const part of parts) {
    for (const text of splitSentences(part.text).slice(0, perLanguage)) {
      out.push({ id: out.length, text, lang: part.lang });
    }
  }
  return out;
}

/**
 * Quote assembled from cited sentences: original-language text, plus the
 * cited translated sentences when present. When only translated sentences
 * were cited, the quote is Google's translation and quoteIsTranslation is set,
 * so the UI does not present it as the reviewer's own words.
 */
export function quoteFromSentences(
  sentences: Sentence[],
  ids: readonly number[],
): { quote: string; quoteTranslated?: string; quoteIsTranslation?: true } {
  const wanted = new Set(ids);
  const cited = sentences.filter((s) => wanted.has(s.id));
  const original = cited.filter((s) => s.lang === "original").map((s) => s.text);
  const translated = cited.filter((s) => s.lang === "translated").map((s) => s.text);
  if (original.length === 0) {
    return translated.length > 0 ? { quote: translated.join(QUOTE_SEPARATOR), quoteIsTranslation: true } : { quote: "" };
  }
  return translated.length > 0
    ? { quote: original.join(QUOTE_SEPARATOR), quoteTranslated: translated.join(QUOTE_SEPARATOR) }
    : { quote: original.join(QUOTE_SEPARATOR) };
}
