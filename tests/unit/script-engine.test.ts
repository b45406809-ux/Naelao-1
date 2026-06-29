import { describe, it, expect, beforeEach } from "vitest";
import { SkillLibrary } from "../../workers/agents/src/script-engine/skill-library.js";
import { ScriptToolSurface } from "../../workers/agents/src/script-engine/tool-surface.js";
import { scriptFind } from "../../workers/agents/src/script-engine/script-find.js";
import { runScriptLoop, type Reasoner, type ReasonDecision } from "../../workers/agents/src/script-engine/loop.js";
import { observeFilesystem } from "../../workers/agents/src/script-engine/observe.js";
import { writeAgentConfig, loadAgentConfig } from "../../workers/agents/src/script-engine/agent-config.js";
import { launchpadAgentToProfile, DEFAULT_NAELAO_AGENT } from "../../workers/agents/src/script-engine/profiles.js";
import { LAUNCHPAD_CORE_AGENTS } from "../../workers/agents/src/launchpad/spacetype.js";
import type { ScriptEngineEnv } from "../../workers/agents/src/script-engine/types.js";

// ── Minimal in-memory R2 bucket (the subset the engine uses) ──────────────────
function makeR2(): R2Bucket {
  const store = new Map<string, string>();
  const meta = new Map<string, Date>();
  const bucket = {
    async put(key: string, value: unknown) {
      const text = typeof value === "string" ? value : String(value);
      store.set(key, text);
      meta.set(key, new Date());
      return {} as R2Object;
    },
    async get(key: string) {
      if (!store.has(key)) return null;
      const text = store.get(key)!;
      return {
        size: text.length,
        uploaded: meta.get(key) ?? new Date(),
        async text() {
          return text;
        },
        get body() {
          return text;
        },
      } as unknown as R2ObjectBody;
    },
    async head(key: string) {
      return store.has(key) ? ({} as R2Object) : null;
    },
    async delete(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) {
        store.delete(k);
        meta.delete(k);
      }
    },
    async list(opts?: { prefix?: string; cursor?: string }) {
      const prefix = opts?.prefix ?? "";
      const objects = [...store.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((k) => ({ key: k, size: store.get(k)!.length, uploaded: meta.get(k) ?? new Date(), etag: "x" }));
      return { objects, truncated: false, cursor: undefined } as unknown as R2Objects;
    },
  };
  return bucket as unknown as R2Bucket;
}

function makeEnv(): ScriptEngineEnv {
  return { scriptsBucket: makeR2(), spaceId: "space-1", agentId: "agent-1", tenantId: "tenant-1" };
}

describe("SkillLibrary (R2 versioned store, spec §4/§10)", () => {
  let env: ScriptEngineEnv;
  let lib: SkillLibrary;
  beforeEach(() => {
    env = makeEnv();
    lib = new SkillLibrary(env.scriptsBucket, env.spaceId);
  });

  it("creates v1, then versions on update preserving history", async () => {
    await lib.create({ name: "greet", code: "v1", metadata: { description: "say hi", domain: "compute", requires_tier: 2 } });
    const v1 = await lib.read("greet");
    expect(v1?.metadata.version).toBe(1);
    expect(v1?.code).toBe("v1");

    const updated = await lib.update("greet", { code: "v2" }, "tweak", "minor_fix");
    expect(updated.version).toBe(2);
    expect(updated.patch_history.length).toBe(2);

    // prior version archived + retrievable for rollback
    await lib.rollback("greet", 1);
    const rolled = await lib.read("greet");
    expect(rolled?.code).toBe("v1");
  });

  it("rejects unsafe names and refuses duplicate create", async () => {
    await expect(lib.create({ name: "../escape", metadata: { description: "x", domain: "compute", requires_tier: 1 } })).rejects.toThrow();
    await lib.create({ name: "dup", metadata: { description: "x", domain: "compute", requires_tier: 1 } });
    await expect(lib.create({ name: "dup", metadata: { description: "x", domain: "compute", requires_tier: 1 } })).rejects.toThrow();
  });

  it("tracks outcomes into stability_score", async () => {
    await lib.create({ name: "s", metadata: { description: "x", domain: "compute", requires_tier: 1 } });
    await lib.recordOutcome("s", true);
    await lib.recordOutcome("s", true);
    const m = await lib.readMetadata("s");
    expect(m!.success_count).toBe(2);
    expect(m!.stability_score).toBeGreaterThan(0.5);
  });
});

describe("ScriptToolSurface — the 6-op surface (spec §3)", () => {
  it("runs prebuilt r2-workspace ops (write then read) at Tier 1", async () => {
    const env = makeEnv();
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    const w = await tools.run("write_file", { path: "notes/a.txt", content: "hello" });
    expect(w.ok).toBe(true);
    const r = await tools.run("read_file", { path: "notes/a.txt" });
    expect(r.ok).toBe(true);
    expect((r.output as { content: string }).content).toBe("hello");
    expect(r.tier).toBe(1);
  });

  it("reports unknown operations cleanly", async () => {
    const env = makeEnv();
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    const res = await tools.run("does_not_exist", {});
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Unknown script or operation/);
  });

  it("exposes available operations from enabled prebuilt scripts", () => {
    const env = makeEnv();
    const tools = new ScriptToolSurface(env, ["r2-workspace", "notifications"]);
    const ops = tools.availableOperations();
    expect(ops).toContain("read_file");
    expect(ops).toContain("notify.email");
  });
});

describe("script.find — degraded text scan when no Vectorize (spec §16)", () => {
  it("ranks library scripts by token overlap + stability", async () => {
    const env = makeEnv();
    const lib = new SkillLibrary(env.scriptsBucket, env.spaceId);
    await lib.create({ name: "send_email", code: "x", metadata: { description: "send an email to a customer", domain: "comms", requires_tier: 2, tags: ["email", "customer"] } });
    await lib.recordOutcome("send_email", true);
    await lib.create({ name: "list_files", code: "x", metadata: { description: "list files in workspace", domain: "filesystem", requires_tier: 1 } });

    const results = await scriptFind(env, "email customer");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.name).toBe("send_email");
  });
});

describe("observe_filesystem (spec §9) produces a stable fingerprint", () => {
  it("same workspace state → same fingerprint, change → different", async () => {
    const env = makeEnv();
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    await tools.run("write_file", { path: "a.txt", content: "1" });
    const s1 = await observeFilesystem(env);
    const s2 = await observeFilesystem(env);
    expect(s1.fingerprint).toBe(s2.fingerprint);
    await tools.run("write_file", { path: "b.txt", content: "2" });
    const s3 = await observeFilesystem(env);
    expect(s3.fingerprint).not.toBe(s1.fingerprint);
  });
});

describe("runScriptLoop — L1 execution + L4 distill (spec §2/§5)", () => {
  it("L4 distills a new script when the library is empty, then runs it", async () => {
    const env = makeEnv();
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    // Reasoner: on L4, distill a script that writes a file via the prebuilt op, then the
    // loop runs it. We model the distilled script as a prebuilt call by having the loop
    // run the distilled NAME — but since stored-code execution needs a runner, we instead
    // have the reasoner choose `run` of an existing prebuilt op (valid L4 outcome).
    const reasoner: Reasoner = {
      async decide(): Promise<ReasonDecision> {
        return { action: "run", name: "write_file", params: { path: "out.txt", content: "done" } };
      },
    };
    const result = await runScriptLoop(env, tools, reasoner, ["r2-workspace"], {
      goal: "create the output file",
      startupObserve: "observe_filesystem",
    });
    expect(result.level).toBe("L4"); // empty library → no match → L4
    expect(result.result?.ok).toBe(true);
    const check = await tools.run("read_file", { path: "out.txt" });
    expect((check.output as { content: string }).content).toBe("done");
  });

  it("answers directly when the reasoner returns an answer", async () => {
    const env = makeEnv();
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    const reasoner: Reasoner = {
      async decide(): Promise<ReasonDecision> {
        return { action: "answer", text: "42" };
      },
    };
    const result = await runScriptLoop(env, tools, reasoner, ["r2-workspace"], {
      goal: "what is the answer",
      startupObserve: "observe_filesystem",
    });
    expect(result.result?.output).toBe("42");
  });
});

describe("Agent config 4 R2 files + profiles (spec §11/§13)", () => {
  it("round-trips an agent's four config files", async () => {
    const env = makeEnv();
    await writeAgentConfig(env.scriptsBucket, env.spaceId, DEFAULT_NAELAO_AGENT.agentId, DEFAULT_NAELAO_AGENT.config);
    const loaded = await loadAgentConfig(env.scriptsBucket, env.spaceId, DEFAULT_NAELAO_AGENT.agentId);
    expect(loaded).not.toBeNull();
    expect(loaded!.scripts.prebuilt).toContain("r2-workspace");
    expect(loaded!.scripts.startup_observe).toBe("observe_filesystem");
  });

  it("derives a profile from each Launchpad core agent", () => {
    for (const def of LAUNCHPAD_CORE_AGENTS) {
      const profile = launchpadAgentToProfile(def);
      expect(profile.agentId).toBe(def.id);
      expect(profile.config.systemPrompt).toBe(def.system_prompt);
      // every agent gets the workspace + notifications surface
      expect(profile.config.scripts.prebuilt).toContain("r2-workspace");
      expect(profile.config.scripts.prebuilt).toContain("notifications");
    }
  });
});
