// Turns raw SerpApi JSON into domain objects. Defensive by design: SerpApi
// fields are optional and shapes vary between engines, so every field is
// guarded and malformed items are dropped rather than crashing the run.

import { createHash } from "node:crypto";
import type { Hospital, NewsItem, OwnerResponse, Review, Treatment } from "@/types/domain";
import { splitTranslatedReply, stripReplyMarkers, stripReplySalutation } from "./reply";

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}
function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.replace(/,/g, ""));
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

const EXCLUDED_TYPE_PATTERN =
  /pharmac|chemist|medical store|drug store|diagnostic|laborator|pathology|blood bank|physiotherap|dental|dentist|veterinar|ambulance|insurance|optician|medical supply/i;
// No bare "medical college": many large private hospitals are "… Medical College & Hospital".
// Government colleges are still caught by "Government"/"Govt" in the name or Google's
// "Government hospital" type; a missed badge is the safer error.
const GOVERNMENT_PATTERN =
  /government|govt\.?|सरकारी|राजकीय|district hospital|\b(?:zila|jila)\b|civil hospital|\bgmc\b|aiims|esic|esi hospital|railway hospital|community health cent|primary health cent|\bchc\b|\bphc\b/i;
// Hand-curated for the CITIES presets: government medical colleges whose names don't say "Government".
const KNOWN_GOVT_NAME_PATTERN =
  /patna medical college|nalanda medical college|\bm\.?g\.?m\.? medical college|sawai man singh|\bsms (?:medical college|hospital)\b|king george'?s medical|\bkgmu\b|lala lajpat rai/i;
/** Matches hospital names like "Ayushman Hospital", "Aayushmaan Care". */
export const NAME_COLLISION_PATTERN = /aa?yushmaa?n|आयुष्मान/i;

export interface MapsNormalizeResult {
  hospitals: Hospital[];
  dropped: { name: string; reason: string }[];
}

function toHospital(item: Rec): Hospital | null {
  const dataId = str(item.data_id);
  const name = str(item.title);
  if (!dataId || !name) return null;
  const types = [
    ...arr(item.types).map(str).filter((t): t is string => Boolean(t)),
    ...(str(item.type) ? [str(item.type) as string] : []),
  ];
  const uniqueTypes = [...new Set(types)];
  const gps = isRec(item.gps_coordinates) ? item.gps_coordinates : undefined;
  const placeId = str(item.place_id);
  const cid = str(item.data_cid);
  return {
    dataId,
    placeId,
    name,
    address: str(item.address),
    rating: num(item.rating),
    reviewCount: num(item.reviews),
    types: uniqueTypes,
    lat: gps ? num(gps.latitude) : undefined,
    lng: gps ? num(gps.longitude) : undefined,
    phone: str(item.phone),
    website: str(item.website),
    mapsUrl: placeId
      ? `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(placeId)}`
      : cid
        ? `https://maps.google.com/?cid=${encodeURIComponent(cid)}`
        : undefined,
    // Google's explicit "Private hospital" type wins over the name heuristics.
    isGovernment:
      !uniqueTypes.some((t) => /private hospital/i.test(t)) &&
      (GOVERNMENT_PATTERN.test(`${name} ${uniqueTypes.join(" ")}`) || KNOWN_GOVT_NAME_PATTERN.test(name)),
    nameCollision: NAME_COLLISION_PATTERN.test(name),
  };
}

/** google_maps (type=search) → hospitals that match the treatment's type allowlist, most-reviewed first. */
export function normalizeMapsResults(raw: unknown, treatment: Treatment): MapsNormalizeResult {
  const root = isRec(raw) ? raw : {};
  const items = [
    ...arr(root.local_results),
    // A very specific query can return a single place instead of a list.
    ...(isRec(root.place_results) ? [root.place_results] : []),
  ].filter(isRec);

  const seen = new Set<string>();
  const hospitals: Hospital[] = [];
  const dropped: MapsNormalizeResult["dropped"] = [];

  for (const item of items) {
    const hospital = toHospital(item);
    if (!hospital) {
      dropped.push({ name: str(item.title) ?? "(untitled)", reason: "missing data_id or title" });
      continue;
    }
    if (seen.has(hospital.dataId)) continue;
    seen.add(hospital.dataId);

    const typeText = hospital.types.join(" | ").toLowerCase();
    if (hospital.types.length > 0 && EXCLUDED_TYPE_PATTERN.test(typeText)
        && !treatment.allowedTypeSubstrings.some((s) => typeText.includes(s))) {
      dropped.push({ name: hospital.name, reason: `excluded type: ${hospital.types.join(", ")}` });
      continue;
    }
    const allowed =
      hospital.types.length === 0
        ? /hospital|hospitals|nursing home|medical cent|अस्पताल/i.test(hospital.name)
        : treatment.allowedTypeSubstrings.some((s) => typeText.includes(s));
    if (!allowed) {
      dropped.push({ name: hospital.name, reason: `type not in allowlist: ${hospital.types.join(", ") || "none"}` });
      continue;
    }
    hospitals.push(hospital);
  }

  hospitals.sort((a, b) => (b.reviewCount ?? 0) - (a.reviewCount ?? 0));
  return { hospitals, dropped };
}

/**
 * Hospital reply, like review quotes: original text first, Google's translation
 * kept separately (`textTranslated`), markers never shown, and the leading
 * salutation removed because it usually names the reviewer.
 */
function toOwnerResponse(v: unknown): OwnerResponse | undefined {
  if (!isRec(v)) return undefined;
  const extracted = isRec(v.extracted_snippet) ? v.extracted_snippet : undefined;
  const snippet = str(v.snippet);
  const split = snippet ? splitTranslatedReply(snippet) : null;
  const clean = (s: string | undefined) => (s ? str(stripReplySalutation(s)) : undefined);
  const original = clean((extracted ? str(extracted.original) : undefined) ?? split?.original);
  const translated = clean((extracted ? str(extracted.translated) : undefined) ?? split?.translated);
  const text = original ?? clean(snippet ? stripReplyMarkers(snippet) : undefined) ?? translated;
  if (!text) return undefined;
  return {
    text,
    ...(translated && translated !== text ? { textTranslated: translated } : {}),
    isoDate: str(v.iso_date),
  };
}

function fallbackReviewId(dataId: string, item: Rec): string {
  const basis = [dataId, str(item.link), str(item.iso_date), str(item.date), str(item.snippet)].join("|");
  return "h_" + createHash("sha256").update(basis).digest("hex").slice(0, 20);
}

/** google_maps_reviews → reviews (reviewer identity is deliberately not read). */
export function normalizeReviews(raw: unknown, hospitalDataId: string): Review[] {
  const root = isRec(raw) ? raw : {};
  const out: Review[] = [];
  const seen = new Set<string>();
  for (const item of arr(root.reviews)) {
    if (!isRec(item)) continue;
    const extracted = isRec(item.extracted_snippet) ? item.extracted_snippet : undefined;
    const textOriginal = extracted ? str(extracted.original) : undefined;
    const textTranslated = extracted ? str(extracted.translated) : undefined;
    const text = str(item.snippet) ?? textOriginal ?? textTranslated;
    if (!text) continue; // rating-only reviews carry no evidence
    const reviewId = str(item.review_id) ?? fallbackReviewId(hospitalDataId, item);
    if (seen.has(reviewId)) continue;
    seen.add(reviewId);
    out.push({
      reviewId,
      hospitalDataId,
      rating: num(item.rating),
      isoDate: str(item.iso_date),
      relativeDate: str(item.date),
      text,
      textOriginal,
      textTranslated,
      link: str(item.link),
      ownerResponse: toOwnerResponse(item.response),
    });
  }
  return out;
}

/** Pagination token for the next page of reviews, if any. */
export function reviewsNextPageToken(raw: unknown): string | undefined {
  const root = isRec(raw) ? raw : {};
  const pagination = isRec(root.serpapi_pagination) ? root.serpapi_pagination : undefined;
  return pagination ? str(pagination.next_page_token) : undefined;
}

const NEWS_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4}),\s*(\d{1,2}):(\d{2})\s*(AM|PM)/i;

/** google_news `date` is US-style "MM/DD/YYYY, hh:mm AM, +0000 UTC" → ISO; undefined for anything else. */
export function newsDateToIso(s: string | undefined): string | undefined {
  const m = s ? NEWS_DATE.exec(s) : null;
  if (!m) return undefined;
  const [month, day, year, hour12, minute] = [m[1], m[2], m[3], m[4], m[5]].map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour12 < 1 || hour12 > 12 || minute > 59) return undefined;
  const hour = (hour12 % 12) + (m[6].toUpperCase() === "PM" ? 12 : 0);
  const d = new Date(Date.UTC(year, month - 1, day, hour, minute));
  // Rejects rollover such as 02/31 → 03/03.
  return d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? d.toISOString() : undefined;
}

/** google_news → flat list of headlines, newest first (story clusters and their lead stories flattened). */
export function normalizeNews(raw: unknown, lang: "en" | "hi", limit = 6): NewsItem[] {
  const root = isRec(raw) ? raw : {};
  const flat: Rec[] = [];
  for (const item of arr(root.news_results)) {
    if (!isRec(item)) continue;
    if (str(item.link)) flat.push(item);
    // A cluster's lead article sits in `highlight`, not in `stories`.
    if (isRec(item.highlight) && str(item.highlight.link)) flat.push(item.highlight);
    for (const story of arr(item.stories)) if (isRec(story) && str(story.link)) flat.push(story);
  }
  const seen = new Set<string>();
  const items: NewsItem[] = [];
  for (const item of flat) {
    const link = str(item.link) as string;
    const title = str(item.title);
    if (!title || seen.has(link)) continue;
    seen.add(link);
    const source = isRec(item.source) ? str(item.source.name) : str(item.source);
    const isoDate = str(item.iso_date) ?? newsDateToIso(str(item.date));
    // Raw date text only when it can't be parsed (e.g. "3 hours ago").
    items.push({ title, link, source, isoDate, dateText: isoDate ? undefined : str(item.date), lang });
  }
  // Stable sort: dated items newest first, undated ones keep their order at the end.
  const time = (n: NewsItem) => (n.isoDate ? Date.parse(n.isoDate) : NaN);
  items.sort((a, b) => {
    const ta = time(a);
    const tb = time(b);
    if (Number.isNaN(ta) || Number.isNaN(tb)) return Number(Number.isNaN(ta)) - Number(Number.isNaN(tb));
    return tb - ta;
  });
  return items.slice(0, limit);
}
