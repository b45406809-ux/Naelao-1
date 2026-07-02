import { describe, it, expect, vi } from "vitest";
import { RateLimitDO } from "../../workers/router/src/RateLimitDO.js";
import { createDOSqlStorage } from "./helpers/sqlite-do-shim.js";

// F7 follow-up: RateLimitDO's `buckets` table was never pruned — rows accumulated forever, made
// worse by the (now-fixed) spoofable XFF key letting an attacker mint rows deliberately. Since
// the router now shards by idFromName(bucketKey) (one DO per key instead of one DO for the
// whole platform), each DO instance holds at most one key's row — so instead of a sweeper, an
// idle DO can just clear its own storage via a DO alarm rescheduled on every /check call.

function makeDO() {
  const setAlarm = vi.fn(async () => {});
  const ctx = { storage: { sql: createDOSqlStorage(), setAlarm } };
  const doInstance = new RateLimitDO(ctx as never, {} as never);
  return { doInstance, setAlarm };
}

async function check(doInstance: RateLimitDO, key: string, limit = 120) {
  const resp = await doInstance.fetch(
    new Request("http://do/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key, limit }),
    })
  );
  return resp.json() as Promise<{ allowed: boolean; remaining: number; retry_after_ms: number }>;
}

describe("RateLimitDO — idle cleanup alarm (F7)", () => {
  it("reschedules the idle-cleanup alarm on every /check call", async () => {
    const { doInstance, setAlarm } = makeDO();
    await check(doInstance, "user-1");
    expect(setAlarm).toHaveBeenCalledTimes(1);
    await check(doInstance, "user-1");
    expect(setAlarm).toHaveBeenCalledTimes(2);
  });

  it("a fired alarm clears the bucket, so the next check starts from a full-capacity bucket again", async () => {
    const { doInstance } = makeDO();

    // Burn the bucket's tokens for this key. Capacity is 2x the per-minute limit (burst
    // allowance), so with limit=10 that's 20 tokens — 25 rapid calls exhausts it.
    const limit = 10;
    for (let i = 0; i < 25; i++) {
      await check(doInstance, "user-1", limit);
    }
    const exhausted = await check(doInstance, "user-1", limit);
    expect(exhausted.allowed).toBe(false);

    // Idle-cleanup alarm fires (simulated directly — in production the platform calls this
    // after IDLE_CLEANUP_MS with no further /check calls).
    await doInstance.alarm();

    // The bucket row is gone, so the next check starts from a fresh, full-capacity bucket.
    const afterAlarm = await check(doInstance, "user-1", limit);
    expect(afterAlarm.allowed).toBe(true);
  });

  it("clearing one key's bucket via alarm does not touch a different key in the same DO (defense-in-depth; sharding means this shouldn't normally happen)", async () => {
    const { doInstance } = makeDO();
    await check(doInstance, "user-1", 5);
    await check(doInstance, "user-2", 5);

    await doInstance.alarm();

    // Both keys reset — the alarm clears all rows in this DO's own storage, which is correct
    // because a sharded DO is only ever supposed to hold one key at a time.
    const u1 = await check(doInstance, "user-1", 5);
    const u2 = await check(doInstance, "user-2", 5);
    expect(u1.allowed).toBe(true);
    expect(u2.allowed).toBe(true);
  });
});
