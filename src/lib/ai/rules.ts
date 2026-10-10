// Deterministic side of classification: pre-rules that never need the LLM
// (name collision, ABHA/OPD registration), the keyword fallback used whenever
// the LLM is unavailable, rupee-amount checks, and the code that turns a
// classification record into a ClassifiedMention. English, Hindi and Hinglish.

import { SCHEME_TERMS, TREATMENTS } from "@/config/presets";
import {
  EVIDENCE_CLASSES,
  type ClassifiedMention,
  type ClassifierKind,
  type EvidenceClass,
  type Hospital,
  type Review,
  type Sentence,
  type Treatment,
  type TreatmentId,
} from "@/types/domain";
import { CLASSIFIABLE_TREATMENT_IDS } from "./prompt";
import { quoteFromSentences } from "./sentences";

/** Treatment-independent result; cached and committed as data/classifications. */
export interface ClassificationRecord {
  cls: EvidenceClass;
  sentenceIds: number[];
  amountInr: number | null;
  treatmentsMentioned: TreatmentId[];
  classifier: ClassifierKind;
}

// ---------- matching helpers ----------

const B = "(?<![\\p{L}\\p{M}\\p{N}])"; // word start
const E = "(?![\\p{L}\\p{M}])"; // word end
/** Up to n intervening words. */
const W = (n: number) => `(?:\\S+\\s+){0,${n}}?`;
const NEG = `(?:${B}(?:not|never|cannot|nahi|nahin|nhi|nai)|n't|नहीं|नही)`;

function rx(alternatives: string[], flags = "iu"): RegExp {
  return new RegExp(alternatives.join("|").normalize("NFC"), flags);
}
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeForMatch(text: string): string {
  return text.normalize("NFC").toLowerCase().replace(/[’‘`]/g, "'");
}

function reviewText(review: Review): string {
  const parts = [review.text, review.textOriginal, review.textTranslated].filter((t): t is string => typeof t === "string");
  return normalizeForMatch(parts.join("\n"));
}

// ---------- scheme context, name collision, ABHA ----------

// "Ayushman Bharat Health Account" is ABHA, not the PM-JAY card, even though it contains "ayushman bharat".
const ABHA_EXPANSION_RE = rx(
  [
    "aa?yushmaa?n\\s+bharat\\s+(?:health\\s+account|digital\\s+(?:health\\s+)?mission)",
    "आयुष्मान\\s+भारत\\s+(?:हेल्थ\\s+अकाउंट|डिजिटल\\s+(?:हेल्थ\\s+)?मिशन|स्वास्थ्य\\s+खाता)",
  ],
  "giu",
);

const SCHEME_CONTEXT_RE = rx([
  ...SCHEME_TERMS.map(escapeRegex),
  `${B}aa?yushmaa?n\\s*(?:card|kard|bharat|yojana|yojna)`,
  "आयुष्मान\\s*(?:कार्ड|भारत|योजना)",
  `${B}(?:card|kard)\\s+(?:se|holders?|wal[eao])${E}`,
  `${B}cardholders?`,
  "कार्ड\\s+(?:से|धारक|वाले)",
]);

export function hasSchemeTerm(text: string): boolean {
  return SCHEME_CONTEXT_RE.test(normalizeForMatch(text).replace(ABHA_EXPANSION_RE, " "));
}

const ABHA_RE = rx([
  `${B}abha${E}`,
  `${B}abdm${E}`,
  "आभा",
  `${B}health\\s*-?id${E}`,
  "हेल्थ\\s*आई\\s*डी",
  `${B}health\\s+account`,
  `${B}scan\\s*(?:and|&|n)\\s*share`,
  `${B}opd\\s+(?:regist|card|parchi|parcha|slip|token|ticket)`,
  "ओपीडी\\s*(?:पर्ची|पर्चा|रजिस्ट्रेशन|पंजीकरण|कार्ड)",
  `${B}arogya\\s+mandir`,
  "आरोग्य\\s+मंदिर",
  "aa?yushmaa?n\\s+bharat\\s+(?:health\\s+account|digital)",
  "आयुष्मान\\s+भारत\\s+(?:हेल्थ|डिजिटल)",
]);

// Also "ayusman" / "आयुषमान": Google's review search may match loose spellings.
const AYUSHMAN_WORD_RE = rx(["aa?yus+h?maa?n", "आयु[षस]्?मान"]);
const CARD_CONTEXT_RE = rx(["aa?yus+h?maa?n", "आयु[षस]्?मान", `${B}(?:card|kard)`, "कार्ड", `${B}yoj(?:a)?na`, "योजना", "pm\\s*-?\\s*jay", "golden", "गोल्डन"]);

/**
 * Deterministic classes that never need the LLM:
 * NAME_COLLISION (hospital named "Ayushman", no scheme context) and
 * NOT_PMJAY (ABHA / health ID / OPD registration, no scheme context; or no
 * Ayushman, card or scheme word at all — the search may also match "Dr Ayush").
 */
export function preClassify(hospital: Hospital, review: Review): EvidenceClass | null {
  const text = reviewText(review);
  if (hasSchemeTerm(text)) return null;
  if (hospital.nameCollision) return "NAME_COLLISION";
  if (ABHA_RE.test(text)) return "NOT_PMJAY";
  if (!CARD_CONTEXT_RE.test(text)) return "NOT_PMJAY"; // no Ayushman/card/scheme word in any text variant
  return null;
}

// ---------- treatments ----------

// Hinglish spellings not in the presets' keyword lists.
const EXTRA_TREATMENT_KEYWORDS: Partial<Record<TreatmentId, string[]>> = {
  dialysis: ["dialisys", "dyalisis"],
  cataract: ["motiyabind", "motiya bind", "motia bind"],
  delivery: ["prasav", "जचगी", "jachgi"],
  "knee-replacement": ["ghutna", "ghutne", "ghutno"],
};
// Figures of speech that would otherwise read as "heart" or "eye".
const TREATMENT_STOP_RE = rx([`heart(?:felt|ily|ly)`, `from\\s+(?:the\\s+bottom\\s+of\\s+)?(?:my|our)\\s+heart`, `eye[\\s-]opening`], "giu");

const TREATMENT_PATTERNS: [TreatmentId, RegExp][] = CLASSIFIABLE_TREATMENT_IDS.map((id) => [
  id,
  rx([...TREATMENTS[id].keywords, ...(EXTRA_TREATMENT_KEYWORDS[id] ?? [])].map((k) => `${B}${escapeRegex(k.normalize("NFC"))}`)),
]);

/** Treatments mentioned in the text (keyword match; "general" is never returned). */
export function detectTreatments(text: string): TreatmentId[] {
  const t = normalizeForMatch(text).replace(TREATMENT_STOP_RE, " ");
  return TREATMENT_PATTERNS.filter(([, re]) => re.test(t)).map(([id]) => id);
}

// ---------- rupee amounts ----------

// Digit groups: "15,000", "1,50,000" or "15 000"; a space joins only a full 3-digit group.
const NUMBER = "(\\d+(?:(?:,\\d{2,3}|\\s\\d{3})(?!\\d))*(?:\\.\\d+)?)";
const MULTIPLIER = "(?:\\s*(k|thousand|hazaa?r|hajaa?r|हजार|हज़ार|lakhs?|lacs?|लाख)(?![\\p{L}\\p{M}]))?";
const MULTIPLIERS: Record<string, number> = { k: 1e3, thousand: 1e3, hazar: 1e3, hazaar: 1e3, hajar: 1e3, hajaar: 1e3, "हजार": 1e3, lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5, "लाख": 1e5 };
// Not inside "1.5" / "1,500", but "Rs.500" and "INR.2000" (a dot after letters) still count.
const NUMBER_RE = rx([`(?<![\\d,])(?<!\\d\\.)${NUMBER}${MULTIPLIER}`], "giu");
const CURRENCY_BEFORE_RE = rx([`(?:₹|${B}(?:rs|inr|rupees?)\\.?)\\s*${NUMBER}${MULTIPLIER}`], "giu");
const CURRENCY_AFTER_RE = rx(
  [`(?<![\\d.,])${NUMBER}${MULTIPLIER}\\s*(?:/-|₹|(?:rs|rupees?|rupaye|rupaya|rupiya|rupay|रुपये|रुपए|रुपया|रु)(?![\\p{L}\\p{M}]))`],
  "giu",
);
const BILL_RE = rx([`(?<![\\d.,])${NUMBER}${MULTIPLIER}\\s*(?:ka|का|of)?\\s*(?:bill|बिल)(?![\\p{L}\\p{M}])`], "giu");
const MULTIPLIED_RE = rx([`(?<![\\d.,])${NUMBER}\\s*(k|thousand|hazaa?r|hajaa?r|हजार|हज़ार|lakhs?|lacs?|लाख)(?![\\p{L}\\p{M}])`], "giu");

function asciiDigits(text: string): string {
  return text.replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - 0x0966));
}

function toAmount(digits: string, multiplier: string | undefined): number | null {
  const base = Number(digits.replace(/[,\s]/g, ""));
  if (!Number.isFinite(base)) return null;
  // Drop the nukta so "हज़ार" and "हजार" are the same key.
  const key = multiplier?.normalize("NFD").replace(/\u093c/g, "").normalize("NFC");
  const factor = key ? (MULTIPLIERS[key] ?? 1) : 1;
  const value = Math.round(base * factor);
  // "5 lakh" is the PM-JAY coverage limit, not a payment.
  if (value === 500_000 && factor === 1e5) return null;
  return value > 0 ? value : null;
}

function collect(re: RegExp, text: string, out: Set<number>, withParts: boolean): void {
  for (const m of normalizeForMatch(asciiDigits(text)).matchAll(re)) {
    const value = toAmount(m[1], m[2]);
    if (value !== null) out.add(value);
    // "2 500" may be two numbers rather than 2,500: accept the parts too.
    if (withParts && /\s/.test(m[1]) && !m[2]) {
      for (const part of m[1].split(/\s+/)) {
        const v = toAmount(part.replace(/,/g, ""), undefined);
        if (v !== null) out.add(v);
      }
    }
  }
}

/** Every number written in the text, with "15k" / "15 हजार" / "1.5 lakh" forms expanded. */
export function numbersInText(text: string): Set<number> {
  const out = new Set<number>();
  collect(NUMBER_RE, text, out, true);
  return out;
}

/** Amounts written as money: ₹/Rs/rupees/"/-" or "ka bill" next to a number, or k/hazar/lakh forms. */
export function extractRupeeAmounts(text: string): number[] {
  const out = new Set<number>();
  collect(CURRENCY_BEFORE_RE, text, out, false);
  collect(CURRENCY_AFTER_RE, text, out, false);
  collect(BILL_RE, text, out, false);
  collect(MULTIPLIED_RE, text, out, false);
  return [...out];
}

/** Classes where an amount means money paid or demanded. */
const AMOUNT_CLASSES: ReadonlySet<EvidenceClass> = new Set<EvidenceClass>([
  "CHARGED_FOR_PACKAGE_ITEMS",
  "CHARGED_OUTSIDE_PACKAGE_OR_UNCLEAR",
  "REFUSED",
  "ELIGIBILITY_OR_SPECIALTY_DISPUTE",
  "DELAY",
]);

/** Keeps an LLM-reported amount only if that number is written in the cited text. */
export function acceptAmount(amount: number | null, citedText: string, cls: EvidenceClass): number | null {
  if (amount === null || !Number.isFinite(amount) || amount <= 0 || !AMOUNT_CLASSES.has(cls)) return null;
  const rounded = Math.round(amount);
  return numbersInText(citedText).has(rounded) ? rounded : null;
}

// ---------- keyword fallback ----------

const MONEY_NOUN = "(?:paisa|paise|paisaa|pese|paisay|rupaya|rupaye|rupees?|rupiya|money|charges?|fees?|पैसा|पैसे|रुपया|रुपये|रुपए|चार्ज|फीस|शुल्क)";
const TAKE_VERB =
  "(?:liya|lia|liye|lie|laga|lage|lagi|lagaa|diya|diye|dena|dene|mangi|manga|mange|लिया|लिए|लगा|लगे|लगी|दिया|दिए|देना|देने|मांगा|मांगे)";

/** Lookbehind: the phrase is not preceded by "not" / "never" ("not covered under Ayushman"). */
const NOT_AFTER_NEGATION = `(?<!(?:${B}not|n't|${B}never|${B}isn't|${B}wasn't)\\s+(?:\\S+\\s+)?)`;

// Negated money ("koi paisa nahi laga", "no charges", "paid by Ayushman") and free treatment.
const CASHLESS_PARTS = [
  `${B}cashless`,
  `${B}free${E}`,
  `${B}muft`,
  "मुफ्त",
  "मुफ़्त",
  "फ्री",
  "निःशुल्क",
  "निशुल्क",
  `${B}nishulk`,
  `${B}no\\s+${W(1)}(?:money|charges?|payment|cost|fees?|bill)(?:\\s+(?:was\\s+|were\\s+)?(?:charged|taken|paid|asked|demanded))?${E}`,
  `${B}without\\s+${W(1)}(?:money|payment|paying|charges?|cost|fees?)`,
  `${B}(?:didn't|did\\s+not|don't|do\\s+not|never|not)\\s+${W(2)}(?:pay|paid|charge|charged|spend|spent)${E}`,
  `${B}(?:didn't|did\\s+not|not|never)\\s+${W(2)}(?:take|took|taken|ask|asked|demand|demanded)\\s+${W(1)}(?:money|payment|charges?|fees?|cash)`,
  `${B}nothing\\s+${W(2)}(?:charged|paid|taken)`,
  `${B}(?:charged|paid|spent)\\s+(?:nothing|zero|0)${E}`,
  `${B}not\\s+(?:a\\s+)?single\\s+(?:rupee|paisa|penny)`,
  `${B}zero\\s+(?:bill|cost|payment|rupees?|charges?)`,
  `${NOT_AFTER_NEGATION}${B}paid\\s+by\\s+(?:the\\s+)?(?:ayushman|card|government|govt|scheme|yojana)`,
  `${NOT_AFTER_NEGATION}${B}covered\\s+(?:under|by|in)\\s+(?:the\\s+)?(?:ayushman|card|scheme|pm-?jay|yojana|golden)`,
  `${B}(?:koi|ek)\\s+(?:bhi\\s+)?${MONEY_NOUN}\\s+(?:bhi\\s+)?(?:nahi|nahin|nhi|nai)`,
  `${B}${MONEY_NOUN}\\s+${W(2)}${NEG}\\s+${W(1)}${TAKE_VERB}`,
  "(?:कोई|एक)\\s+(?:भी\\s+)?(?:पैसा|पैसे|रुपया|रुपये|रुपए)\\s+(?:भी\\s+)?(?:नहीं|नही)",
  `(?:${B}bina|बिना)\\s+${W(1)}(?:paise|paisa|kharch|kharche|kharcha|payment|पैसे|पैसा|खर्च|शुल्क|भुगतान)`,
];
const CASHLESS_RE = rx(CASHLESS_PARTS);
const CASHLESS_SPANS_RE = rx(CASHLESS_PARTS, "giu");
// "Not free" / "free nahi" means the opposite of free.
const NOT_FREE_PARTS = [`(?:not|n't|never)\\s+${W(1)}free${E}`, `${B}free\\s+${W(1)}(?:nahi|nahin|nhi|nai|नहीं)`, `(?:फ्री|मुफ्त)\\s+${W(1)}नहीं`];
const NOT_FREE_RE = rx(NOT_FREE_PARTS);
const NOT_FREE_SPANS_RE = rx(NOT_FREE_PARTS, "giu");
// Positive acceptance; only trusted in sentences without a negation.
const ACCEPTED_RE = rx([
  `(?:card|ayushman|golden)\\s+${W(2)}accepted`,
  `${B}accepted\\s+${W(2)}(?:ayushman|card|golden)`,
  `(?:card|कार्ड)\\s+(?:se|से)\\s+${W(2)}(?:ilaa?j|ilaz|treatment|operation|opration|इलाज|ऑपरेशन|ओपरेशन)\\s+${W(1)}(?:hua|hui|ho\\s+gaya|ho\\s+gya|kiya|kia|done|हुआ|हुई|हो\\s+गया|किया)`,
]);
const NEGATION_RE = rx([`${B}(?:not|never|no|nahi|nahin|nhi|nai)${E}`, `n't${E}`, "नहीं", "नही", `${B}मना`]);

// "Humne mana kiya" / "we refused": the patient declined (usually to pay), not the hospital.
const NOT_BY_PATIENT = `(?<!${B}(?:we|i|humne|hamne|hum\\s+ne|ham\\s+ne|maine|mainne|mene|main\\s+ne|हमने|हम\\s+ने|मैंने|मैने)\\s+)`;

const REFUSAL_RE = rx([
  `${NOT_BY_PATIENT}${B}refus`,
  `${B}den(?:y|ied|ies)${E}`,
  `${B}reject`,
  `(?:${B}not|n't|${B}never)\\s+${W(2)}accept(?:ed|ing|s)?${E}`,
  `${B}accept(?:ed|ing)?\\s+${W(3)}(?:nahi|nahin|nhi|nai|नहीं)`,
  `(?:not|n't|never)\\s+${W(1)}tak(?:e|es|ing|en)\\s+${W(2)}(?:card|ayushman|golden)`,
  `${B}turn(?:ed|s)?\\s+${W(1)}away`,
  `${B}go\\s+(?:somewhere\\s+)?elsewhere`,
  `${NOT_BY_PATIENT}${B}manaa?\\s*(?:kar|kr|kiya|kia|kardiya|krdiya)`,
  `${B}inkaa?r`,
  `${B}bhaga\\s*(?:diya|dia|dete)`,
  `${NOT_BY_PATIENT}मना\\s*(?:कर|किया)`,
  `(?:${B}(?:won't|will\\s+not|wouldn't|would\\s+not|didn't|did\\s+not|not)|${B}refused\\s+to)\\s+${W(1)}admit`,
  `${B}(?:admit|bharti|bharati)\\s+${W(1)}${NEG}\\s+${W(1)}(?:kiya|kia|kare|karte|kiye|karenge)`,
  "भर्ती\\s+(?:नहीं|नही)",
  "इनकार",
  "इंकार",
  "स्वीकार\\s*(?:नहीं|नही)",
  "भगा\\s*दिया",
  "वापस\\s*भेज",
  // "card nahi liya" counts only next to the card, so "paisa nahi liya" (cashless) is not a refusal.
  `(?:card|kard|ayushman|golden|कार्ड|आयुष्मान)\\S*\\s+${W(3)}(?:nahi|nahin|nhi|nai|नहीं|नही)\\s+${W(1)}(?:liya|lia|liye|lete|leta|lenge|chalta|chalega|chala|maana|mana|mante|maante|लिया|लिए|लेते|लेता|लेंगे|चलता|चलेगा|चला|माना|मानते)`,
]);

const MONEY_TAKEN_VERB =
  "(?:liye|liya|lie|lia|lete|leta|mange|manga|maange|maanga|diye|diya|dene|dena|lage|laga|lagte|lagta|लिए|लिया|लेते|मांगे|मांगा|दिए|दिया|देने|देना|लगे|लगा|लगते)";
// Payment verbs: a charge even in a sentence that also says "free".
const CHARGE_RE = rx([
  `${B}charg(?:e|ed|es|ing)${E}`,
  `${B}paid${E}`,
  `${B}pay(?:ing|ment|ments)?${E}`,
  `${B}deposit`,
  `${B}advance${E}`,
  `${B}extra\\s+${W(1)}(?:money|paisa|paise|charges?|amount|payment|fees?|rupees?|cash|पैसे)`,
  `${B}fees?${E}`,
  `${B}bill(?:ed|ing)${E}`,
  `${B}demand(?:ed|ing|s)?${E}`,
  `${B}loot`,
  `${B}bribe`,
  `${B}rishwat`,
  `${B}kharch`,
  `${B}(?:vasool|vasul|wasool)`,
  `${B}${MONEY_NOUN}\\s+${W(1)}${MONEY_TAKEN_VERB}${E}`,
  `\\d\\s*${W(1)}${MONEY_TAKEN_VERB}${E}`,
  "रिश्वत",
  "खर्च",
  "वसूल",
  "लूट",
  `${B}शुल्क`,
  "फीस",
  `${B}चार्ज`,
  "जमा\\s*(?:करा|कर)",
  `${B}jama\\s*(?:kara|kar|krwa|karwa|krva|karva)`,
]);
// "free ... but/lekin <money>": the money after the contrast is a charge.
const CONTRAST_RE = rx([`${B}(?:but|however|though|although|still|lekin|magar|(?:phir|fir)\\s+bhi)${E}`, "लेकिन", "मगर", "फिर\\s+भी"]);
// Bare money words and amounts: a charge only where the sentence does not say it was free
// ("free ilaj, 2 lakh bach gaye" saved money, it was not charged).
const MONEY_MENTION_RE = rx([
  `${B}money${E}`,
  `${B}cash${E}`,
  `${B}bills?${E}`,
  `${B}(?:paisa|paise|paisaa|pese|paisay|rupaye|rupaya|rupiya|rupees?)${E}`,
  "पैसा",
  "पैसे",
  "रुपये",
  "रुपए",
  "रुपया",
  `${B}बिल${E}`,
  "₹",
  `${B}rs\\.?\\s*\\d`,
  `${B}inr\\.?\\s*\\d`,
  `\\d\\s*(?:rs|rupees?|rupaye|/-)`,
  `\\d\\s*(?:k|thousand|hazaa?r|hajaa?r|हजार|हज़ार|lakhs?|lacs?|लाख)${E}`,
]);

const PACKAGE_ITEM_RE = rx([
  `${B}medicin`,
  `${B}meds?${E}`,
  `${B}tablets?${E}`,
  `${B}d(?:a|aa)wa`,
  `${B}dwai`,
  `${B}dava`,
  "दवा",
  `${B}implants?`,
  `${B}lens(?:es)?${E}`,
  "लेंस",
  `${B}stents?${E}`,
  "स्टेंट",
  `${B}tests?${E}`,
  `${B}x-?rays?${E}`,
  `${B}mri${E}`,
  `${B}ct\\s*-?scan`,
  `${B}ultra\\s*sound`,
  `${B}sonography`,
  `${B}scans?${E}`,
  `${B}jaa?nch`,
  "जांच",
  "जाँच",
  "एक्स-?रे",
  `${B}injections?${E}`,
  "इंजेक्शन",
  `${B}consumables?`,
  `${B}gloves${E}`,
  `${B}syringes?`,
  `${B}blood\\s+(?:bags?|units?)`,
  `${B}(?:bed|room)\\s+(?:charges?|rent|fees?)`,
  `${B}(?:operation|surgery)\\s+(?:charges?|fees?)`,
  `${B}dialysis\\s+(?:kit|charges?|fees?)`,
]);
const PAY_OUTSIDE_RE = rx([
  `${B}(?:bahar|baahar|bahr)\\s+se`,
  "बाहर\\s*से",
  `${B}from\\s+outside`,
  `${B}(?:buy|bought|purchas)`,
  `${B}kharid`,
  "खरीद",
  `${B}mang(?:a|wa|va|waya|vaya|wai|vai|wayi|vayi|aya|ayi|ai)${E}`,
  "मंगवा",
  "मंगा",
]);

const DELAY_RE = rx([
  `${B}wait(?:ed|ing|s)?${E}`,
  `${B}delay`,
  `${B}late${E}`,
  `${B}pending${E}`,
  `${B}approv\\S*\\s+${W(1)}(?:pending|late|delay\\S*|nahi|nhi)${E}`,
  `${B}took\\s+${W(2)}(?:days|hours|weeks|long)${E}`,
  `${B}(?:days|hours|weeks)\\s+for\\s+${W(1)}approv`,
  `${B}inte?zaa?r`,
  `${B}intjaa?r`,
  `${B}intzaa?r`,
  `${B}der\\s+(?:se|lagi|lag|ho)`,
  `${B}deri${E}`,
  `${B}chakk?ar\\s+${W(1)}(?:lag|kat)`,
  "इंतजार",
  "इंतज़ार",
  "प्रतीक्षा",
  "देरी",
  "देर\\s+(?:से|लगी|हुई|हो)",
  "चक्कर",
]);

const ELIGIBILITY_RE = rx([
  `${NEG}\\s+${W(2)}empan`,
  `${B}empan\\S*\\s+${W(2)}${NEG}`,
  `${B}(?:non|un)-?empan`,
  `(?:not|n't|nahi|nhi)\\s+${W(2)}(?:covered|included|eligible)`,
  `${B}(?:cover|covered|include|included)\\s+${W(1)}(?:nahi|nhi|नहीं)`,
  `${B}(?:in)?eligib`,
  `${B}e-?kyc${E}`,
  `${B}kyc${E}`,
  `${NEG}\\s+${W(2)}verif`,
  `${B}verif\\S*\\s+${W(2)}(?:nahi|nhi|नहीं|fail\\S*|not|issue|problem)`,
  `${B}card\\s+${W(2)}(?:invalid|inactive|blocked|expired|deactivat\\S*)`,
  `${B}(?:specialty|speciality)\\s+${W(2)}${NEG}`,
  // "sirf aankh ka ilaaj hoga", "only does eye surgeries": a specialty limit.
  `${B}(?:sirf|keval|kewal|only)\\s+${W(2)}(?:ka|ke|ki)\\s+(?:ilaa?j|ilaz|treatment|operation)`,
  `${B}only\\s+(?:does|do|treats?|handles?|for)\\s+${W(2)}(?:treatment|surgery|surgeries|cases|operations?)${E}`,
  "(?:सिर्फ़?|केवल)\\s+(?:\\S+\\s+){0,2}?(?:का|के|की)\\s+(?:इलाज|ऑपरेशन)",
  `${B}not\\s+in\\s+(?:the\\s+)?(?:package|scheme|list|yojana)`,
  `${B}(?:package|scheme|yojana|list)\\s+(?:me|mein|main|में)\\s+${NEG}`,
  `${B}name\\s+${W(2)}(?:not|nahi|nhi)\\s+${W(2)}(?:list|suchi)`,
  "पात्र\\s*(?:नहीं|नही)",
  "पात्रता",
  "अपात्र",
  "सूची\\s*में\\s*नाम\\s*(?:नहीं|नही)",
  "वेरिफ\\S*\\s+(?:नहीं|नही|फेल)",
  "सत्यापन\\s+(?:नहीं|नही)",
  "कवर\\s*(?:नहीं|नही)",
  "शामिल\\s*(?:नहीं|नही)",
]);

// "A lens upgrade was offered for ₹6,000, which we declined": an amount, but not a charge.
const DECLINED_OFFER_RE = rx([
  `${B}(?:offer|suggest|recommend|advis|propos)\\S*\\s+${W(8)}(?:declin|turned\\s+(?:it\\s+)?down|did\\s*n[o']?t\\s+(?:take|opt|want))`,
]);

interface SentenceSignals {
  refused: boolean;
  eligibility: boolean;
  charge: boolean;
  packageItem: boolean;
  payOutside: boolean;
  cashless: boolean;
  delay: boolean;
}

function afterContrast(text: string): string {
  const m = CONTRAST_RE.exec(text);
  return m ? text.slice(m.index) : "";
}

function signalsFor(sentence: Sentence): SentenceSignals {
  const text = normalizeForMatch(sentence.text);
  const notFree = NOT_FREE_RE.test(text);
  const withoutNotFree = text.replace(NOT_FREE_SPANS_RE, " ");
  const cashlessSpans = CASHLESS_RE.test(withoutNotFree);
  // Charge and refusal are read with the cashless phrases removed, so "no money charged"
  // or "paisa nahi liya" do not count, while "free treatment but medicines charged" still does.
  const rest = withoutNotFree.replace(CASHLESS_SPANS_RE, " ");
  return {
    refused: REFUSAL_RE.test(rest),
    eligibility: ELIGIBILITY_RE.test(text),
    // Payment verbs always count; a bare amount does not when the offer was declined.
    charge:
      notFree ||
      CHARGE_RE.test(rest) ||
      (!DECLINED_OFFER_RE.test(rest) && MONEY_MENTION_RE.test(cashlessSpans ? afterContrast(rest) : rest)),
    packageItem: PACKAGE_ITEM_RE.test(text),
    payOutside: PAY_OUTSIDE_RE.test(rest),
    cashless: cashlessSpans || (ACCEPTED_RE.test(text) && !NEGATION_RE.test(text)),
    delay: DELAY_RE.test(text),
  };
}

const MAX_CITED_PER_LANGUAGE = 2;

function cite(sentences: Sentence[], picked: Sentence[]): number[] {
  const ids: number[] = [];
  for (const lang of ["original", "translated"] as const) {
    ids.push(...picked.filter((s) => s.lang === lang).slice(0, MAX_CITED_PER_LANGUAGE).map((s) => s.id));
  }
  return ids.filter((id) => sentences.some((s) => s.id === id)).sort((a, b) => a - b);
}

/** First matching sentence per language, else the first sentence per language. */
function citeFirst(sentences: Sentence[], ...patterns: RegExp[]): number[] {
  for (const re of patterns) {
    const hits = sentences.filter((s) => re.test(normalizeForMatch(s.text)));
    if (hits.length > 0) return cite(sentences, ["original", "translated"].flatMap((lang) => hits.filter((s) => s.lang === lang).slice(0, 1)));
  }
  return cite(sentences, ["original", "translated"].flatMap((lang) => sentences.filter((s) => s.lang === lang).slice(0, 1)));
}

function decide(hospital: Hospital, review: Review, sentences: Sentence[]): { cls: EvidenceClass; ids: number[] } {
  const pre = preClassify(hospital, review);
  if (pre === "NAME_COLLISION") return { cls: pre, ids: citeFirst(sentences, AYUSHMAN_WORD_RE) };
  if (pre === "NOT_PMJAY") return { cls: pre, ids: citeFirst(sentences, ABHA_RE, AYUSHMAN_WORD_RE) };

  const signals = sentences.map((s) => ({ s, sig: signalsFor(s) }));
  const pick = (pred: (sig: SentenceSignals) => boolean) => signals.filter((x) => pred(x.sig)).map((x) => x.s);

  // A refusal that comes with an eligibility/specialty reason is a dispute, not a flat refusal.
  const refused = pick((sig) => sig.refused && !sig.eligibility);
  if (refused.length > 0) return { cls: "REFUSED", ids: cite(sentences, refused) };

  if (CARD_CONTEXT_RE.test(reviewText(review))) {
    const packageItems = pick((sig) => (sig.charge || sig.payOutside) && sig.packageItem);
    if (packageItems.length > 0) return { cls: "CHARGED_FOR_PACKAGE_ITEMS", ids: cite(sentences, packageItems) };
    const charged = pick((sig) => sig.charge);
    if (charged.length > 0) return { cls: "CHARGED_OUTSIDE_PACKAGE_OR_UNCLEAR", ids: cite(sentences, charged) };
  }

  const cashless = pick((sig) => sig.cashless);
  if (cashless.length > 0) return { cls: "CASHLESS_OK", ids: cite(sentences, cashless) };
  const delay = pick((sig) => sig.delay);
  if (delay.length > 0) return { cls: "DELAY", ids: cite(sentences, delay) };
  const eligibility = pick((sig) => sig.eligibility);
  if (eligibility.length > 0) return { cls: "ELIGIBILITY_OR_SPECIALTY_DISPUTE", ids: cite(sentences, eligibility) };

  return { cls: "MENTION_ONLY", ids: citeFirst(sentences, SCHEME_CONTEXT_RE, CARD_CONTEXT_RE) };
}

/** Keyword heuristic used when the LLM is unavailable. Runs the pre-rules first. */
export function classifyWithRules(hospital: Hospital, review: Review, sentences: Sentence[], treatment: Treatment): ClassifiedMention {
  const { cls, ids } = decide(hospital, review, sentences);
  const amounts = AMOUNT_CLASSES.has(cls)
    ? extractRupeeAmounts(sentences.filter((s) => ids.includes(s.id)).map((s) => s.text).join("\n"))
    : [];
  const record: ClassificationRecord = {
    cls,
    sentenceIds: ids,
    amountInr: amounts.length > 0 ? Math.max(...amounts) : null,
    treatmentsMentioned: detectTreatments(reviewText(review)),
    classifier: "rules",
  };
  return recordToMention(review, sentences, record, treatment);
}

// ---------- records → mentions ----------

export function isEvidenceClass(value: unknown): value is EvidenceClass {
  return typeof value === "string" && (EVIDENCE_CLASSES as readonly string[]).includes(value);
}

/** Builds the mention: quotes come from the cited sentences; review metadata is copied. */
export function recordToMention(review: Review, sentences: Sentence[], record: ClassificationRecord, treatment: Treatment): ClassifiedMention {
  const { quote, quoteTranslated, quoteIsTranslation } = quoteFromSentences(sentences, record.sentenceIds);
  return {
    reviewId: review.reviewId,
    hospitalDataId: review.hospitalDataId,
    cls: record.cls,
    sentenceIds: [...record.sentenceIds],
    quote,
    ...(quoteTranslated ? { quoteTranslated } : {}),
    ...(quoteIsTranslation ? { quoteIsTranslation } : {}),
    amountInr: record.amountInr,
    treatmentMentioned: treatment.id === "general" ? null : record.treatmentsMentioned.includes(treatment.id),
    rating: review.rating,
    isoDate: review.isoDate,
    relativeDate: review.relativeDate,
    link: review.link,
    ownerResponse: review.ownerResponse,
    classifier: record.classifier,
  };
}
