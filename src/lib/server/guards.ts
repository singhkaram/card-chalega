// Abuse and credit guards for live SerpApi use.
//
// The limiter and the daily counter live in process memory, so on serverless
// hosting they are per instance (a cold start resets them, parallel instances
// do not share them). The Account API floor is the global backstop: it reads
// the real remaining credits from SerpApi and refuses live runs below the floor.
import "server-only";

import type { ZodType } from "zod";
import { getAccountInfo, readSerpApiKey, type SerpApiAccount } from "@/lib/serpapi";

const HOUR_MS = 3_600_000;
const ACCOUNT_TTL_MS = 60_000;
/** A failed Account API call is remembered briefly so a burst does not hammer it. */
const ACCOUNT_FAILURE_TTL_MS = 15_000;
const MAX_TRACKED_IPS = 10_000;

// ---------- config ----------

export type DataMode = "snapshot" | "sample";

export interface GuardConfig {
  /** LIVE_SEARCH === "on" and SERPAPI_KEY present. */
  liveEnabled: boolean;
  dailyCreditCap: number;
  minCreditsLeft: number;
  liveRunsPerIpPerHour: number;
  /** "sample" only outside production (synthetic data is never served in prod). */
  dataMode: DataMode;
}

function intEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): GuardConfig {
  const sampleRequested = env.DATA_SOURCE?.trim() === "sample";
  return {
    liveEnabled: env.LIVE_SEARCH?.trim() === "on" && readSerpApiKey(env) !== null,
    dailyCreditCap: intEnv(env.SERPAPI_DAILY_CREDIT_CAP, 40),
    minCreditsLeft: intEnv(env.SERPAPI_MIN_CREDITS_LEFT, 15),
    liveRunsPerIpPerHour: intEnv(env.LIVE_RUNS_PER_IP_PER_HOUR, 3),
    dataMode: sampleRequested && env.NODE_ENV !== "production" ? "sample" : "snapshot",
  };
}

// ---------- client IP ----------

/** Best-effort client IP from proxy headers (set by the hosting platform); "unknown" otherwise. */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  if (first) return first.slice(0, 64);
  const real = request.headers.get("x-real-ip")?.trim();
  return real ? real.slice(0, 64) : "unknown";
}

// ---------- request body ----------

export type BodyResult<T> = { ok: true; data: T } | { ok: false; status: 400 | 413 | 415 };

/**
 * Reads a small JSON body and validates it. Requiring a JSON content type means
 * cross-site pages cannot send it without a CORS preflight (which we never grant).
 * The size limit is enforced while streaming, not trusted from Content-Length.
 */
export async function readJsonBody<T>(request: Request, schema: ZodType<T>, maxBytes = 2048): Promise<BodyResult<T>> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(type.trim())) return { ok: false, status: 415 };
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, status: 413 };
  if (!request.body) return { ok: false, status: 400 };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, status: 413 };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }

  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return { ok: false, status: 400 };
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, status: 400 };
}

// ---------- per-IP sliding window ----------

export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly windowMs: number = HOUR_MS,
    private readonly now: () => number = Date.now,
  ) {}

  private recent(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length === 0) this.hits.delete(key);
    else this.hits.set(key, list);
    return list;
  }

  /** Whether another hit is allowed, without recording one. */
  allows(key: string, limit: number): boolean {
    return this.recent(key).length < limit;
  }

  /** Ms until the oldest hit in the window expires (0 if a hit is allowed now). */
  retryAfterMs(key: string, limit: number): number {
    const list = this.recent(key);
    if (list.length < limit) return 0;
    return Math.max(0, list[list.length - limit] + this.windowMs - this.now());
  }

  /** Records a hit; the returned function removes exactly this hit again (idempotent). */
  record(key: string): () => void {
    const t = this.now();
    const list = this.recent(key);
    list.push(t);
    this.hits.set(key, list);
    if (this.hits.size > MAX_TRACKED_IPS) this.prune();
    let undone = false;
    return () => {
      if (undone) return;
      undone = true;
      const l = this.hits.get(key);
      const i = l ? l.lastIndexOf(t) : -1;
      if (!l || i < 0) return;
      l.splice(i, 1);
      if (l.length === 0) this.hits.delete(key);
    };
  }

  private prune(): void {
    for (const key of [...this.hits.keys()]) this.recent(key);
    // Still too many distinct IPs: drop the oldest-inserted ones.
    for (const key of this.hits.keys()) {
      if (this.hits.size <= MAX_TRACKED_IPS) break;
      this.hits.delete(key);
    }
  }
}

// ---------- daily credit counter ----------

/** What the store needs to spend credits: one take() per live SerpApi call. */
export interface CreditBudget {
  /** Claims one credit; false when the budget is exhausted (no call may be made). */
  take(): boolean;
  /** Credits claimed so far. */
  readonly used: number;
}

/** A budget that never allows a live call (snapshot / sample / cached runs). */
export const NO_BUDGET: CreditBudget = { take: () => false, used: 0 };

export interface CreditReservation extends CreditBudget {
  /** Returns unclaimed credits to the daily pool. Idempotent. */
  release(): void;
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export class DailyCreditCounter {
  private day: string;
  private committed = 0;
  private reserved = 0;
  /** Monotonic count of credits ever committed (not reset daily); used by the account floor. */
  totalCommitted = 0;

  constructor(private readonly now: () => number = Date.now) {
    this.day = utcDay(now());
  }

  private roll(): void {
    const today = utcDay(this.now());
    if (today !== this.day) {
      this.day = today;
      this.committed = 0; // outstanding reservations still hold their credits
    }
  }

  usedToday(): number {
    this.roll();
    return this.committed;
  }

  /** Credits reserved by in-flight runs on this instance but not yet spent. */
  outstanding(): number {
    return this.reserved;
  }

  remaining(cap: number): number {
    this.roll();
    return Math.max(0, cap - this.committed - this.reserved);
  }

  /** Holds `n` credits for a run; null if that would exceed today's cap. */
  reserve(n: number, cap: number): CreditReservation | null {
    if (!Number.isInteger(n) || n < 1 || this.remaining(cap) < n) return null;
    this.reserved += n;
    let left = n;
    let used = 0;
    let released = false;
    return {
      take: () => {
        if (released || left <= 0) return false;
        this.roll();
        left -= 1;
        used += 1;
        this.reserved -= 1;
        this.committed += 1;
        this.totalCommitted += 1;
        return true;
      },
      get used() {
        return used;
      },
      release: () => {
        if (released) return;
        released = true;
        this.reserved -= left;
        left = 0;
      },
    };
  }
}

// ---------- Account API floor ----------

export type FloorResult =
  | { ok: true; creditsLeft: number }
  | { ok: false; reason: "ACCOUNT_UNAVAILABLE" | "BELOW_FLOOR" | "HOURLY_LIMIT" };

type AccountSnapshot =
  // `hourLeft` is set only when the Account API reported a usable hourly limit.
  | { at: number; ok: true; left: number; hourLeft?: number; committedAtFetch: number }
  | { at: number; ok: false };

/** Searches left this hour; undefined when the fields are missing or odd, so they never block a run. */
function hourlyHeadroom(a: SerpApiAccount): number | undefined {
  const { rateLimitPerHour: limit, thisHourSearches: used } = a;
  return typeof limit === "number" && limit > 0 && typeof used === "number" ? limit - used : undefined;
}

export class AccountFloor {
  private cached: AccountSnapshot | null = null;
  private inflight: Promise<AccountSnapshot> | null = null;

  constructor(
    private readonly fetchAccount: () => Promise<SerpApiAccount>,
    private readonly now: () => number = Date.now,
  ) {}

  private async snapshot(committedNow: number): Promise<AccountSnapshot> {
    const c = this.cached;
    const ttl = c?.ok ? ACCOUNT_TTL_MS : ACCOUNT_FAILURE_TTL_MS;
    if (c && this.now() - c.at < ttl) return c;
    this.inflight ??= this.fetchAccount()
      .then((a): AccountSnapshot => {
        const left = a.totalSearchesLeft;
        // A missing count is treated like a failure: never spend blind.
        return typeof left === "number"
          ? { at: this.now(), ok: true, left, hourLeft: hourlyHeadroom(a), committedAtFetch: committedNow }
          : { at: this.now(), ok: false };
      })
      .catch((): AccountSnapshot => ({ at: this.now(), ok: false }))
      .finally(() => {
        this.inflight = null;
      });
    this.cached = await this.inflight;
    return this.cached;
  }

  /**
   * Fails closed: refuses unless the Account API answered and, after spending
   * `needed` credits, at least `minLeft` would remain. `needed` is every credit
   * reserved on this instance and not yet spent, the caller's own run included,
   * so concurrent runs see each other. Credits committed on this instance since
   * the (memoised) fetch are subtracted from the cached count. When SerpApi
   * reports an hourly limit, `needed` must also fit in what is left this hour.
   */
  async check(needed: number, minLeft: number, committedNow: number): Promise<FloorResult> {
    const s = await this.snapshot(committedNow);
    if (!s.ok) return { ok: false, reason: "ACCOUNT_UNAVAILABLE" };
    const spent = Math.max(0, committedNow - s.committedAtFetch);
    if (s.hourLeft !== undefined && s.hourLeft - spent < needed) return { ok: false, reason: "HOURLY_LIMIT" };
    const left = s.left - spent;
    return left - needed >= minLeft ? { ok: true, creditsLeft: left } : { ok: false, reason: "BELOW_FLOOR" };
  }
}

// ---------- process-wide guard state (per serverless instance) ----------

export interface GuardState {
  limiter: SlidingWindowLimiter;
  credits: DailyCreditCounter;
  floor: AccountFloor;
}

export function createGuardState(deps: { now?: () => number; fetchAccount?: () => Promise<SerpApiAccount> } = {}): GuardState {
  const now = deps.now ?? Date.now;
  return {
    limiter: new SlidingWindowLimiter(HOUR_MS, now),
    credits: new DailyCreditCounter(now),
    floor: new AccountFloor(deps.fetchAccount ?? (() => getAccountInfo({ timeoutMs: 8_000 })), now),
  };
}

let state: GuardState | null = null;

export function guardState(): GuardState {
  state ??= createGuardState();
  return state;
}

/** Test hook: replace (or reset with null) the process-wide guard state. */
export function setGuardStateForTests(next: GuardState | null): void {
  state = next;
}

// ---------- the one decision the routes need ----------

export type LiveDecision =
  | { ok: true; budget: CreditReservation }
  | { ok: false; code: "NOT_AVAILABLE_OFFLINE" | "RATE_LIMITED" | "CREDIT_CAP"; message: string };

const FLOOR_MESSAGES: Record<Extract<FloorResult, { ok: false }>["reason"], string> = {
  ACCOUNT_UNAVAILABLE: "Live search is paused: the search budget could not be verified. Pre-fetched cities still work.",
  BELOW_FLOOR: "Live search is paused to protect the remaining search credits. Pre-fetched cities still work.",
  HOURLY_LIMIT: "Live search has reached the search service's hourly limit. Try again later, or pick a pre-fetched city.",
};

/**
 * Authorises a run that will spend up to `estimatedCredits` live credits:
 * live switch → per-IP limit → daily cap (reserves) → Account API floor.
 * The IP hit is recorded before the async floor check (so a parallel burst
 * sees it) and rolled back, with the reservation, if the floor refuses.
 * The caller must release() the reservation when the run ends.
 */
export async function authorizeLive(
  ip: string,
  estimatedCredits: number,
  cfg: GuardConfig = readConfig(),
  s: GuardState = guardState(),
): Promise<LiveDecision> {
  if (!cfg.liveEnabled || cfg.dataMode === "sample") {
    return { ok: false, code: "NOT_AVAILABLE_OFFLINE", message: "Live search is turned off on this server." };
  }
  if (!s.limiter.allows(ip, cfg.liveRunsPerIpPerHour)) {
    const mins = Math.ceil(s.limiter.retryAfterMs(ip, cfg.liveRunsPerIpPerHour) / 60_000);
    return {
      ok: false,
      code: "RATE_LIMITED",
      message: `Live searches are limited to ${cfg.liveRunsPerIpPerHour} per hour. Try again in about ${Math.max(1, mins)} min, or pick a pre-fetched city.`,
    };
  }
  const budget = s.credits.reserve(estimatedCredits, cfg.dailyCreditCap);
  if (!budget) {
    return { ok: false, code: "CREDIT_CAP", message: "Today's live-search budget is used up. Pre-fetched cities still work." };
  }
  const undoHit = s.limiter.record(ip);
  // Both counters are read in this tick; outstanding() already includes this run's reservation.
  const floor = await s.floor.check(s.credits.outstanding(), cfg.minCreditsLeft, s.credits.totalCommitted);
  if (!floor.ok) {
    budget.release();
    undoHit();
    return { ok: false, code: "CREDIT_CAP", message: FLOOR_MESSAGES[floor.reason] };
  }
  return { ok: true, budget };
}
