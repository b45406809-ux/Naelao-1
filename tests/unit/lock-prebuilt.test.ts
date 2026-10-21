import { describe, it, expect } from "vitest";
import { ScriptToolSurface } from "../../workers/agents/src/script-engine/tool-surface.js";
import type { ScriptEngineEnv, LockGateway } from "../../workers/agents/src/script-engine/types.js";

// lock — the generic named-lock primitive scripts compose their own concurrency strategies
// on top of (e.g. "lock this CSV row before writing it"). Exercised against a fake
// LockGateway here; NaelaoAgentDO's real ConcurrencyDO-backed wiring is covered by
// concurrency-do.test.ts (the acquire/release/TTL semantics) plus typecheck for the plumbing.

function makeR2(): R2Bucket {
  return {} as unknown as R2Bucket;
}

function makeFakeLockGateway(): LockGateway & { slots: Map<string, { holder: string; limit: number; fencingToken: number }[]> } {
  const slots = new Map<string, { holder: string; limit: number; fencingToken: number }[]>();
  let nextFencingToken = 1;
  return {
    slots,
    async acquire({ key, holderId, limit = 1 }) {
      const holders = slots.get(key) ?? [];
      if (holders.some((h) => h.holder === holderId)) return { granted: true, active: holders.length, limit, fencingToken: holders.find(h => h.holder === holderId)!.fencingToken };
      if (holders.length >= limit) return { granted: false, active: holders.length, limit };
      const fencingToken = nextFencingToken++;
      holders.push({ holder: holderId, limit, fencingToken });
      slots.set(key, holders);
      return { granted: true, active: holders.length, limit, fencingToken };
    },
    async release({ key, holderId, fencingToken }) {
      const holders = (slots.get(key) ?? []).filter((h) => h.holder !== holderId || h.fencingToken !== fencingToken);
      slots.set(key, holders);
    },
    async status(key) {
      return { active: (slots.get(key) ?? []).length };
    },
  };
}

function makeEnv(lockGateway?: LockGateway): ScriptEngineEnv {
  return { scriptsBucket: makeR2(), spaceId: "space1", agentId: "agent-1", tenantId: "tenant-1", ...(lockGateway ? { lockGateway } : {}) };
}

describe("lock prebuilt — acquire/release/status", () => {
  it("grants an exclusive lock (default limit 1), denies a second holder", async () => {
    const gateway = makeFakeLockGateway();
    const tools = new ScriptToolSurface(makeEnv(gateway), ["lock"]);

    const first = await tools.run("lock.acquire", { key: "csv-row:5", holder_id: "thread-a" });
    expect((first.output as { granted: boolean }).granted).toBe(true);

    const second = await tools.run("lock.acquire", { key: "csv-row:5", holder_id: "thread-b" });
    expect((second.output as { granted: boolean }).granted).toBe(false);
  });

  it("release frees the lock for the next holder", async () => {
    const gateway = makeFakeLockGateway();
    const tools = new ScriptToolSurface(makeEnv(gateway), ["lock"]);

    const acquired = await tools.run("lock.acquire", { key: "csv-row:5", holder_id: "thread-a" });
    await tools.run("lock.release", { key: "csv-row:5", holder_id: "thread-a", fencing_token: (acquired.output as { fencingToken: number }).fencingToken });

    const retry = await tools.run("lock.acquire", { key: "csv-row:5", holder_id: "thread-b" });
    expect((retry.output as { granted: boolean }).granted).toBe(true);
  });

  it("lock.status reports the current active count without acquiring anything", async () => {
    const gateway = makeFakeLockGateway();
    const tools = new ScriptToolSurface(makeEnv(gateway), ["lock"]);
    await tools.run("lock.acquire", { key: "csv-row:5", holder_id: "thread-a" });

    const status = await tools.run("lock.status", { key: "csv-row:5" });
    expect((status.output as { active: number }).active).toBe(1);
  });

  it("requires holder_id — a script can't acquire anonymously", async () => {
    const gateway = makeFakeLockGateway();
    const tools = new ScriptToolSurface(makeEnv(gateway), ["lock"]);
    const result = await tools.run("lock.acquire", { key: "csv-row:5" });
    expect(result.ok).toBe(false);
  });

  it("reports itself unavailable (not a silent grant) when no lockGateway is wired", async () => {
    const tools = new ScriptToolSurface(makeEnv(undefined), ["lock"]);
    const result = await tools.run("lock.acquire", { key: "csv-row:5", holder_id: "thread-a" });
    expect((result.output as { granted: boolean; reason?: string }).granted).toBe(false);
    expect((result.output as { reason?: string }).reason).toMatch(/not available/);
  });

  it("a higher limit allows multiple concurrent holders (semaphore, not just mutex)", async () => {
    const gateway = makeFakeLockGateway();
    const tools = new ScriptToolSurface(makeEnv(gateway), ["lock"]);
    const a = await tools.run("lock.acquire", { key: "pool", holder_id: "a", limit: 2 });
    const b = await tools.run("lock.acquire", { key: "pool", holder_id: "b", limit: 2 });
    const c = await tools.run("lock.acquire", { key: "pool", holder_id: "c", limit: 2 });
    expect((a.output as { granted: boolean }).granted).toBe(true);
    expect((b.output as { granted: boolean }).granted).toBe(true);
    expect((c.output as { granted: boolean }).granted).toBe(false);
  });
});
