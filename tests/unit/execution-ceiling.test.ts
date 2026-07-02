import { describe, it, expect, beforeEach } from "vitest";
import { ScriptToolSurface } from "../../workers/agents/src/script-engine/tool-surface.js";
import type { ScriptEngineEnv } from "../../workers/agents/src/script-engine/types.js";

// Customer-bot projects cap which execution tiers their bound agent may use
// (SpaceDO `projects.execution_ceiling` → ScriptEngineEnv.maxTier). This is the structural
// guarantee behind "not a full agent executing stuff without us knowing" — a restricted
// project's reasoner cannot talk its way past it; the gate is in the tool surface, not a
// prompt.

function makeR2(): R2Bucket {
  const store = new Map<string, string>();
  const bucket = {
    async put(key: string, value: unknown) {
      store.set(key, typeof value === "string" ? value : String(value));
      return {} as R2Object;
    },
    async get(key: string) {
      if (!store.has(key)) return null;
      const text = store.get(key)!;
      return { size: text.length, uploaded: new Date(), async text() { return text; }, get body() { return text; } } as unknown as R2ObjectBody;
    },
    async head(key: string) {
      return store.has(key) ? ({} as R2Object) : null;
    },
    async delete(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
    },
    async list(opts?: { prefix?: string }) {
      const prefix = opts?.prefix ?? "";
      const objects = [...store.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ key: k, size: store.get(k)!.length, uploaded: new Date(), etag: "x" }));
      return { objects, truncated: false, cursor: undefined } as unknown as R2Objects;
    },
  };
  return bucket as unknown as R2Bucket;
}

describe("execution ceiling — script.create / script.update", () => {
  let env: ScriptEngineEnv;
  beforeEach(() => {
    env = { scriptsBucket: makeR2(), spaceId: "space-1", agentId: "agent-1", tenantId: "tenant-1", maxTier: 2 };
  });

  it("allows authoring a script at or below the ceiling", async () => {
    const tools = new ScriptToolSurface(env, []);
    await expect(
      tools.create({ name: "lookup", code: "x", metadata: { description: "d", domain: "compute", requires_tier: 2 } })
    ).resolves.toBeDefined();
  });

  it("rejects authoring a script above the ceiling (Tier 5 container on a Tier-2 project)", async () => {
    const tools = new ScriptToolSurface(env, []);
    await expect(
      tools.create({ name: "shell-out", code: "x", metadata: { description: "d", domain: "container", requires_tier: 5 } })
    ).rejects.toThrow(/execution ceiling/);
  });

  it("rejects raising an existing script's tier above the ceiling via update", async () => {
    const tools = new ScriptToolSurface(env, []);
    await tools.create({ name: "s", code: "x", metadata: { description: "d", domain: "compute", requires_tier: 1 } });
    await expect(tools.update("s", { metadata: { requires_tier: 4 } }, "needs browser now")).rejects.toThrow(/execution ceiling/);
  });

  it("retroactively blocks updating an already-too-high-tier script once the ceiling is lowered", async () => {
    const unrestricted: ScriptEngineEnv = { ...env, maxTier: undefined };
    const tools = new ScriptToolSurface(unrestricted, []);
    await tools.create({ name: "browse", code: "x", metadata: { description: "d", domain: "browser", requires_tier: 4 } });

    // Same script library, now viewed through a restricted (ceiling=2) tool surface — as
    // would happen if an admin lowers a project's ceiling after scripts already exist.
    const restricted = new ScriptToolSurface(env, []);
    await expect(restricted.update("browse", { code: "y" }, "tweak")).rejects.toThrow(/execution ceiling/);
  });

  it("no ceiling (unrestricted project) allows any tier", async () => {
    const unrestricted: ScriptEngineEnv = { ...env, maxTier: undefined };
    const tools = new ScriptToolSurface(unrestricted, []);
    await expect(
      tools.create({ name: "shell-out", code: "x", metadata: { description: "d", domain: "container", requires_tier: 5 } })
    ).resolves.toBeDefined();
  });
});

describe("execution ceiling — script.run", () => {
  it("blocks running a prebuilt op above the ceiling without crashing (returns ok:false)", async () => {
    const env: ScriptEngineEnv = { scriptsBucket: makeR2(), spaceId: "s", agentId: "a", tenantId: "t", maxTier: 1 };
    // notifications is Tier 2 — above a Tier-1 ceiling.
    const tools = new ScriptToolSurface(env, ["notifications"]);
    const result = await tools.run("notify.email", { to: "x@example.com", subject: "s", body: "b" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/execution ceiling/);
  });

  it("blocks running a stored script above the ceiling", async () => {
    const env: ScriptEngineEnv = { scriptsBucket: makeR2(), spaceId: "s", agentId: "a", tenantId: "t" }; // unrestricted at create time
    const tools = new ScriptToolSurface(env, []);
    await tools.create({ name: "deep-task", code: "export async function run(){}", metadata: { description: "d", domain: "container", requires_tier: 5 } });

    const restricted = new ScriptToolSurface({ ...env, maxTier: 2 }, []);
    const result = await restricted.run("deep-task", {});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/execution ceiling/);
  });

  it("allows running within the ceiling", async () => {
    const env: ScriptEngineEnv = { scriptsBucket: makeR2(), spaceId: "s", agentId: "a", tenantId: "t", maxTier: 2 };
    const tools = new ScriptToolSurface(env, ["notifications"]);
    const result = await tools.run("notify.email", { to: "x@example.com", subject: "s", body: "b" });
    // No notificationsWorker bound → "delivered: false, reason: ..." but it's still ok:true
    // (the call was allowed through; delivery itself degrades honestly elsewhere).
    expect(result.ok).toBe(true);
  });
});
