// Live-reported: the Space Assistant for a real Space flatly claimed `thread.create` "isn't
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
import { UNIVERSAL_AGENT_BASELINE_PREBUILTS } from "../../workers/agents/src/script-engine/agent-topology.js";
import type { AgentConfig } from "../../workers/agents/src/script-engine/agent-config.js";

function makeR2(): R2Bucket {
  const store = new Map<string, { bytes: Uint8Array; etag: string; customMetadata?: Record<string, string> }>();
  let sequence = 0;
  return {
    async put(key: string, value: unknown, options?: R2PutOptions) {
      const current = store.get(key);
      const condition = options?.onlyIf as { etagMatches?: string; etagDoesNotMatch?: string } | undefined;
      if (condition?.etagMatches && current?.etag !== condition.etagMatches) return null;
      if (condition?.etagDoesNotMatch === "*" && current) return null;
      const bytes = value instanceof Uint8Array ? value.slice() : new TextEncoder().encode(String(value));
      const etag = `e${++sequence}`;
      store.set(key, { bytes, etag, customMetadata: options?.customMetadata });
      return { etag } as R2Object;
    },
    async get(key: string) {
      const object = store.get(key);
      if (!object) return null;
      const bytes = object.bytes.slice();
      return {
        size: bytes.byteLength, etag: object.etag, customMetadata: object.customMetadata,
        async arrayBuffer() { return bytes.slice().buffer; },
        async text() { return new TextDecoder().decode(bytes); },
      } as unknown as R2ObjectBody;
    },
    async head(key: string) {
      const object = store.get(key);
      return object ? { size: object.bytes.byteLength, etag: object.etag, customMetadata: object.customMetadata } as R2Object : null;
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
  return new Promise((resolve) => setTimeout(resolve, 25));
}

describe("NaelaoAgentDO.loadAgentConfigHealed — self-heals a stale Space Assistant prebuilt list", () => {
  it("adds a missing prebuilt script (e.g. project-coordination) to a config persisted before it existed", async () => {
    const bucket = makeR2();
    // Simulates a Space provisioned before project-coordination was added to the profile.
    await writeAgentConfig(bucket, "space-1", "naelao-agent", {
      agentsMd: "", systemPrompt: "sys",
      scripts: { prebuilt: ["r2-workspace", "web-search", "commerce"], startup_observe: "observe_filesystem" },
      skills: { skills: [] },
    });

    const healed = await callHealed(makeDO(), bucket, "space-1", "naelao-agent");
    expect(healed).not.toBeNull();
    expect(healed!.scripts.prebuilt).toContain("project-coordination");
    expect(healed!.scripts.prebuilt).not.toContain("business-diagnostics");
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

    // Already the full current union — a Space provisioned with the current profile.
    const fullList = [...new Set([
      ...DEFAULT_NAELAO_AGENT.config.scripts.prebuilt,
      ...LAUNCHPAD_ASSISTANT_PROFILE.config.scripts.prebuilt,
      ...UNIVERSAL_AGENT_BASELINE_PREBUILTS,
    ])];
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
    // Specialist-specific permissions remain untouched; the universal planner/execution baseline
    // is added independently of the Space Assistant profile.
    expect(healed!.scripts.prebuilt).toEqual([...new Set(["r2-workspace", "knowledge-base", ...UNIVERSAL_AGENT_BASELINE_PREBUILTS])]);
  });

  it("recovers a missing Space Assistant config from the current launchpad profile", async () => {
    const bucket = makeR2();
    const healed = await callHealed(makeDO(), bucket, "space-1", "naelao-agent");
    expect(healed?.scripts.prebuilt).toContain("project-coordination");
    expect(healed?.scripts.prebuilt).not.toContain("business-diagnostics");
  });
});
