import { describe, it, expect, beforeEach } from "vitest";
import { SkillLibrary } from "../../workers/agents/src/script-engine/skill-library.js";
import { ScriptToolSurface } from "../../workers/agents/src/script-engine/tool-surface.js";
import { scriptFind } from "../../workers/agents/src/script-engine/script-find.js";
import { runScriptLoop, type Reasoner, type ReasonDecision } from "../../workers/agents/src/script-engine/loop.js";
import { observeFilesystem } from "../../workers/agents/src/script-engine/observe.js";
import { writeAgentConfig, loadAgentConfig, mergeMissingPrebuilt } from "../../workers/agents/src/script-engine/agent-config.js";
import { launchpadAgentToProfile, DEFAULT_NAELAO_AGENT, SPACE_ASSISTANT_PROFILE } from "../../workers/agents/src/script-engine/profiles.js";
import { LAUNCHPAD_CORE_AGENTS } from "../../workers/agents/src/launchpad/spacetype.js";
import type { ScriptEngineEnv } from "../../workers/agents/src/script-engine/types.js";

// ── Minimal in-memory R2 bucket (the subset the engine uses) ──────────────────
function makeR2(): R2Bucket {
  const store = new Map<string, { bytes: Uint8Array; etag: string; customMetadata: Record<string, string>; uploaded: Date }>();
  let revision = 0;
  const bucket = {
    async put(key: string, value: unknown, options?: R2PutOptions) {
      const previous = store.get(key);
      const onlyIf = options?.onlyIf as { etagMatches?: string; etagDoesNotMatch?: string } | undefined;
      if (onlyIf?.etagMatches !== undefined && previous?.etag !== onlyIf.etagMatches) return null;
      if (onlyIf?.etagDoesNotMatch === "*" && previous) return null;
      const bytes = value instanceof Uint8Array ? value : new TextEncoder().encode(typeof value === "string" ? value : String(value));
      const etag = String(++revision);
      store.set(key, { bytes: bytes.slice(), etag, customMetadata: options?.customMetadata ?? {}, uploaded: new Date() });
      return { etag } as R2Object;
    },
    async get(key: string) {
      const item = store.get(key);
      if (!item || item.customMetadata["deleted"] === "true") return null;
      return {
        size: item.bytes.byteLength,
        etag: item.etag,
        uploaded: item.uploaded,
        customMetadata: item.customMetadata,
        async text() { return new TextDecoder().decode(item.bytes); },
        async arrayBuffer() { return item.bytes.slice().buffer; },
      } as unknown as R2ObjectBody;
    },
    async head(key: string) {
      const item = store.get(key);
      return item ? { key, size: item.bytes.byteLength, etag: item.etag, uploaded: item.uploaded, customMetadata: item.customMetadata } as R2Object : null;
    },
    async delete(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) {
        store.delete(k);
      }
    },
    async list(opts?: { prefix?: string; cursor?: string }) {
      const prefix = opts?.prefix ?? "";
      const objects = [...store.entries()]
        .filter(([k, item]) => k.startsWith(prefix) && item.customMetadata["deleted"] !== "true")
        .map(([key, item]) => ({ key, size: item.bytes.byteLength, uploaded: item.uploaded, etag: item.etag, customMetadata: item.customMetadata }));
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
    const w = await tools.run("write_file", { path: "notes/a.txt", content: "hello", expectedHash: null });
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

  it("groups operations by owning script with that script's description — live-reported gap: a bare flat name list left real capabilities undiscoverable", () => {
    const env = makeEnv();
    const tools = new ScriptToolSurface(env, ["r2-workspace", "notifications", "project-coordination"]);
    const groups = tools.availableOperationsGrouped();

    const coordination = groups.find((g) => g.script === "project-coordination");
    expect(coordination).toBeDefined();
    expect(coordination!.description.length).toBeGreaterThan(0);
    // thread.create / thread.send_message must be discoverable somewhere in the grouped shape —
    // the exact bug this exists to fix: a model that couldn't see these named as "the answer" to
    // "chat inside an existing thread" claimed the capability didn't exist.
    expect(coordination!.operations).toContain("thread.create");
    expect(coordination!.operations).toContain("thread.send_message");

    const notify = groups.find((g) => g.script === "notifications");
    expect(notify!.operations).toContain("notify.email");

    // Every op from availableOperations() appears exactly once across the grouped shape — no op
    // lost, none duplicated across groups.
    const flat = tools.availableOperations();
    const grouped = groups.flatMap((g) => g.operations);
    expect(grouped.sort()).toEqual(flat.sort());
  });

  it("surfaces paramHints when a script declares them, and omits the field entirely when none do — the live-reported gap where thread.create({}) ran with no project_id and thread.send_message was never even attempted, because nothing told the model what fields either call needed", () => {
    const env = makeEnv();
    const tools = new ScriptToolSurface(env, ["r2-workspace", "project-coordination"]);
    const groups = tools.availableOperationsGrouped();

    const coordination = groups.find((g) => g.script === "project-coordination")!;
    expect(coordination.paramHints).toBeDefined();
    // The exact operation the live bug involved: the hint must actually name project_id, or the
    // fix doesn't close the gap it was written for.
    expect(coordination.paramHints!["thread.create"]).toMatch(/project_id/);
    expect(coordination.paramHints!["thread.send_message"]).toMatch(/thread_id/);
    expect(coordination.paramHints!["thread.send_message"]).toMatch(/message/);
    // Every operation in the group has a hint — a silently-undocumented op defeats the point.
    for (const opName of coordination.operations) {
      expect(coordination.paramHints![opName], `missing paramHints for ${opName}`).toBeTruthy();
    }

    // r2-workspace now declares paramHints too (step 3 — read_file's offset/length chunked read
    // and search_file need documenting), and its hints name the new params.
    const r2 = groups.find((g) => g.script === "r2-workspace")!;
    expect(r2.paramHints).toBeDefined();
    expect(r2.paramHints!["read_file"]).toMatch(/offset/);
    expect(r2.paramHints!["search_file"]).toMatch(/query/);
  });

  // commerce.create_product/update_product were the exact ops item 108's live trace found
  // fabricated (the model claimed a product was live when it never called them at all, and
  // once it could, the risk shifted to a wrong or missing product_id/status). storefront's two
  // ops share a real footgun of their own (posting kind='storefront' where 'custom_domain' was
  // meant silently drops the domain — see that script's own header) — both get explicit hints.
  it("surfaces the commerce and storefront paramHints added to close known footguns", () => {
    const env = makeEnv();
    const tools = new ScriptToolSurface(env, ["commerce", "storefront"]);
    const groups = tools.availableOperationsGrouped();

    const commerce = groups.find((g) => g.script === "commerce")!;
    expect(commerce.paramHints!["commerce.create_product"]).toMatch(/name/);
    expect(commerce.paramHints!["commerce.update_product"]).toMatch(/product_id/);

    const storefront = groups.find((g) => g.script === "storefront")!;
    expect(storefront.paramHints!["storefront.set_custom_domain"]).toMatch(/domain/);
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

  // A real production request 500'd with a raw Workers AI "4006: daily neuron allocation
  // exhausted" error and never reached the reasoner at all — because a Vectorize index AND an
  // embedder WERE wired (so the "no Vectorize configured" degraded path above never engaged),
  // and the underlying embed() call itself threw with no try/catch around it. FIND runs
  // algorithmically ahead of any model choice, so this killed the whole run regardless of which
  // chat model the caller had picked (including a request that had deliberately switched away
  // from Workers AI specifically to keep working through the quota cap). These two cases prove
  // the fix: wired-but-failing degrades exactly like unwired, rather than propagating.
  it("degrades to the tag/substring scan when the embedder is wired but its embed() call throws", async () => {
    const env: ScriptEngineEnv = {
      ...makeEnv(),
      embedder: { embed: async () => { throw new Error("4006: daily neuron allocation exhausted"); } },
      vectorIndex: { query: async () => ({ matches: [] }), upsert: async () => {}, deleteByIds: async () => {} } as never,
    };
    const lib = new SkillLibrary(env.scriptsBucket, env.spaceId);
    await lib.create({ name: "send_email", code: "x", metadata: { description: "send an email to a customer", domain: "comms", requires_tier: 2, tags: ["email", "customer"] } });

    const results = await scriptFind(env, "email customer");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.name).toBe("send_email");
  });

  it("degrades to the tag/substring scan when the ANN query call throws (embed succeeded, Vectorize itself failed)", async () => {
    const env: ScriptEngineEnv = {
      ...makeEnv(),
      embedder: { embed: async () => [0.1, 0.2] },
      vectorIndex: { query: async () => { throw new Error("Vectorize unavailable"); }, upsert: async () => {}, deleteByIds: async () => {} } as never,
    };
    const lib = new SkillLibrary(env.scriptsBucket, env.spaceId);
    await lib.create({ name: "send_email", code: "x", metadata: { description: "send an email to a customer", domain: "comms", requires_tier: 2, tags: ["email", "customer"] } });

    const results = await scriptFind(env, "email customer");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.name).toBe("send_email");
  });

  it("script.create never fails just because indexing its embedding failed — R2 write is the real data, the vector is a search index", async () => {
    const env: ScriptEngineEnv = {
      ...makeEnv(),
      embedder: { embed: async () => { throw new Error("4006: daily neuron allocation exhausted"); } },
      vectorIndex: { query: async () => ({ matches: [] }), upsert: async () => { throw new Error("should never reach upsert"); }, deleteByIds: async () => {} } as never,
    };
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    const created = await tools.create({
      name: "new_skill",
      code: "x",
      metadata: { description: "a brand new skill", domain: "compute", requires_tier: 1 },
    });
    expect(created.name).toBe("new_skill");
  });
});

describe("observe_filesystem (spec §9) produces a stable fingerprint", () => {
  it("same workspace state → same fingerprint, change → different", async () => {
    const env = makeEnv();
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    await tools.run("write_file", { path: "a.txt", content: "1", expectedHash: null });
    const s1 = await observeFilesystem(env);
    const s2 = await observeFilesystem(env);
    expect(s1.fingerprint).toBe(s2.fingerprint);
    await tools.run("write_file", { path: "b.txt", content: "2", expectedHash: null });
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
    // Runs the tool, THEN answers — a realistic turn. (These tests used to use a reasoner that
    // only ever returned `run` and never answered; they passed because the loop wrongly ended on
    // the first successful tool call. A run that never composes an answer now fails, correctly.)
    let step = 0;
    const reasoner: Reasoner = {
      async decide(): Promise<ReasonDecision> {
        return step++ === 0
          ? { action: "run", name: "write_file", params: { path: "out.txt", content: "done", expectedHash: null } }
          : { action: "answer", text: "Wrote out.txt." };
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

describe("runScriptLoop — real per-token accounting (replaces the step-count-only proxy)", () => {
  it("accumulates real reasoner token usage across multiple L3/L4 steps into result.tokens_used", async () => {
    const env = makeEnv();
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    let call = 0;
    const reasoner: Reasoner & { lastUsage?: { input_tokens: number; output_tokens: number } } = {
      lastUsage: undefined,
      async decide(): Promise<ReasonDecision> {
        call++;
        // First step: a failed run (so the loop takes a second step); second step: answer.
        if (call === 1) {
          this.lastUsage = { input_tokens: 100, output_tokens: 20 };
          return { action: "run", name: "does_not_exist", params: {} };
        }
        this.lastUsage = { input_tokens: 80, output_tokens: 15 };
        return { action: "answer", text: "done" };
      },
    };
    const result = await runScriptLoop(env, tools, reasoner, ["r2-workspace"], {
      goal: "multi-step goal",
      startupObserve: "observe_filesystem",
    });
    expect(result.result?.tokens_used).toBe(100 + 20 + 80 + 15);
    expect(result.result?.input_tokens).toBe(180);
    expect(result.result?.output_tokens).toBe(35);
  });

  it("a reasoner that never reports usage leaves tokens_used at 0 (honest, not fabricated)", async () => {
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
    expect(result.result?.tokens_used).toBe(0);
  });

  it("maxTokens stops the loop before it can afford another step", async () => {
    const env = makeEnv();
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    let calls = 0;
    const reasoner: Reasoner & { lastUsage?: { input_tokens: number; output_tokens: number } } = {
      lastUsage: undefined,
      async decide(): Promise<ReasonDecision> {
        calls++;
        this.lastUsage = { input_tokens: 6000, output_tokens: 0 }; // each step costs more than the budget
        return { action: "run", name: "does_not_exist", params: {} }; // always fails -> would loop forever without a cap
      },
    };
    const result = await runScriptLoop(env, tools, reasoner, ["r2-workspace"], {
      goal: "expensive goal",
      startupObserve: "observe_filesystem",
      maxSteps: 10,
      maxTokens: 5000, // less than one step's cost -> stops after step 1
    });
    expect(calls).toBe(1);
    expect(result.notes.some((n) => n.includes("token budget"))).toBe(true);
  });

  it("onProgress fires live (pre-step) AND persisted (post-step, via pushTrace) checkpoints in phase order", async () => {
    // §A1 Harness Excellence Phase HX2+ (live activity feed): onProgress now fires the SAME
    // TraceStep-shaped checkpoint pushTrace persists, both right before a slow operation starts
    // (a "Thinking…"/"Running X" live ping with no `ok`) and again once it completes — so a host
    // with no live-progress needs can ignore it, and one building a chat UI's "currently doing X"
    // indicator gets it for free. Assert relative ORDER (a subsequence), not exact call count,
    // since exactly how many times a phase pings is an implementation detail.
    const env = makeEnv();
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    const reasoner: Reasoner = {
      async decide(): Promise<ReasonDecision> {
        return { action: "answer", text: "ok" };
      },
    };
    const phases: string[] = [];
    await runScriptLoop(env, tools, reasoner, ["r2-workspace"], {
      goal: "trivial goal",
      startupObserve: "observe_filesystem",
      onProgress: (checkpoint) => {
        phases.push(checkpoint.phase);
      },
    });
    const uniqueInOrder = [...new Set(phases)];
    expect(uniqueInOrder).toEqual(["observe", "find", "gate", "reason", "answer"]);
  });

  it("a throwing onProgress never fails the run", async () => {
    const env = makeEnv();
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    const reasoner: Reasoner = {
      async decide(): Promise<ReasonDecision> {
        return { action: "answer", text: "ok" };
      },
    };
    const result = await runScriptLoop(env, tools, reasoner, ["r2-workspace"], {
      goal: "trivial goal",
      startupObserve: "observe_filesystem",
      onProgress: () => {
        throw new Error("progress sink is down");
      },
    });
    expect(result.result?.ok).toBe(true);
  });
});

describe("runScriptLoop — structured trace (§A1 Phase HX1, the persisted counterpart to notes)", () => {
  it("records observe/find/gate/reason/run phases in order with real tier/tokens/ok", async () => {
    const env = makeEnv();
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    // Runs the tool, THEN answers — a realistic turn. (These tests used to use a reasoner that
    // only ever returned `run` and never answered; they passed because the loop wrongly ended on
    // the first successful tool call. A run that never composes an answer now fails, correctly.)
    let step = 0;
    const reasoner: Reasoner = {
      async decide(): Promise<ReasonDecision> {
        return step++ === 0
          ? { action: "run", name: "write_file", params: { path: "out.txt", content: "done", expectedHash: null } }
          : { action: "answer", text: "Wrote out.txt." };
      },
    };
    const result = await runScriptLoop(env, tools, reasoner, ["r2-workspace"], {
      goal: "create the output file",
      startupObserve: "observe_filesystem",
    });
    expect(result.result?.ok).toBe(true);
    const phases = result.trace.map((t) => t.phase);
    expect(phases[0]).toBe("observe");
    expect(phases[1]).toBe("find");
    expect(phases[2]).toBe("gate");
    expect(phases).toContain("reason");
    expect(phases).toContain("run");
    // seq is monotonic and starts at 0
    expect(result.trace.map((t) => t.seq)).toEqual(result.trace.map((_, i) => i));
    const runStep = result.trace.find((t) => t.phase === "run")!;
    expect(runStep.name).toBe("write_file");
    expect(runStep.tier).toBe(1);
    expect(runStep.ok).toBe(true);
    expect(typeof runStep.duration_ms).toBe("number");
    const reasonStep = result.trace.find((t) => t.phase === "reason")!;
    expect(reasonStep.detail).toBe("run");
  });

  it("L3/L4 records a 'reason' step per reasoning iteration with token counts", async () => {
    const env = makeEnv();
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    let call = 0;
    const reasoner: Reasoner & { lastUsage?: { input_tokens: number; output_tokens: number } } = {
      lastUsage: undefined,
      async decide(): Promise<ReasonDecision> {
        call++;
        if (call === 1) {
          this.lastUsage = { input_tokens: 50, output_tokens: 10 };
          return { action: "run", name: "does_not_exist", params: {} }; // fails -> loop retries
        }
        this.lastUsage = { input_tokens: 30, output_tokens: 5 };
        return { action: "answer", text: "done" };
      },
    };
    const result = await runScriptLoop(env, tools, reasoner, ["r2-workspace"], {
      goal: "multi-step goal",
      startupObserve: "observe_filesystem",
    });
    const reasonSteps = result.trace.filter((t) => t.phase === "reason");
    expect(reasonSteps.length).toBe(2);
    expect(reasonSteps[0]!.tokens).toBe(60);
    expect(reasonSteps[1]!.tokens).toBe(35);
    // The first reasoner decision's failed run is also traced.
    const runSteps = result.trace.filter((t) => t.phase === "run");
    expect(runSteps.length).toBe(1);
    expect(runSteps[0]!.ok).toBe(false);
  });
});

describe("runScriptLoop — approval modes (Space Assistant default-ask vs ordinary agent gate-listed)", () => {
  function makeHitlGateway(approved: boolean): { calls: string[]; gateway: import("../../workers/agents/src/script-engine/types.js").HITLGateway } {
    const calls: string[] = [];
    return {
      calls,
      gateway: {
        async requestApproval(params) {
          calls.push(params.actionName);
          return { approvalId: "appr-1", approved };
        },
      },
    };
  }

  it("gate_listed (ordinary agent default): only actions IN the list are gated", async () => {
    const env = makeEnv();
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    const { calls, gateway } = makeHitlGateway(true);
    env.hitlGateway = gateway;
    const reasoner: Reasoner = {
      async decide(): Promise<ReasonDecision> {
        return { action: "run", name: "write_file", params: { path: "a.txt", content: "x", expectedHash: null } };
      },
    };
    // "write_file" is NOT in requiresApprovalFor -> gate_listed mode means it runs freely.
    await runScriptLoop(env, tools, reasoner, ["r2-workspace"], {
      goal: "write a file", startupObserve: "observe_filesystem",
      requiresApprovalFor: ["delete_file"],
    });
    expect(calls).toEqual([]); // never asked
  });

  it("gate_unless_listed (Space Assistant default): actions NOT in the list ARE gated", async () => {
    const env = makeEnv();
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    const { calls, gateway } = makeHitlGateway(true);
    env.hitlGateway = gateway;
    let step = 0;
    const reasoner: Reasoner = {
      async decide(): Promise<ReasonDecision> {
        return step++ === 0
          ? { action: "run", name: "write_file", params: { path: "a.txt", content: "x", expectedHash: null } }
          : { action: "answer", text: "Wrote a.txt." };
      },
    };
    // "write_file" is NOT in the auto-approved list -> gate_unless_listed asks first.
    const result = await runScriptLoop(env, tools, reasoner, ["r2-workspace"], {
      goal: "write a file", startupObserve: "observe_filesystem",
      requiresApprovalFor: ["read_file"], // the auto-approved set, under gate_unless_listed
      approvalMode: "gate_unless_listed",
    });
    expect(calls).toEqual(["write_file"]);
    expect(result.result?.ok).toBe(true); // approved=true -> proceeds
  });

  it("gate_unless_listed: an auto-approved action is never asked about", async () => {
    const env = makeEnv();
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    const { calls, gateway } = makeHitlGateway(true);
    env.hitlGateway = gateway;
    const reasoner: Reasoner = {
      async decide(): Promise<ReasonDecision> {
        return { action: "run", name: "write_file", params: { path: "a.txt", content: "x", expectedHash: null } };
      },
    };
    await runScriptLoop(env, tools, reasoner, ["r2-workspace"], {
      goal: "write a file", startupObserve: "observe_filesystem",
      requiresApprovalFor: ["write_file"], // pre-approved
      approvalMode: "gate_unless_listed",
    });
    expect(calls).toEqual([]);
  });

  it("gate_unless_listed with a rejected approval aborts the action", async () => {
    const env = makeEnv();
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    const { gateway } = makeHitlGateway(false);
    env.hitlGateway = gateway;
    const reasoner: Reasoner = {
      async decide(): Promise<ReasonDecision> {
        return { action: "run", name: "write_file", params: { path: "a.txt", content: "x", expectedHash: null } };
      },
    };
    const result = await runScriptLoop(env, tools, reasoner, ["r2-workspace"], {
      goal: "write a file", startupObserve: "observe_filesystem",
      requiresApprovalFor: [],
      approvalMode: "gate_unless_listed",
    });
    expect(result.result?.ok).toBe(false);
    // Names the action and why it didn't run. A bare "HITL rejected" couldn't distinguish a
    // human declining from a policy fetch failing closed — an ambiguity that cost real debugging
    // time during the live model-matrix run.
    expect(result.result?.error).toMatch(/needed approval and was not approved/);
    expect(result.result?.error).toContain("write_file");
  });

  it("YOLO (empty requiresApprovalFor, default gate_listed mode) never asks even with a gateway wired", async () => {
    const env = makeEnv();
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    const { calls, gateway } = makeHitlGateway(true);
    env.hitlGateway = gateway;
    const reasoner: Reasoner = {
      async decide(): Promise<ReasonDecision> {
        return { action: "run", name: "write_file", params: { path: "a.txt", content: "x", expectedHash: null } };
      },
    };
    await runScriptLoop(env, tools, reasoner, ["r2-workspace"], {
      goal: "write a file", startupObserve: "observe_filesystem",
      requiresApprovalFor: [], // NaelaoAgentDO's yolo policy passes this + default gate_listed
    });
    expect(calls).toEqual([]);
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

  it("DEFAULT_NAELAO_AGENT.agentId is exactly 'naelao-agent' (regression: every dispatcher — " +
     "billing, event triggers, channel heartbeats, scheduled jobs — hardcodes this literal " +
     "string; a mismatched agentId here means the provisioned config lives at a different R2 " +
     "path than every wake-up call looks for, and every dispatch 404s: 'agent is not " +
     "provisioned in space')", () => {
    expect(DEFAULT_NAELAO_AGENT.agentId).toBe("naelao-agent");
  });

  it("SPACE_ASSISTANT_PROFILE is the same profile as DEFAULT_NAELAO_AGENT (one bundle, not two)", () => {
    expect(SPACE_ASSISTANT_PROFILE).toBe(DEFAULT_NAELAO_AGENT);
  });

  // Live-reported: a business's Space Assistant claimed thread.create "isn't supported" — a real,
  // shipped capability. Root cause: scripts.json is written ONCE at provision time and nothing
  // re-syncs it when profiles.ts later gains a new prebuilt script. mergeMissingPrebuilt is the
  // pure additive-union primitive the self-heal (NaelaoAgentDO.loadAgentConfigHealed) is built on.
  describe("mergeMissingPrebuilt — additive union for a stale persisted prebuilt list", () => {
    it("adds only what's missing, preserving persisted order", () => {
      const { merged, changed, added } = mergeMissingPrebuilt(
        { prebuilt: ["r2-workspace", "web-search"], startup_observe: "observe_filesystem" },
        ["web-search", "project-coordination", "business-diagnostics"]
      );
      expect(changed).toBe(true);
      expect(added).toEqual(["project-coordination", "business-diagnostics"]);
      expect(merged.prebuilt).toEqual(["r2-workspace", "web-search", "project-coordination", "business-diagnostics"]);
    });

    it("reports changed:false and returns the SAME object when nothing is missing (skip a needless write)", () => {
      const scripts = { prebuilt: ["r2-workspace", "project-coordination"], startup_observe: "observe_filesystem" };
      const result = mergeMissingPrebuilt(scripts, ["project-coordination"]);
      expect(result.changed).toBe(false);
      expect(result.added).toEqual([]);
      expect(result.merged).toBe(scripts);
    });

    it("never removes anything already persisted, even if it's not in `additions`", () => {
      const { merged } = mergeMissingPrebuilt(
        { prebuilt: ["r2-workspace", "local-machine"], startup_observe: "observe_filesystem" },
        ["r2-workspace", "web-search"]
      );
      expect(merged.prebuilt).toContain("local-machine");
    });
  });

  it("the Space Assistant profile reflects continuous existence, channels, and honest escalation (spec §05/A1.3)", () => {
    const combined = DEFAULT_NAELAO_AGENT.config.agentsMd + " " + DEFAULT_NAELAO_AGENT.config.systemPrompt;
    expect(combined).toMatch(/heartbeat/i);
    expect(combined).toMatch(/channel/i);
    expect(combined).toMatch(/escalat/i);
    // notifications carries the HITL / owner-escalation surface
    expect(DEFAULT_NAELAO_AGENT.config.scripts.prebuilt).toContain("notifications");
  });

  it("derives a profile from each Launchpad core agent", () => {
    for (const def of LAUNCHPAD_CORE_AGENTS) {
      const profile = launchpadAgentToProfile(def);
      expect(profile.agentId).toBe(def.id);
      // The profile now appends a shared rule about how to TALK to an owner: each definition's
      // own prose necessarily names the operations it should call, and a live run showed a small
      // model narrating those names straight back at a business owner. The definition's
      // instructions must still be present in full, with the rule after them.
      expect(profile.config.systemPrompt).toContain(def.system_prompt);
      expect(profile.config.systemPrompt).toContain("How you talk to people");
      expect(profile.config.systemPrompt.indexOf(def.system_prompt)).toBeLessThan(
        profile.config.systemPrompt.indexOf("How you talk to people")
      );
      // every agent gets the workspace + notifications surface
      expect(profile.config.scripts.prebuilt).toContain("r2-workspace");
      expect(profile.config.scripts.prebuilt).toContain("notifications");
    }
  });
});
