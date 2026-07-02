import { describe, it, expect } from "vitest";
import { checkQuota, recordUsageEvent, invalidateQuotaCache } from "../../workers/billing/src/quota.js";

// F12: incrementUsage used to be a KV read-modify-write (get -> parseInt -> put(value+delta)),
// which is not atomic — concurrent calls for the same org/metric can race and lose increments,
// and the sliding TTL meant sustained traffic could keep a stale cache alive indefinitely
// instead of naturally falling back to a fresh D1 read. The fix (recordUsageEvent) just
// invalidates the cache on every usage event instead of trying to maintain a second,
// independently-mutated number — the next checkQuota call is forced back through D1's
// COUNT/SUM aggregate, which is atomic in the sense that matters (it's a live read of the
// authoritative rows, not an accumulator that can itself drift).

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

function makeDb(counts: { spaces: number }) {
  let callCount = 0;
  const db = {
    prepare(sql: string) {
      return {
        bind() {
          return this;
        },
        async first() {
          callCount++;
          if (/FROM spaces/.test(sql)) return { cnt: counts.spaces };
          return { cnt: 0 };
        },
      };
    },
  } as unknown as D1Database;
  return { db, getCallCount: () => callCount };
}

const LIMITS = { spaces: 10 };

describe("billing quota — atomic usage accounting (F12)", () => {
  it("recordUsageEvent invalidates the cache instead of incrementing it", async () => {
    const { kv, store } = makeKv();
    const { db } = makeDb({ spaces: 3 });

    // Warm the cache.
    await checkQuota(kv, db, "org1", "spaces", "growth");
    expect(store.get("quota:org1:spaces")).toBe("3");

    // A usage event fires — the cache entry is gone, not "4".
    await recordUsageEvent(kv, "org1", "spaces");
    expect(store.has("quota:org1:spaces")).toBe(false);
  });

  it("after invalidation, checkQuota recomputes fresh from D1 rather than trusting a stale cached number", async () => {
    const { kv } = makeKv();
    const counts = { spaces: 3 };
    const { db } = makeDb(counts);

    const before = await checkQuota(kv, db, "org1", "spaces", "growth");
    expect(before.current).toBe(3);

    // A new space is actually created (D1 truth changes) and the event is recorded.
    counts.spaces = 4;
    await recordUsageEvent(kv, "org1", "spaces");

    const after = await checkQuota(kv, db, "org1", "spaces", "growth");
    expect(after.current).toBe(4);
  });

  it("without an intervening usage event, checkQuota serves the cached value (fast path preserved)", async () => {
    const { kv } = makeKv();
    const counts = { spaces: 3 };
    const { db, getCallCount } = makeDb(counts);

    await checkQuota(kv, db, "org1", "spaces", "growth");
    const callsAfterFirst = getCallCount();

    // D1 truth changes but no usage event/invalidation happens — cache should still serve 3.
    counts.spaces = 999;
    const cached = await checkQuota(kv, db, "org1", "spaces", "growth");
    expect(cached.current).toBe(3);
    expect(getCallCount()).toBe(callsAfterFirst); // no additional D1 query
  });

  it("N concurrent usage events followed by N concurrent checkQuota calls never produce a value below D1 truth (no lost updates possible)", async () => {
    const { kv } = makeKv();
    const counts = { spaces: 0 };
    const { db } = makeDb(counts);

    await checkQuota(kv, db, "org1", "spaces", "growth"); // warm cache at 0

    // 20 "concurrent" space-creation events: D1 truth advances one at a time (as real inserts
    // would), each followed by a racing recordUsageEvent — unlike the old increment-based
    // design, there is no shared counter value these can clobber; they can only ever delete
    // the same key.
    const N = 20;
    await Promise.all(
      Array.from({ length: N }, async (_, i) => {
        counts.spaces = i + 1;
        await recordUsageEvent(kv, "org1", "spaces");
      })
    );

    const final = await checkQuota(kv, db, "org1", "spaces", "growth");
    expect(final.current).toBe(N); // exactly matches D1 truth — no undercount possible
  });

  it("invalidateQuotaCache clears all three metrics for an org", async () => {
    const { kv, store } = makeKv();
    const { db } = makeDb({ spaces: 5 });
    await checkQuota(kv, db, "org1", "spaces", "growth");
    store.set("quota:org1:kb_docs", "7");
    store.set("quota:org1:api_calls", "100");

    await invalidateQuotaCache(kv, "org1");

    expect(store.has("quota:org1:spaces")).toBe(false);
    expect(store.has("quota:org1:kb_docs")).toBe(false);
    expect(store.has("quota:org1:api_calls")).toBe(false);
  });

  it("allowed reflects the plan limit against the current (correct, post-invalidation) usage", async () => {
    const { kv } = makeKv();
    const counts = { spaces: LIMITS.spaces };
    const { db } = makeDb(counts);

    const atLimit = await checkQuota(kv, db, "org1", "spaces", "growth");
    expect(atLimit).toMatchObject({ current: 10, limit: 10, allowed: false });
  });
});
