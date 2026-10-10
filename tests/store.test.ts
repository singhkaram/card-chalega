import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CITIES, TREATMENTS } from "@/config/presets";
import { mapsSearchRequest, requestKey, reviewsRequest, SerpApiError, SNAPSHOT_VERSION, type SnapshotEntry } from "@/lib/serpapi";
import { NO_BUDGET, type CreditBudget } from "@/lib/server/guards";
import { clearMemory, isInMemory, readIndex, resolve, StoreError } from "@/lib/server/store";

const mocks = vi.hoisted(() => ({
  serpApiSearch: vi.fn<(engine: string, params: Record<string, unknown>, opts?: { signal?: AbortSignal; timeoutMs?: number }) => Promise<unknown>>(),
  readSnapshotEntry: vi.fn<(key: string) => Promise<unknown>>(),
}));

// No network: the SerpApi client is stubbed; snapshot reads are controllable.
vi.mock("@/lib/serpapi/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/serpapi/client")>()),
  serpApiSearch: mocks.serpApiSearch,
}));
vi.mock("@/lib/serpapi/snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/serpapi/snapshot")>()),
  readSnapshotEntry: mocks.readSnapshotEntry,
}));

function budget(n: number): CreditBudget & { used: number } {
  let left = n;
  const b = {
    used: 0,
    take() {
      if (left <= 0) return false;
      left -= 1;
      b.used += 1;
      return true;
    },
  };
  return b;
}

const mapsReq = mapsSearchRequest(CITIES.lucknow, TREATMENTS.general);
const reviewsReq = reviewsRequest("0x1:0x2", { num: 20 });

beforeEach(() => {
  clearMemory();
  mocks.serpApiSearch.mockReset();
  mocks.readSnapshotEntry.mockReset();
  mocks.readSnapshotEntry.mockResolvedValue(null);
  vi.stubEnv("SERPAPI_KEY", "test-key-123");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("store.resolve", () => {
  it("goes live once, then serves the memory copy as 'cache'", async () => {
    mocks.serpApiSearch.mockResolvedValue({ reviews: [{ snippet: "x", user: { name: "Someone" } }] });
    const b = budget(5);
    const first = await resolve(reviewsReq, { allowLive: true, budget: b, mode: "snapshot" });
    expect(first.source).toBe("live");
    expect(first.key).toBe(requestKey(reviewsReq));
    // Reviewer identity is stripped before caching.
    expect(JSON.stringify(first.response)).not.toContain("Someone");

    const second = await resolve(reviewsReq, { allowLive: true, budget: b, mode: "snapshot" });
    expect(second.source).toBe("cache");
    expect(second.fetchedAt).toBe(first.fetchedAt);
    expect(mocks.serpApiSearch).toHaveBeenCalledTimes(1);
    expect(b.used).toBe(1);
    expect(isInMemory(first.key)).toBe(true);
  });

  it("prefer:'live' skips memory and snapshots", async () => {
    mocks.serpApiSearch.mockResolvedValue({ reviews: [] });
    const b = budget(5);
    await resolve(reviewsReq, { allowLive: true, budget: b, mode: "snapshot" });
    const again = await resolve(reviewsReq, { allowLive: true, budget: b, mode: "snapshot", prefer: "live" });
    expect(again.source).toBe("live");
    expect(mocks.serpApiSearch).toHaveBeenCalledTimes(2);
  });

  it("reads snapshot entries (by explicit index key) without spending credits", async () => {
    const entry: SnapshotEntry = {
      version: SNAPSHOT_VERSION,
      key: "abcdef0123456789abcdef01",
      engine: "google_maps",
      params: {},
      fetchedAt: "2026-10-01T10:00:00.000Z",
      response: { local_results: [] },
    };
    mocks.readSnapshotEntry.mockImplementation(async (key: string) => (key === entry.key ? entry : null));
    const res = await resolve(mapsReq, { allowLive: false, budget: NO_BUDGET, key: entry.key, mode: "snapshot" });
    expect(res).toEqual({ response: entry.response, fetchedAt: entry.fetchedAt, source: "snapshot", key: entry.key });
    expect(mocks.serpApiSearch).not.toHaveBeenCalled();
  });

  it("ignores a snapshot entry recorded for a different engine", async () => {
    mocks.readSnapshotEntry.mockResolvedValue({
      version: SNAPSHOT_VERSION, key: requestKey(mapsReq), engine: "google_news", params: {}, fetchedAt: "2026-10-01T10:00:00Z", response: {},
    });
    await expect(resolve(mapsReq, { allowLive: false, budget: NO_BUDGET, mode: "snapshot" })).rejects.toMatchObject({ code: "NOT_AVAILABLE_OFFLINE" });
  });

  it("reads synthetic sample entries in sample mode and labels them 'sample'", async () => {
    const res = await resolve(mapsReq, { allowLive: false, budget: NO_BUDGET, mode: "sample" });
    expect(res.source).toBe("sample");
    expect(res.fetchedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(JSON.stringify(res.response)).toContain("(Sample)");
  });

  it("refuses live without allowLive", async () => {
    const b = budget(5);
    const err = await resolve(reviewsReq, { allowLive: false, budget: b, mode: "snapshot" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreError);
    expect((err as StoreError).code).toBe("NOT_AVAILABLE_OFFLINE");
    expect(b.used).toBe(0);
    expect(mocks.serpApiSearch).not.toHaveBeenCalled();
  });

  it("never goes live in sample mode, even when allowed", async () => {
    await expect(resolve(reviewsReq, { allowLive: true, budget: budget(5), mode: "sample" })).rejects.toMatchObject({ code: "NOT_AVAILABLE_OFFLINE" });
    expect(mocks.serpApiSearch).not.toHaveBeenCalled();
  });

  it("throws CREDIT_CAP when the budget is exhausted", async () => {
    mocks.serpApiSearch.mockResolvedValue({ reviews: [] });
    const b = budget(1);
    await resolve(reviewsReq, { allowLive: true, budget: b, mode: "snapshot" });
    const other = reviewsRequest("0x3:0x4", { num: 20 });
    await expect(resolve(other, { allowLive: true, budget: b, mode: "snapshot" })).rejects.toMatchObject({ code: "CREDIT_CAP" });
    expect(mocks.serpApiSearch).toHaveBeenCalledTimes(1);
  });

  it("maps SerpApi failures to UPSTREAM without leaking the upstream message", async () => {
    mocks.serpApiSearch.mockRejectedValue(new SerpApiError("API", "Invalid key test-key-123 for https://serpapi.com/search?api_key=test-key-123"));
    const err = await resolve(reviewsReq, { allowLive: true, budget: budget(1), mode: "snapshot" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreError);
    expect((err as StoreError).code).toBe("UPSTREAM");
    expect((err as StoreError).message).not.toMatch(/test-key|serpapi\.com/);
    expect(isInMemory(requestKey(reviewsReq))).toBe(false);
  });

  it("names SerpApi's hourly limit (HTTP 429) in the UPSTREAM message", async () => {
    mocks.serpApiSearch.mockRejectedValue(new SerpApiError("API", "Your account has run out of searches per hour.", 429));
    const err = await resolve(reviewsReq, { allowLive: true, budget: budget(1), mode: "snapshot" }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "UPSTREAM", message: expect.stringContaining("hourly limit") });
  });

  it("passes a request-time timeout and the caller's signal to the client", async () => {
    mocks.serpApiSearch.mockResolvedValue({ reviews: [] });
    const controller = new AbortController();
    await resolve(reviewsReq, { allowLive: true, budget: budget(1), mode: "snapshot", signal: controller.signal });
    expect(mocks.serpApiSearch).toHaveBeenCalledWith("google_maps_reviews", expect.any(Object), { signal: controller.signal, timeoutMs: 15_000 });
  });
});

describe("store.readIndex", () => {
  it("reads the sample index (same SnapshotIndex format)", async () => {
    const index = await readIndex("sample");
    expect(index?.version).toBe(SNAPSHOT_VERSION);
    expect(Object.keys(index?.combos ?? {}).sort()).toEqual(["lucknow:general", "patna:dialysis"]);
    expect(index?.combos["lucknow:general"].hospitals).toHaveLength(8);
    expect(index?.combos["patna:dialysis"].hospitals).toHaveLength(6);
  });
});
