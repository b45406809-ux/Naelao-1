// Live-reported: the Space Assistant for a real business flatly claimed `thread.create` "isn't
// supported" — a real, shipped capability. Root-caused by reading the business's actual persisted
// R2 file: `scripts.json` is written ONCE at provision time and nothing re-syncs it when
// profiles.ts later gains a new prebuilt script — that business was provisioned before
// `project-coordination` was added to the Space Assistant's profile, so its persisted `prebuilt`
// list genuinely never had it. This drives the REAL `NaelaoAgentDO.loadAgentConfigHealed` (via a
// cast to reach the private method, the established pattern in this test suite — see
// send-to-thread-orchestration-hook.test.ts), not a reimplementation of its logic.

import { describe, it, expect } from "vitest";
import { NaelaoAgentDO } from "../../workers/agents/src/do/NaelaoAgentDO.js";
import { createDOSqlStorage } from "./helpers/sqlite-do-shim.js";
import { writeAgentConfig, loadAgentConfig } from "../../workers/agents/src/script-engine/agent-config.js";
import { DEFAULT_NAELAO_AGENT, LAUNCHPAD_ASSISTANT_PROFILE } from "../../workers/agents/src/script-engine/profiles.js";
import type { AgentConfig } from "../../workers/agents/src/script-engine/agent-config.js";

function makeR2(): R2Bucket {
  const store = new Map<string, string>();
  return {
    async put(key: string, value: unknown) {
      store.set(key, typeof value === "string" ? value : String(value));
      return {} as R2Object;
    },
    async get(key: string) {
      const v = store.get(key);
      if (v === undefined) return null;
      return { text: async () => v } as unknown as R2ObjectBody;
    },
    async delete() {},
    async list() {
      return { objects: [], truncated: false } as unknown as R2Objects;
    },
  } as unknown as R2Bucket;
}

function makeDO(): NaelaoAgentDO {
  const ctx = { storage: { sql: createDOSqlStorage() }, id: { toString: () => "do-1" } };
  const env = { PLATFORM_SECRET: "test-secret" };
  return new NaelaoAgentDO(ctx as never, env as never);
}

async function callHealed(doInstance: NaelaoAgentDO, bucket: R2Bucket, spaceId: string, agentId: string): Promise<AgentConfig | null> {
  return (
    doInstance as unknown as {
      loadAgentConfigHealed: (bucket: R2Bucket, spaceId: string, agentId: string) => Promise<AgentConfig | null>;
    }
  ).loadAgentConfigHealed(bucket, spaceId, agentId);
}

/** Flush pending microtasks — the self-heal's re-persist is deliberately fire-and-forget (never
 *  blocks the run on an R2 write), so a test asserting the WRITE landed needs to let it settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("NaelaoAgentDO.loadAgentConfigHealed — self-heals a stale Space Assistant prebuilt list", () => {
  it("adds a missing prebuilt script (e.g. project-coordination) to a config persisted before it existed", async () => {
    const bucket = makeR2();
    // Simulates a business provisioned before project-coordination/business-diagnostics were
    // added to the profile — exactly the real "Test 1" business's own persisted shape.
    await writeAgentConfig(bucket, "space-1", "naelao-agent", {
      agentsMd: "", systemPrompt: "sys",
      scripts: { prebuilt: ["r2-workspace", "web-search", "commerce"], startup_observe: "observe_filesystem" },
      skills: { skills: [] },
    });

    const healed = await callHealed(makeDO(), bucket, "space-1", "naelao-agent");
    expect(healed).not.toBeNull();
    expect(healed!.scripts.prebuilt).toContain("project-coordination");
    expect(healed!.scripts.prebuilt).toContain("business-diagnostics");
    // Never removes what was already there.
    expect(healed!.scripts.prebuilt).toContain("commerce");
    expect(healed!.scripts.prebuilt).toContain("r2-workspace");
  });

  it("re-persists the healed config so this only heals once, not on every run", async () => {
    const bucket = makeR2();
    await writeAgentConfig(bucket, "space-1", "naelao-agent", {
      agentsMd: "", systemPrompt: "sys",
      scripts: { prebuilt: ["r2-workspace"], startup_observe: "observe_filesystem" },
      skills: { skills: [] },
    });

    await callHealed(makeDO(), bucket, "space-1", "naelao-agent");
    await flush();

    // A plain, unhealed read now reflects the persisted write.
    const reloaded = await loadAgentConfig(bucket, "space-1", "naelao-agent");
    expect(reloaded!.scripts.prebuilt).toContain("project-coordination");
  });

  it("is a no-op (and does not re-persist) when nothing is actually missing", async () => {
    const bucket = makeR2();
    let putCount = 0;
    const realPut = bucket.put.bind(bucket);
    bucket.put = (async (...args: Parameters<R2Bucket["put"]>) => {
      putCount++;
      return realPut(...args);
    }) as R2Bucket["put"];

    // Already the full current union — a business provisioned with the LATEST profile.
    const fullList = [...new Set([...DEFAULT_NAELAO_AGENT.config.scripts.prebuilt, ...LAUNCHPAD_ASSISTANT_PROFILE.config.scripts.prebuilt])];
    await writeAgentConfig(bucket, "space-1", "naelao-agent", {
      agentsMd: "", systemPrompt: "sys",
      scripts: { prebuilt: fullList, startup_observe: "observe_filesystem" },
      skills: { skills: [] },
    });
    putCount = 0; // reset after the setup write above

    await callHealed(makeDO(), bucket, "space-1", "naelao-agent");
    await flush();
    expect(putCount).toBe(0);
  });

  it("does NOT touch a project-scoped specialist agent (a different agentId) — only the one hardcoded Space Assistant id", async () => {
    const bucket = makeR2();
    await writeAgentConfig(bucket, "space-1", "launchpad-support-v1", {
      agentsMd: "", systemPrompt: "sys",
      scripts: { prebuilt: ["r2-workspace", "knowledge-base"], startup_observe: "observe_filesystem" },
      skills: { skills: [] },
    });

    const healed = await callHealed(makeDO(), bucket, "space-1", "launchpad-support-v1");
    // Untouched — a project agent's deliberately-restricted list (item 130) must never gain
    // workspace-admin/project-coordination just because the Space Assistant's profile has them.
    expect(healed!.scripts.prebuilt).toEqual(["r2-workspace", "knowledge-base"]);
  });

  it("returns null (no throw) when the agent genuinely isn't provisioned", async () => {
    const bucket = makeR2();
    const healed = await callHealed(makeDO(), bucket, "space-1", "naelao-agent");
    expect(healed).toBeNull();
  });
});
