import { describe, it, expect, beforeEach } from "vitest";
import { ConcurrencyDO } from "../../workers/agents/src/do/ConcurrencyDO.js";
import { createDOSqlStorage } from "./helpers/sqlite-do-shim.js";

// ConcurrencyDO (spec §28) — account-level concurrency ceiling. Exercises the real DO over a
// real in-memory SQLite engine, including the alarm-driven stale-slot sweep (spec gap
// "ConcurrencyDO — Deadlock Scenario": a crashed holder must not leak its slot forever).

function makeConcurrencyDO(): ConcurrencyDO {
  let alarmAt: number | null = null;
  const ctx = {
    storage: {
      sql: createDOSqlStorage(),
      async getAlarm() {
        return alarmAt;
      },
      async setAlarm(t: number) {
        alarmAt = t;
      },
    },
  };
  return new ConcurrencyDO(ctx as never, {} as never);
}

async function call(doInstance: ConcurrencyDO, path: string, method: string, body?: unknown): Promise<{ status: number; json: any }> {
  const resp = await doInstance.fetch(
    new Request(`http://concurrency-do${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  );
  const json = await resp.json().catch(() => null);
  return { status: resp.status, json };
}

describe("ConcurrencyDO — account-level concurrency ceiling", () => {
  let doInstance: ConcurrencyDO;

  beforeEach(() => {
    doInstance = makeConcurrencyDO();
  });

  it("grants slots up to the limit, then denies the next", async () => {
    const a = await call(doInstance, "/acquire", "POST", { key: "tree:space1", holder_id: "run-a", limit: 2 });
    expect(a.json.granted).toBe(true);
    const b = await call(doInstance, "/acquire", "POST", { key: "tree:space1", holder_id: "run-b", limit: 2 });
    expect(b.json.granted).toBe(true);
    const c = await call(doInstance, "/acquire", "POST", { key: "tree:space1", holder_id: "run-c", limit: 2 });
    expect(c.json.granted).toBe(false);
    expect(c.json.active).toBe(2);
  });

  it("release frees a slot for the next acquire", async () => {
    await call(doInstance, "/acquire", "POST", { key: "tree:space1", holder_id: "run-a", limit: 1 });
    const denied = await call(doInstance, "/acquire", "POST", { key: "tree:space1", holder_id: "run-b", limit: 1 });
    expect(denied.json.granted).toBe(false);

    await call(doInstance, "/release", "POST", { key: "tree:space1", holder_id: "run-a" });
    const granted = await call(doInstance, "/acquire", "POST", { key: "tree:space1", holder_id: "run-b", limit: 1 });
    expect(granted.json.granted).toBe(true);
  });

  it("re-acquiring the same (key, holder_id) is idempotent, not counted twice", async () => {
    await call(doInstance, "/acquire", "POST", { key: "tree:space1", holder_id: "run-a", limit: 1 });
    const again = await call(doInstance, "/acquire", "POST", { key: "tree:space1", holder_id: "run-a", limit: 1 });
    expect(again.json.granted).toBe(true);
    expect(again.json.active).toBe(1);
  });

  it("different keys (spaces) don't share a limit", async () => {
    await call(doInstance, "/acquire", "POST", { key: "tree:space1", holder_id: "run-a", limit: 1 });
    const otherSpace = await call(doInstance, "/acquire", "POST", { key: "tree:space2", holder_id: "run-b", limit: 1 });
    expect(otherSpace.json.granted).toBe(true);
  });

  it("a slot whose TTL has expired is reclaimed automatically on the next acquire (deadlock fix)", async () => {
    await call(doInstance, "/acquire", "POST", { key: "tree:space1", holder_id: "run-a", limit: 1, ttl_ms: -1 });
    // ttl_ms: -1 means expires_at is already in the past — the crashed-holder scenario.
    const status = await call(doInstance, "/status?key=tree:space1", "GET");
    expect(status.json.active).toBe(1); // still counted until the next sweep runs

    const granted = await call(doInstance, "/acquire", "POST", { key: "tree:space1", holder_id: "run-b", limit: 1 });
    expect(granted.json.granted).toBe(true); // inline sweep in acquire() reclaimed the stale slot
  });

  it("the alarm handler sweeps expired slots across all keys", async () => {
    await call(doInstance, "/acquire", "POST", { key: "tree:space1", holder_id: "run-a", limit: 5, ttl_ms: -1 });
    await call(doInstance, "/acquire", "POST", { key: "tree:space2", holder_id: "run-b", limit: 5, ttl_ms: -1 });
    await doInstance.alarm();
    const s1 = await call(doInstance, "/status?key=tree:space1", "GET");
    const s2 = await call(doInstance, "/status?key=tree:space2", "GET");
    expect(s1.json.active).toBe(0);
    expect(s2.json.active).toBe(0);
  });

  it("rejects acquire without key or holder_id", async () => {
    const bad = await call(doInstance, "/acquire", "POST", { key: "tree:space1" });
    expect(bad.status).toBe(400);
  });
});
