import { describe, it, expect } from "vitest";
import { checkWindowedQuota, getUsageSummary, recordUsageEvent, invalidateQuotaCache } from "../../workers/billing/src/quota.js";

// Phase 4 (money): checkWindowedQuota is the enforcement counterpart to getUsageSummary — the
// original checkQuota only ever checked the monthly ceiling; this also checks day/week when the
// tier defines one (llm_tokens does; api_calls/infra_credits don't yet), and honors an org's own
// allow_quota_overage toggle (a soft pass instead of a hard block once a real ceiling is crossed).

function makeKv() {
  const store = new Map<string, string>();
  const kv = {
    async get(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
  } as unknown as KVNamespace;
  return { kv, store };
}

/** A fake D1 whose "usage_events" aggregate returns a DIFFERENT sum per window — distinguished by
 *  matching the literal WINDOW_SQL fragment quota.ts embeds directly into the query text (the real
 *  query has no bound param for the window, only for orgId/metric), mirroring how the real SQL
 *  actually differs per window rather than assuming a shape. */
function makeUsageDb(usage: { day: number; week: number; month: number }) {
  const db = {
    prepare(sql: string) {
      return {
        bind() {
          return this;
        },
        async first() {
          if (/start of day/.test(sql)) return { cnt: usage.day };
          if (/-7 days/.test(sql)) return { cnt: usage.week };
          if (/start of month/.test(sql)) return { cnt: usage.month };
          return { cnt: 0 };
        },
      };
    },
  } as unknown as D1Database;
  return db;
}

describe("checkWindowedQuota (Phase 4)", () => {
  it("allows when every configured window (day/week/month) is under its own real limit", async () => {
    const { kv } = makeKv();
    // growth: maxDailyTokens 200_000, maxWeeklyTokens 700_000, maxMonthlyTokens 2_000_000
    const db = makeUsageDb({ day: 1_000, week: 5_000, month: 50_000 });
    const result = await checkWindowedQuota(kv, db, "org1", "llm_tokens", "growth");
    expect(result).toMatchObject({ allowed: true, window: "month", current: 50_000, limit: 2_000_000 });
  });

  it("blocks when the DAILY ceiling alone is breached, even though week/month are fine", async () => {
    const { kv } = makeKv();
    const db = makeUsageDb({ day: 200_000, week: 5_000, month: 50_000 });
    const result = await checkWindowedQuota(kv, db, "org1", "llm_tokens", "growth");
    expect(result).toMatchObject({ allowed: false, window: "day", current: 200_000, limit: 200_000 });
  });

  it("blocks when the WEEKLY ceiling alone is breached", async () => {
    const { kv } = makeKv();
    const db = makeUsageDb({ day: 1_000, week: 700_000, month: 50_000 });
    const result = await checkWindowedQuota(kv, db, "org1", "llm_tokens", "growth");
    expect(result).toMatchObject({ allowed: false, window: "week", current: 700_000, limit: 700_000 });
  });

  it("blocks on the MONTHLY ceiling when day/week are within their own limits", async () => {
    const { kv } = makeKv();
    const db = makeUsageDb({ day: 1_000, week: 5_000, month: 2_000_000 });
    const result = await checkWindowedQuota(kv, db, "org1", "llm_tokens", "growth");
    expect(result).toMatchObject({ allowed: false, window: "month" });
  });

  it("allowOverage=true reports allowed:true + overage:true instead of blocking on a real breach", async () => {
    const { kv } = makeKv();
    const db = makeUsageDb({ day: 200_000, week: 5_000, month: 50_000 });
    const result = await checkWindowedQuota(kv, db, "org1", "llm_tokens", "growth", true);
    expect(result).toMatchObject({ allowed: true, overage: true, window: "day", current: 200_000, limit: 200_000 });
  });

  it("a metric with no dedicated daily/weekly ceiling (infra_credits) only ever checks monthly", async () => {
    const { kv } = makeKv();
    // Even a huge "daily" usage_events sum must not block infra_credits — there is no daily cap
    // for it, only a monthly one (business: maxMonthlyInfraCredits 1_000_000).
    const db = makeUsageDb({ day: 999_999_999, week: 999_999_999, month: 500_000 });
    const result = await checkWindowedQuota(kv, db, "org1", "infra_credits", "business");
    expect(result).toMatchObject({ allowed: true, window: "month", current: 500_000 });
  });

  it("caches each window independently — a cheap D1 stub proves it's not re-querying on a warm cache", async () => {
    const { kv } = makeKv();
    let calls = 0;
    const db = {
      prepare(sql: string) {
        return {
          bind() {
            return this;
          },
          async first() {
            calls++;
            if (/start of day/.test(sql)) return { cnt: 1_000 };
            if (/-7 days/.test(sql)) return { cnt: 5_000 };
            return { cnt: 50_000 };
          },
        };
      },
    } as unknown as D1Database;

    await checkWindowedQuota(kv, db, "org1", "llm_tokens", "growth");
    const callsAfterFirst = calls;
    expect(callsAfterFirst).toBeGreaterThan(0);

    await checkWindowedQuota(kv, db, "org1", "llm_tokens", "growth");
    expect(calls).toBe(callsAfterFirst); // second call served entirely from KV, no new D1 reads
  });
});

describe("recordUsageEvent / invalidateQuotaCache also clear windowed cache keys (Phase 4)", () => {
  it("recordUsageEvent(llm_tokens) drops the day/week/month windowed keys too, not just the monthly one", async () => {
    const { kv, store } = makeKv();
    const db = makeUsageDb({ day: 1_000, week: 5_000, month: 50_000 });
    await checkWindowedQuota(kv, db, "org1", "llm_tokens", "growth");
    expect(store.has("quota:org1:llm_tokens:day")).toBe(true);
    expect(store.has("quota:org1:llm_tokens:week")).toBe(true);
    expect(store.has("quota:org1:llm_tokens:month")).toBe(true);

    await recordUsageEvent(kv, "org1", "llm_tokens");

    expect(store.has("quota:org1:llm_tokens:day")).toBe(false);
    expect(store.has("quota:org1:llm_tokens:week")).toBe(false);
    expect(store.has("quota:org1:llm_tokens:month")).toBe(false);
  });

  it("recordUsageEvent(spaces) does not touch windowed keys — spaces isn't a windowed metric", async () => {
    const { kv, store } = makeKv();
    store.set("quota:org1:llm_tokens:day", "999");
    await recordUsageEvent(kv, "org1", "spaces");
    expect(store.get("quota:org1:llm_tokens:day")).toBe("999");
  });

  it("invalidateQuotaCache clears windowed keys for every windowed metric", async () => {
    const { kv, store } = makeKv();
    const db = makeUsageDb({ day: 1, week: 1, month: 1 });
    await checkWindowedQuota(kv, db, "org1", "llm_tokens", "growth");
    await checkWindowedQuota(kv, db, "org1", "infra_credits", "business");

    await invalidateQuotaCache(kv, "org1");

    expect(store.has("quota:org1:llm_tokens:day")).toBe(false);
    expect(store.has("quota:org1:llm_tokens:month")).toBe(false);
    expect(store.has("quota:org1:infra_credits:month")).toBe(false);
  });
});

describe("getUsageSummary reports each window against its OWN real limit (Phase 4)", () => {
  it("llm_tokens: daily/weekly/monthly each get their own tier-specific ceiling", async () => {
    const db = makeUsageDb({ day: 100, week: 200, month: 300 });
    const summary = await getUsageSummary(db, "org1", "llm_tokens", "growth");
    // growth: maxDailyTokens 200_000, maxWeeklyTokens 700_000, maxMonthlyTokens 2_000_000
    expect(summary.daily).toEqual({ used: 100, limit: 200_000 });
    expect(summary.weekly).toEqual({ used: 200, limit: 700_000 });
    expect(summary.monthly).toEqual({ used: 300, limit: 2_000_000 });
  });

  it("api_calls (no dedicated daily/weekly ceiling) falls back to the monthly limit for every window", async () => {
    const db = makeUsageDb({ day: 10, week: 20, month: 30 });
    const summary = await getUsageSummary(db, "org1", "api_calls", "growth");
    expect(summary.daily.limit).toBe(summary.monthly.limit);
    expect(summary.weekly.limit).toBe(summary.monthly.limit);
  });
});
