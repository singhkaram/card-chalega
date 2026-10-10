// Shared domain contracts. Every module (pipeline, classifier, scoring, UI)
// builds against these types — change them deliberately.

export const CITY_IDS = ["ghaziabad", "lucknow", "patna", "indore", "jaipur"] as const;
export type CityId = (typeof CITY_IDS)[number];

export const TREATMENT_IDS = [
  "general",
  "dialysis",
  "cataract",
  "delivery",
  "knee-replacement",
  "angioplasty",
] as const;
export type TreatmentId = (typeof TREATMENT_IDS)[number];

export interface City {
  id: CityId;
  name: string;
  nameHi: string;
  state: string;
  lat: number;
  lng: number;
  /** Google Maps zoom used in the `ll` parameter, e.g. 13 → "@lat,lng,13z". */
  zoom: number;
}

export interface Treatment {
  id: TreatmentId;
  label: string;
  labelHi: string;
  /** Text sent as `q` to the google_maps engine. */
  mapsQuery: string;
  /** Lower-case substrings; a listing qualifies if any of its Maps types contains one. */
  allowedTypeSubstrings: string[];
  /** Lower-case keywords (Latin + Devanagari) used to detect treatment-specific mentions. */
  keywords: string[];
}

/** Where a piece of data came from — always shown to the user. */
// "sample" = synthetic dev-only data (refused in production, always bannered in the UI).
export type DataSource = "live" | "cache" | "snapshot" | "sample";

export interface Hospital {
  dataId: string;
  placeId?: string;
  name: string;
  address?: string;
  rating?: number;
  reviewCount?: number;
  types: string[];
  lat?: number;
  lng?: number;
  phone?: string;
  website?: string;
  /** Google Maps link for the place (built from place_id / data_id). */
  mapsUrl?: string;
  isGovernment: boolean;
  /** Hospital's own name contains "Ayushman" — mentions need scheme context to count. */
  nameCollision: boolean;
}

export interface OwnerResponse {
  /** The hospital's reply in its original language, without Google's translation markers. */
  text: string;
  /** Google's translation of the reply, when Google provided one. */
  textTranslated?: string;
  isoDate?: string;
}

/** A Google Maps review returned by the in-review "ayushman" query. No reviewer identity is ever stored. */
export interface Review {
  reviewId: string;
  hospitalDataId: string;
  rating?: number;
  isoDate?: string;
  /** SerpApi's relative date string, e.g. "3 months ago". */
  relativeDate?: string;
  /** Review text as shown by Google (may contain "(Translated by Google)" markers). */
  text: string;
  textOriginal?: string;
  textTranslated?: string;
  link?: string;
  ownerResponse?: OwnerResponse;
}

/** Numbered sentence used for grounding: the LLM cites ids, code assembles quotes. */
export interface Sentence {
  id: number;
  text: string;
  lang: "original" | "translated";
}

export const EVIDENCE_CLASSES = [
  "CASHLESS_OK",
  "CHARGED_FOR_PACKAGE_ITEMS",
  "CHARGED_OUTSIDE_PACKAGE_OR_UNCLEAR",
  "REFUSED",
  "ELIGIBILITY_OR_SPECIALTY_DISPUTE",
  "DELAY",
  "NOT_PMJAY",
  "NAME_COLLISION",
  "MENTION_ONLY",
] as const;
export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];

/** Classes that count toward "asked to pay or turned away". */
export const PROBLEM_CLASSES: readonly EvidenceClass[] = ["CHARGED_FOR_PACKAGE_ITEMS", "REFUSED"];
/** Classes excluded from n (not about the PM-JAY scheme at this hospital). */
export const EXCLUDED_CLASSES: readonly EvidenceClass[] = ["NOT_PMJAY", "NAME_COLLISION"];

export type ClassifierKind = "llm" | "rules";

export interface ClassifiedMention {
  reviewId: string;
  hospitalDataId: string;
  cls: EvidenceClass;
  /** Ids into the review's sentence list; validated in code. */
  sentenceIds: number[];
  /** Assembled by code from sentenceIds — never written by the LLM. */
  quote: string;
  /** Translated quote (if the cited sentences have a Google translation). */
  quoteTranslated?: string;
  /** True when only Google-translated sentences were cited: quote is the translation, not the reviewer's words. */
  quoteIsTranslation?: true;
  /** Accepted only if the digits appear in the cited sentences. */
  amountInr: number | null;
  treatmentMentioned: boolean | null;
  rating?: number;
  isoDate?: string;
  relativeDate?: string;
  link?: string;
  ownerResponse?: OwnerResponse;
  classifier: ClassifierKind;
}

export type EvidenceLabel =
  | "too_few_reports"
  | "more_problem_reports"
  | "more_cashless_reports"
  | "mixed_reports";

export interface HospitalScore {
  dataId: string;
  /** Mentions about PM-JAY at this hospital (excludes NOT_PMJAY / NAME_COLLISION), within the window. */
  n: number;
  counts: Record<EvidenceClass, number>;
  problemCount: number;
  cashlessOkCount: number;
  /** Mean star rating of qualifying mentions; null when n < MIN_N_FOR_RATING. */
  ayushmanRating: number | null;
  overallRating: number | null;
  /** ayushmanRating − city median; null when either side is unavailable. */
  deltaVsCityMedian: number | null;
  label: EvidenceLabel;
  treatmentMentions: { k: number; n: number };
  latestReportIso: string | null;
  /** Sum of rupee amounts quoted in problem mentions (null if none). */
  amountsInr: number[];
}

export interface CityBaseline {
  medianAyushmanRating: number | null;
  hospitalsWithRating: number;
  hospitalsConsidered: number;
}

export interface NewsItem {
  title: string;
  source?: string;
  link: string;
  isoDate?: string;
  dateText?: string;
  lang: "en" | "hi";
}

export interface HospitalResult {
  hospital: Hospital;
  mentions: ClassifiedMention[];
  score: HospitalScore;
  reviewsFetchedAt: string;
  source: DataSource;
  /**
   * Google returned a next page for this hospital's in-review query: more
   * matching reviews exist than the one page read. Optional so older
   * snapshots and payloads stay valid.
   */
  moreReviews?: boolean;
}

/** NDJSON events streamed by POST /api/check (one JSON object per line). */
export type CheckEvent =
  | {
      type: "meta";
      city: CityId;
      treatment: TreatmentId;
      mode: "live" | "snapshot" | "sample";
      llm: boolean;
      startedAt: string;
    }
  | { type: "progress"; step: "maps" | "reviews" | "classify" | "score" | "news"; message: string; done?: number; total?: number }
  | { type: "hospitals"; hospitals: Hospital[]; source: DataSource; fetchedAt: string }
  | { type: "hospital"; result: HospitalResult }
  | { type: "baseline"; baseline: CityBaseline; scores: HospitalScore[] }
  | { type: "news"; items: NewsItem[]; source: DataSource; fetchedAt: string }
  | { type: "done"; creditsUsed: number; source: DataSource; oldestFetchedAt: string | null; durationMs: number }
  | { type: "error"; code: CheckErrorCode; message: string };

export type CheckErrorCode =
  | "INVALID_INPUT"
  | "NOT_AVAILABLE_OFFLINE"
  | "RATE_LIMITED"
  | "CREDIT_CAP"
  | "UPSTREAM"
  | "NO_RESULTS"
  | "INTERNAL";

/** GET /api/status — public, contains no secrets. */
export interface StatusResponse {
  liveEnabled: boolean;
  llmEnabled: boolean;
  /** "sample" only in development with DATA_SOURCE=sample. */
  dataMode: "snapshot" | "sample";
  combos: { city: CityId; treatment: TreatmentId; fetchedAt: string; hospitals: number }[];
}

/** POST /api/refresh {city, treatment, dataId} — 1-credit live refresh of one hospital. */
export type RefreshResponse =
  | { ok: true; result: HospitalResult; creditsUsed: number }
  | { ok: false; code: CheckErrorCode; message: string };
