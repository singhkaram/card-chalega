import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  AccountFloor,
  authorizeLive,
  clientIp,
  createGuardState,
  DailyCreditCounter,
  readConfig,
  readJsonBody,
  SlidingWindowLimiter,
  type GuardConfig,
} from "@/lib/server/guards";

const HOUR = 3_600_000;

function clock(start = Date.parse("2026-10-04T10:00:00Z")) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const env = (vars: Record<string, string>): NodeJS.ProcessEnv => ({ NODE_ENV: "development", ...vars }) as NodeJS.ProcessEnv;

describe("readConfig", () => {
  it("uses safe defaults", () => {
    const cfg = readConfig(env({}));
    expect(cfg).toEqual({ liveEnabled: false, dailyCreditCap: 40, minCreditsLeft: 15, liveRunsPerIpPerHour: 3, dataMode: "snapshot" });
  });

  it("enables live only with LIVE_SEARCH=on AND a key", () => {
    expect(readConfig(env({ LIVE_SEARCH: "on" })).liveEnabled).toBe(false);
    expect(readConfig(env({ SERPAPI_KEY: "k" })).liveEnabled).toBe(false);
    expect(readConfig(env({ LIVE_SEARCH: "ON", SERPAPI_KEY: "k" })).liveEnabled).toBe(false);
    expect(readConfig(env({ LIVE_SEARCH: "on", SERPAPI_KEY: "  " })).liveEnabled).toBe(false);
    expect(readConfig(env({ LIVE_SEARCH: "on", SERPAPI_KEY: "k" })).liveEnabled).toBe(true);
  });

  it("refuses sample mode in production", () => {
    expect(readConfig(env({ DATA_SOURCE: "sample" })).dataMode).toBe("sample");
    expect(readConfig(env({ DATA_SOURCE: "sample", NODE_ENV: "production" })).dataMode).toBe("snapshot");
  });

  it("parses numeric limits and ignores junk", () => {
    const cfg = readConfig(env({ SERPAPI_DAILY_CREDIT_CAP: "12", SERPAPI_MIN_CREDITS_LEFT: "-3", LIVE_RUNS_PER_IP_PER_HOUR: "abc" }));
    expect(cfg.dailyCreditCap).toBe(12);
    expect(cfg.minCreditsLeft).toBe(15);
    expect(cfg.liveRunsPerIpPerHour).toBe(3);
  });
});

describe("clientIp", () => {
  it("prefers the first x-forwarded-for entry, then x-real-ip", () => {
    expect(clientIp(new Request("http://x", { headers: { "x-forwarded-for": "203.0.113.5, 10.0.0.1" } }))).toBe("203.0.113.5");
    expect(clientIp(new Request("http://x", { headers: { "x-real-ip": "198.51.100.7" } }))).toBe("198.51.100.7");
    expect(clientIp(new Request("http://x"))).toBe("unknown");
  });
});

describe("SlidingWindowLimiter", () => {
  it("allows `limit` hits per window and frees them as they age out", () => {
    const c = clock();
    const l = new SlidingWindowLimiter(HOUR, c.now);
    for (let i = 0; i < 3; i++) {
      expect(l.allows("ip", 3)).toBe(true);
      l.record("ip");
      c.advance(10 * 60_000);
    }
    expect(l.allows("ip", 3)).toBe(false);
    expect(l.allows("other", 3)).toBe(true);
    // First hit was 30 min ago → frees up in 30 min.
    expect(l.retryAfterMs("ip", 3)).toBe(30 * 60_000);
    c.advance(30 * 60_000 + 1);
    expect(l.allows("ip", 3)).toBe(true);
  });

  it("record() returns an idempotent undo for exactly that hit", () => {
    const c = clock();
    const l = new SlidingWindowLimiter(HOUR, c.now);
    l.record("ip");
    const undo = l.record("ip");
    expect(l.allows("ip", 2)).toBe(false);
    undo();
    undo();
    expect(l.allows("ip", 2)).toBe(true);
    expect(l.allows("ip", 1)).toBe(false); // the first hit stays
  });
});

describe("DailyCreditCounter", () => {
  it("reserves within the cap, commits on take, returns the rest on release", () => {
    const c = clock();
    const credits = new DailyCreditCounter(c.now);
    expect(credits.reserve(11, 10)).toBeNull();
    const r = credits.reserve(8, 10);
    expect(r).not.toBeNull();
    expect(credits.reserve(3, 10)).toBeNull(); // only 2 left
    expect(r!.take()).toBe(true);
    expect(r!.take()).toBe(true);
    expect(r!.take()).toBe(true);
    expect(r!.used).toBe(3);
    r!.release();
    r!.release(); // idempotent
    expect(r!.take()).toBe(false);
    expect(credits.usedToday()).toBe(3);
    expect(credits.remaining(10)).toBe(7);
  });

  it("stops at the reservation size", () => {
    const credits = new DailyCreditCounter();
    const r = credits.reserve(1, 40)!;
    expect(r.take()).toBe(true);
    expect(r.take()).toBe(false);
    expect(r.used).toBe(1);
  });

  it("resets at the UTC day boundary", () => {
    const c = clock(Date.parse("2026-10-04T23:30:00Z"));
    const credits = new DailyCreditCounter(c.now);
    const r = credits.reserve(5, 5)!;
    for (let i = 0; i < 5; i++) r.take();
    r.release();
    expect(credits.remaining(5)).toBe(0);
    c.advance(HOUR);
    expect(credits.usedToday()).toBe(0);
    expect(credits.remaining(5)).toBe(5);
  });
});

describe("AccountFloor", () => {
  it("fails closed when the Account API fails or omits the count", async () => {
    const failing = new AccountFloor(() => Promise.reject(new Error("blocked")));
    expect(await failing.check(1, 15, 0)).toEqual({ ok: false, reason: "ACCOUNT_UNAVAILABLE" });
    const blank = new AccountFloor(async () => ({ planName: "free" }));
    expect(await blank.check(1, 15, 0)).toEqual({ ok: false, reason: "ACCOUNT_UNAVAILABLE" });
  });

  it("keeps the floor after the run and memoises for ~60s", async () => {
    const c = clock();
    const fetchAccount = vi.fn(async () => ({ totalSearchesLeft: 30 }));
    const floor = new AccountFloor(fetchAccount, c.now);
    expect(await floor.check(11, 15, 0)).toEqual({ ok: true, creditsLeft: 30 });
    expect(await floor.check(16, 15, 0)).toEqual({ ok: false, reason: "BELOW_FLOOR" });
    // 10 credits spent on this instance since the cached read → 20 left.
    expect(await floor.check(6, 15, 10)).toEqual({ ok: false, reason: "BELOW_FLOOR" });
    expect(await floor.check(5, 15, 10)).toEqual({ ok: true, creditsLeft: 20 });
    expect(fetchAccount).toHaveBeenCalledTimes(1);
    c.advance(61_000);
    await floor.check(1, 15, 10);
    expect(fetchAccount).toHaveBeenCalledTimes(2);
  });

  it("refuses when the run would not fit in SerpApi's hourly limit", async () => {
    const floor = new AccountFloor(async () => ({ totalSearchesLeft: 200, thisHourSearches: 45, rateLimitPerHour: 50 }));
    expect(await floor.check(11, 15, 0)).toEqual({ ok: false, reason: "HOURLY_LIMIT" });
    expect(await floor.check(5, 15, 0)).toEqual({ ok: true, creditsLeft: 200 });
    // Credits spent on this instance since the cached read count against the hour too.
    expect(await floor.check(5, 15, 1)).toEqual({ ok: false, reason: "HOURLY_LIMIT" });
  });

  it("ignores a missing or unusable hourly limit and checks the monthly count", async () => {
    const missing = new AccountFloor(async () => ({ totalSearchesLeft: 200, thisHourSearches: 45 }));
    expect(await missing.check(11, 15, 0)).toEqual({ ok: true, creditsLeft: 200 });
    const zero = new AccountFloor(async () => ({ totalSearchesLeft: 200, thisHourSearches: 45, rateLimitPerHour: 0 }));
    expect(await zero.check(11, 15, 0)).toEqual({ ok: true, creditsLeft: 200 });
  });
});

describe("authorizeLive", () => {
  const cfg: GuardConfig = { liveEnabled: true, dailyCreditCap: 40, minCreditsLeft: 15, liveRunsPerIpPerHour: 3, dataMode: "snapshot" };
  const rich = async () => ({ totalSearchesLeft: 1000 });

  it("refuses when live is off or in sample mode", async () => {
    const s = createGuardState({ fetchAccount: rich });
    expect((await authorizeLive("ip", 11, { ...cfg, liveEnabled: false }, s)).ok).toBe(false);
    const sample = await authorizeLive("ip", 11, { ...cfg, dataMode: "sample" }, s);
    expect(sample).toMatchObject({ ok: false, code: "NOT_AVAILABLE_OFFLINE" });
  });

  it("rate-limits per IP and counts only authorised runs", async () => {
    const s = createGuardState({ fetchAccount: rich });
    for (let i = 0; i < 3; i++) {
      const d = await authorizeLive("1.2.3.4", 1, cfg, s);
      expect(d.ok).toBe(true);
      if (d.ok) d.budget.release();
    }
    expect(await authorizeLive("1.2.3.4", 1, cfg, s)).toMatchObject({ ok: false, code: "RATE_LIMITED" });
    expect((await authorizeLive("5.6.7.8", 1, cfg, s)).ok).toBe(true);
  });

  it("enforces the daily cap", async () => {
    const s = createGuardState({ fetchAccount: rich });
    const first = await authorizeLive("a", 11, { ...cfg, dailyCreditCap: 20 }, s);
    expect(first.ok).toBe(true);
    expect(await authorizeLive("b", 11, { ...cfg, dailyCreditCap: 20 }, s)).toMatchObject({ ok: false, code: "CREDIT_CAP" });
    if (first.ok) first.budget.release(); // nothing taken → all 20 back
    expect((await authorizeLive("b", 11, { ...cfg, dailyCreditCap: 20 }, s)).ok).toBe(true);
  });

  it("refuses below the Account API floor without consuming the IP slot or credits", async () => {
    const s = createGuardState({ fetchAccount: async () => ({ totalSearchesLeft: 20 }) });
    expect(await authorizeLive("ip", 11, cfg, s)).toMatchObject({ ok: false, code: "CREDIT_CAP" });
    expect(s.credits.remaining(cfg.dailyCreditCap)).toBe(40);
    expect(s.limiter.allows("ip", 1)).toBe(true);
  });

  it("counts credits reserved by other in-flight runs against the floor", async () => {
    // 30 left, floor 15: only one 11-credit run fits.
    const s = createGuardState({ fetchAccount: async () => ({ totalSearchesLeft: 30 }) });
    const [a, b] = await Promise.all([authorizeLive("a", 11, cfg, s), authorizeLive("b", 11, cfg, s)]);
    expect([a, b].filter((d) => d.ok)).toHaveLength(1);
    expect([a, b].find((d) => !d.ok)).toMatchObject({ ok: false, code: "CREDIT_CAP" });
    const first = a.ok ? a : b;
    if (!first.ok) throw new Error("expected one authorised run");

    // Awaited one at a time, the outstanding reservation still counts.
    expect(await authorizeLive("c", 11, cfg, s)).toMatchObject({ ok: false, code: "CREDIT_CAP" });

    // Overlap: 2 of the first run's credits spent, 9 still reserved → 30 - 2 - (9 + 11) = 8 < 15.
    first.budget.take();
    first.budget.take();
    expect(await authorizeLive("d", 11, cfg, s)).toMatchObject({ ok: false, code: "CREDIT_CAP" });
    // The refused run's reservation went back: 40 - 2 committed - 9 reserved.
    expect(s.credits.remaining(40)).toBe(29);

    // Once the first run ends, the floor sees only what it spent (30 - 2 - 11 = 17 ≥ 15).
    first.budget.release();
    const next = await authorizeLive("e", 11, cfg, s);
    expect(next.ok).toBe(true);
    if (next.ok) next.budget.release();
  });

  it("refuses a run the floor allowed earlier once those credits are spent", async () => {
    const s = createGuardState({ fetchAccount: async () => ({ totalSearchesLeft: 30 }) });
    const first = await authorizeLive("a", 11, cfg, s);
    if (!first.ok) throw new Error("expected the first run to be authorised");
    for (let i = 0; i < 11; i++) first.budget.take();
    first.budget.release();
    // 19 left, and 19 - 11 < 15.
    expect(await authorizeLive("b", 11, cfg, s)).toMatchObject({ ok: false, code: "CREDIT_CAP" });
  });

  it("holds the per-IP limit for a parallel burst while the Account API is slow", async () => {
    let answer: (a: { totalSearchesLeft: number }) => void = () => undefined;
    const pending = new Promise<{ totalSearchesLeft: number }>((r) => (answer = r));
    const s = createGuardState({ fetchAccount: () => pending });
    const decisions = Array.from({ length: 10 }, () => authorizeLive("1.1.1.1", 1, cfg, s));
    answer({ totalSearchesLeft: 1000 });
    const settled = await Promise.all(decisions);
    expect(settled.filter((d) => d.ok)).toHaveLength(3);
    expect(settled.filter((d) => !d.ok && d.code === "RATE_LIMITED")).toHaveLength(7);
    for (const d of settled) if (d.ok) d.budget.release();
  });

  it("explains a refusal caused by SerpApi's hourly limit", async () => {
    const s = createGuardState({ fetchAccount: async () => ({ totalSearchesLeft: 500, thisHourSearches: 50, rateLimitPerHour: 50 }) });
    const d = await authorizeLive("ip", 11, cfg, s);
    expect(d).toMatchObject({ ok: false, code: "CREDIT_CAP", message: expect.stringContaining("hourly limit") });
    expect(s.credits.remaining(cfg.dailyCreditCap)).toBe(40);
    expect(s.limiter.allows("ip", 1)).toBe(true);
  });
});

describe("readJsonBody", () => {
  const schema = z.strictObject({ city: z.enum(["lucknow"]) });
  const req = (body: string, type = "application/json") =>
    new Request("http://x/api", { method: "POST", headers: { "content-type": type }, body });

  it("accepts a valid small JSON body", async () => {
    expect(await readJsonBody(req('{"city":"lucknow"}'), schema)).toEqual({ ok: true, data: { city: "lucknow" } });
  });

  it("rejects wrong content type, oversize, bad JSON and extra keys", async () => {
    expect(await readJsonBody(req('{"city":"lucknow"}', "text/plain"), schema)).toEqual({ ok: false, status: 415 });
    expect(await readJsonBody(req(JSON.stringify({ city: "lucknow", pad: "x".repeat(3000) })), schema)).toEqual({ ok: false, status: 413 });
    expect(await readJsonBody(req("{nope"), schema)).toEqual({ ok: false, status: 400 });
    expect(await readJsonBody(req('{"city":"lucknow","x":1}'), schema)).toEqual({ ok: false, status: 400 });
    expect(await readJsonBody(req('{"city":"delhi"}'), schema)).toEqual({ ok: false, status: 400 });
  });
});
