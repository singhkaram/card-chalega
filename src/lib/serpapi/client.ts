// Minimal SerpApi HTTP client. Runs on the server only (the key is read from
// process.env and sent as a query parameter, so this must never be bundled
// for the browser). The Next.js entry point `@/lib/serpapi` adds `server-only`;
// this file stays importable from Node scripts (scripts/gate.ts).

export const SERPAPI_BASE_URL = "https://serpapi.com";
const DEFAULT_TIMEOUT_MS = 25_000;

export type SearchParams = Record<string, string | number | undefined>;

export type SerpApiErrorCode = "NO_KEY" | "HTTP" | "API" | "TIMEOUT" | "NETWORK" | "INVALID_JSON";

export class SerpApiError extends Error {
  readonly code: SerpApiErrorCode;
  readonly status?: number;

  constructor(code: SerpApiErrorCode, message: string, status?: number) {
    super(message);
    this.name = "SerpApiError";
    this.code = code;
    this.status = status;
  }
}

export interface SerpApiRequestOptions {
  apiKey?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface SerpApiAccount {
  planName?: string;
  searchesPerMonth?: number;
  planSearchesLeft?: number;
  extraCredits?: number;
  totalSearchesLeft?: number;
  thisMonthUsage?: number;
  thisHourSearches?: number;
  rateLimitPerHour?: number;
}

export function readSerpApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const key = env.SERPAPI_KEY?.trim();
  return key ? key : null;
}

/** Remove every occurrence of the key from a string (defence in depth for error messages). */
export function redactKey(text: string, apiKey: string | null): string {
  if (!apiKey) return text;
  return text.split(apiKey).join("[redacted]");
}

// SerpApi reports "no results" as an error string; for us that is an empty result.
const EMPTY_RESULT_PATTERN = /hasn't returned any (?:results|reviews)|no (?:results|reviews) found|returned no results/i;

export function isEmptyResultError(message: string): boolean {
  return EMPTY_RESULT_PATTERN.test(message);
}

async function getJson(
  path: string,
  query: SearchParams,
  opts: SerpApiRequestOptions,
): Promise<unknown> {
  const apiKey = opts.apiKey ?? readSerpApiKey();
  if (!apiKey) {
    throw new SerpApiError("NO_KEY", "SERPAPI_KEY is not configured on the server.");
  }

  const url = new URL(path, SERPAPI_BASE_URL);
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") url.searchParams.set(name, String(value));
  }
  url.searchParams.set("api_key", apiKey);

  const timeout = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const fetchImpl = opts.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await fetchImpl(url, { signal, headers: { Accept: "application/json" } });
  } catch (err) {
    // Never include the URL (it carries the key) in errors or logs.
    if (timeout.aborted) throw new SerpApiError("TIMEOUT", "SerpApi did not respond in time.");
    if (opts.signal?.aborted) throw new SerpApiError("NETWORK", "Request was cancelled.");
    const reason = err instanceof Error ? err.name : "unknown";
    throw new SerpApiError("NETWORK", `Could not reach SerpApi (${reason}).`);
  }

  const body = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new SerpApiError(res.ok ? "INVALID_JSON" : "HTTP", `SerpApi returned HTTP ${res.status} with a non-JSON body.`, res.status);
  }

  if (json && typeof json === "object" && "error" in json) {
    const message = String((json as { error: unknown }).error ?? "");
    if (isEmptyResultError(message)) return json;
    throw new SerpApiError("API", redactKey(message || "SerpApi reported an error.", apiKey), res.status);
  }
  if (!res.ok) {
    throw new SerpApiError("HTTP", `SerpApi returned HTTP ${res.status}.`, res.status);
  }
  return json;
}

/** One search = one SerpApi credit (unless SerpApi serves it from its own 1h cache). */
export function serpApiSearch(engine: string, params: SearchParams, opts: SerpApiRequestOptions = {}): Promise<unknown> {
  return getJson("/search.json", { ...params, engine, output: "json" }, opts);
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Account API — free, does not consume a search credit. */
export async function getAccountInfo(opts: SerpApiRequestOptions = {}): Promise<SerpApiAccount> {
  const raw = (await getJson("/account.json", {}, opts)) as Record<string, unknown>;
  return {
    planName: typeof raw.plan_name === "string" ? raw.plan_name : undefined,
    searchesPerMonth: num(raw.searches_per_month),
    planSearchesLeft: num(raw.plan_searches_left),
    extraCredits: num(raw.extra_credits),
    totalSearchesLeft: num(raw.total_searches_left),
    thisMonthUsage: num(raw.this_month_usage),
    thisHourSearches: num(raw.this_hour_searches),
    rateLimitPerHour: num(raw.account_rate_limit_per_hour),
  };
}
