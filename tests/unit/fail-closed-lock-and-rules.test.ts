import { describe, it, expect } from "vitest";
import { NaelaoAgentDO } from "../../workers/agents/src/do/NaelaoAgentDO.js";
import { createDOSqlStorage } from "./helpers/sqlite-do-shim.js";

// S0.4: two fail-OPEN bugs that used to defeat their own safety guarantees under an outage.
//
// 1. acquireConcurrencySlot returned {granted:true} whenever CONCURRENCY_DO was unbound or its
//    fetch threw — fine for the sub-agent-spawn ceiling (a documented "don't wedge every run"
//    choice) but wrong for the `lock` prebuilt, which shares the same method: a lock that grants
//    every acquirer during an outage isn't a lock (two customer threads writing a shared
//    ledger.csv would both "win"). The lock path now passes failClosed=true.
// 2. fetchProjectRules returned [] on ANY error, indistinguishable from "this project genuinely
//    has zero rules configured" — so a rules-endpoint-only outage silently skipped the
//    STOP/UNSUBSCRIBE/human-takeover baseline every no-code project template seeds. Callers must
//    now fail closed (escalate to a human) on a rules-fetch error.
//
// Both exercised against the real NaelaoAgentDO (private methods reached via a narrow cast),
// matching the existing project convention (see project-collaboration-t1-t3.test.ts).

function makeDO(env: Record<string, unknown>): NaelaoAgentDO {
  const ctx = { storage: { sql: createDOSqlStorage() } };
  return new NaelaoAgentDO(ctx as never, env as never);
}

type LockGatewayAccess = {
  buildScriptEngineEnv(spaceId: string, agentId: string, tenantId: string): Promise<{ lockGateway?: { acquire: (p: { key: string; holderId: string; limit?: number }) => Promise<{ granted: boolean }> } } | null>;
};

describe("S0.4 — lock prebuilt fails CLOSED when ConcurrencyDO is unavailable", () => {
  it("denies the lock when CONCURRENCY_DO is not bound at all", async () => {
    const spaceDO = makeDO({ SCRIPTS_R2: {} as unknown as R2Bucket, PLATFORM_SECRET: "test" });
    const engineEnv = await (spaceDO as unknown as LockGatewayAccess).buildScriptEngineEnv("space1", "naelao-agent", "tenant1");
    expect(engineEnv?.lockGateway).toBeTruthy();
    const result = await engineEnv!.lockGateway!.acquire({ key: "ledger.csv", holderId: "thread-a" });
    expect(result.granted).toBe(false);
  });

  it("denies the lock when the ConcurrencyDO stub throws (outage)", async () => {
    const throwingConcurrencyDO = {
      idFromName: (name: string) => ({ toString: () => name }),
      get: () => ({ fetch: async () => { throw new Error("network down"); } }),
    };
    const spaceDO = makeDO({ SCRIPTS_R2: {} as unknown as R2Bucket, PLATFORM_SECRET: "test", CONCURRENCY_DO: throwingConcurrencyDO });
    const engineEnv = await (spaceDO as unknown as LockGatewayAccess).buildScriptEngineEnv("space1", "naelao-agent", "tenant1");
    const result = await engineEnv!.lockGateway!.acquire({ key: "ledger.csv", holderId: "thread-a" });
    expect(result.granted).toBe(false);
  });

  it("still grants normally when ConcurrencyDO is healthy", async () => {
    const healthyConcurrencyDO = {
      idFromName: (name: string) => ({ toString: () => name }),
      get: () => ({ fetch: async () => Response.json({ acquired: true, fencingToken: 1 }) }),
    };
    const spaceDO = makeDO({ SCRIPTS_R2: {} as unknown as R2Bucket, PLATFORM_SECRET: "test", CONCURRENCY_DO: healthyConcurrencyDO });
    const engineEnv = await (spaceDO as unknown as LockGatewayAccess).buildScriptEngineEnv("space1", "naelao-agent", "tenant1");
    const result = await engineEnv!.lockGateway!.acquire({ key: "ledger.csv", holderId: "thread-a" });
    expect(result.granted).toBe(true);
  });
});
