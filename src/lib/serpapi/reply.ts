// Hospital (owner) replies to reviews. Two clean-ups run before a reply is
// stored or shown: Google's "(Translated by Google) … (Original) …" layout is
// split into original + translation, and a leading salutation is removed —
// replies usually open with the reviewer's name ("Dear Rakesh Kumar ji, …"),
// and reviewer identity is never stored or shown.

import { splitGoogleSnippet, stripMarkers } from "@/lib/google-translation";

export function stripReplyMarkers(text: string): string {
  return stripMarkers(text).trim();
}

/** Same layout as review snippets (shared with lib/ai/sentences.ts): "(Translated by Google) <translation> (Original) <original>". */
export function splitTranslatedReply(text: string): { original: string; translated: string } | null {
  return splitGoogleSnippet(text);
}

// Abbreviations ("Mr.", "Dr.", initials "R.") are part of the name, so their dot is not a terminator.
const ABBREVIATION = String.raw`(?:mr|mrs|ms|miss|dr|shri|smt|sri|\p{L})\.`;
const NAME_WORD = String.raw`(?!${ABBREVIATION})[\p{L}\p{M}'’-]+`;
// Greeting + up to 5 name-like words + the first terminator, only at the very start:
// "Dear Mr. Rakesh Kumar ji,", "Hi Priya!", "प्रिय राकेश जी,", "Namaste Sunita ji 🙏".
const REPLY_SALUTATION = new RegExp(
  String.raw`^\s*(?:dear|hi|hello|hey|respected|greetings|namaste|namaskar|नमस्ते|नमस्कार|प्रिय|आदरणीय)(?![\p{L}\p{M}])` +
    String.raw`(?:\s+(?:(?:${ABBREVIATION})+|${NAME_WORD})){0,5}?\s*[,.!:।\n🙏][,.!:।🙏\s]*`,
  "iu",
);

/** Removes a leading salutation (which usually names the reviewer); other replies are returned unchanged. */
export function stripReplySalutation(text: string): string {
  const rest = text.replace(REPLY_SALUTATION, "");
  return rest === text ? text : rest.charAt(0).toUpperCase() + rest.slice(1);
}

/** Salutation removal that keeps Google's marker layout intact (for sanitised snapshots). */
export function scrubReplySnippet(snippet: string): string {
  const split = splitTranslatedReply(snippet);
  if (!split) return stripReplySalutation(snippet);
  return `(Translated by Google) ${stripReplySalutation(split.translated)}\n\n(Original)\n${stripReplySalutation(split.original)}`;
}
