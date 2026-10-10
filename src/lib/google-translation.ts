// Google's machine-translation layout, shared by review sentences
// (lib/ai/sentences.ts) and hospital replies (lib/serpapi/reply.ts):
// "(Translated by Google) <translation> (Original) <original>".
// No server dependencies: the classifier core and scripts import it too.

const TRANSLATED_MARKER = /\(\s*translated by google\s*\)/i;
const ORIGINAL_MARKER = /\(\s*original\s*\)/i;
const ANY_MARKER = /\(\s*(?:translated by google|original)\s*\)/gi;

/** Replaces every "(Translated by Google)" / "(Original)" marker with a space (no trimming). */
export function stripMarkers(text: string): string {
  return text.replace(ANY_MARKER, " ");
}

/** Splits Google's translated layout into its two halves; null when the text isn't in that layout. */
export function splitGoogleSnippet(text: string): { original: string; translated: string } | null {
  const t = TRANSLATED_MARKER.exec(text);
  const o = ORIGINAL_MARKER.exec(text);
  if (!t || !o || o.index < t.index) return null;
  const translated = stripMarkers(text.slice(t.index + t[0].length, o.index)).trim();
  const original = stripMarkers(text.slice(o.index + o[0].length)).trim();
  return original && translated ? { original, translated } : null;
}
