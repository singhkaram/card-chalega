import { createHash } from "node:crypto";
import type { City, Treatment } from "@/types/domain";
import type { SearchParams } from "./client";

export type SerpEngine = "google_maps" | "google_maps_reviews" | "google_news";

export interface SerpRequest {
  engine: SerpEngine;
  params: SearchParams;
}

/** The in-review search term: only reviews mentioning the scheme are returned. */
export const REVIEWS_QUERY = "ayushman";

export function mapsSearchRequest(city: City, treatment: Treatment): SerpRequest {
  return {
    engine: "google_maps",
    params: {
      type: "search",
      q: treatment.mapsQuery,
      ll: `@${city.lat},${city.lng},${city.zoom}z`,
      hl: "en",
    },
  };
}

/**
 * Only one page (≤20) of reviews is fetched and n uses a 24-month window, so
 * newest-first returns the most in-window mentions. SerpApi's default is
 * "qualityScore" (most relevant), which can surface years-old reviews.
 */
export const REVIEWS_SORT = "newestFirst";

export interface ReviewsRequestOptions {
  query?: string;
  /** Defaults to REVIEWS_SORT. */
  sortBy?: "qualityScore" | "newestFirst" | "ratingHigh" | "ratingLow";
  /** 1–20; whether it may be combined with `query` on the first page is checked by the gate script. */
  num?: number;
  nextPageToken?: string;
}

export function reviewsRequest(dataId: string, opts: ReviewsRequestOptions = {}): SerpRequest {
  return {
    engine: "google_maps_reviews",
    params: {
      data_id: dataId,
      query: opts.query ?? REVIEWS_QUERY,
      sort_by: opts.sortBy ?? REVIEWS_SORT,
      num: opts.num,
      next_page_token: opts.nextPageToken,
      hl: "en",
    },
  };
}

export function newsRequest(city: City, lang: "en" | "hi"): SerpRequest {
  return {
    engine: "google_news",
    params: {
      q: lang === "en" ? `Ayushman card hospital ${city.name}` : `आयुष्मान कार्ड अस्पताल ${city.nameHi}`,
      gl: "in",
      hl: lang,
    },
  };
}

function stableParams(params: SearchParams): [string, string][] {
  return Object.entries(params)
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined && entry[1] !== "")
    .map(([k, v]): [string, string] => [k, String(v)])
    .sort(([a], [b]) => a.localeCompare(b));
}

/** Deterministic cache key for a request (never includes the API key). */
export function requestKey(req: SerpRequest): string {
  const canonical = JSON.stringify([req.engine, stableParams(req.params)]);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 24);
}

/** Params as stored alongside snapshots — undefined values dropped, no api_key. */
export function storableParams(params: SearchParams): Record<string, string> {
  return Object.fromEntries(stableParams(params).filter(([k]) => k !== "api_key"));
}
