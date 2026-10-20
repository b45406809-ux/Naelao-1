/**
 * Skill self-improvement — the loop that turns a recorded failure into a repaired skill.
 *
 * The behaviour under test is not "a counter went up". It is: a skill that has been failing
 * must stop being run unattended, must carry its own error forward to whatever repairs it, and
 * must stop out-ranking something that actually works — while staying findable, because an
 * agent cannot repair a skill it can't see.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { SkillLibrary } from "../../workers/agents/src/script-engine/skill-library.js";
import { scriptFind } from "../../workers/agents/src/script-engine/script-find.js";
import { runScriptLoop, type Reasoner, type ReasonDecision } from "../../workers/agents/src/script-engine/loop.js";
import { ScriptToolSurface } from "../../workers/agents/src/script-engine/tool-surface.js";
import {
  assessSkillHealth,
  recordRecentOutcome,
  healthConfidenceMultiplier,
  isSafeToAutoRun,
  RECENT_OUTCOME_WINDOW,
  MAX_RECORDED_ERROR_CHARS,
} from "../../workers/agents/src/script-engine/skill-health.js";
import type { ScriptEngineEnv, ScriptMetadata } from "../../workers/agents/src/script-engine/types.js";

// ── In-memory R2 (the subset the library uses) ────────────────────────────────
function makeR2(): R2Bucket {
  const store = new Map<string, string>();
  return {
    async put(key: string, value: unknown) {
      store.set(key, typeof value === "string" ? value : String(value));
      return {} as R2Object;
    },
    async get(key: string) {
      if (!store.has(key)) return null;
      const text = store.get(key)!;
      return { size: new TextEncoder().encode(text).byteLength, async text() { return text; }, async arrayBuffer() { return new TextEncoder().encode(text).buffer; } } as unknown as R2ObjectBody;
    },
    async head(key: string) {
      return store.has(key) ? ({ size: new TextEncoder().encode(store.get(key)!).byteLength } as R2Object) : null;
    },
    async delete(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
    },
    async list(opts?: { prefix?: string }) {
      const prefix = opts?.prefix ?? "";
      const objects = [...store.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ key: k }));
      return { objects, truncated: false } as unknown as R2Objects;
    },
  } as unknown as R2Bucket;
}

function makeEnv(): ScriptEngineEnv {
  return { scriptsBucket: makeR2(), spaceId: "space-1", agentId: "agent-1", tenantId: "tenant-1" };
}

/** Metadata shaped like a real skill, with only the health fields that matter here set. */
function meta(over: Partial<ScriptMetadata> = {}): ScriptMetadata {
  return {
    name: "s",
    version: 1,
    domain: "compute",
    description: "x",
    tags: [],
    fingerprint_schema: {},
    preconditions: [],
    parameters: [],
    calls: [],
    requires_tier: 1,
    success_count: 0,
    failure_count: 0,
    patch_history: [],
    stability_score: 0.5,
    origin: "distilled",
    created_at: 0,
    updated_at: 0,
    ...over,
  };
}

const fail = (at: number, error?: string) => ({ ok: false, at, ...(error ? { error } : {}) });
const pass = (at: number) => ({ ok: true, at });

describe("assessSkillHealth — recency, not a lifetime ratio", () => {
  it("calls a skill broken after three consecutive failures, however good its lifetime record", () => {
    // The exact case a lifetime ratio cannot express: 20/24 successes scores 0.83, but the
    // last three runs in a row failed, so the next one will too.
    const h = assessSkillHealth(
      meta({
        success_count: 20,
        failure_count: 4,
        recent_outcomes: [fail(3, "selector .price not found"), fail(2), fail(1), pass(0)],
      })
    );
    expect(h.state).toBe("broken");
    expect(h.consecutive_failures).toBe(3);
    expect(h.last_error).toBe("selector .price not found");
    expect(h.recommendation).toContain("selector .price not found");
  });

  it("calls two in a row degrading, not yet broken", () => {
    const h = assessSkillHealth(meta({ success_count: 9, failure_count: 2, recent_outcomes: [fail(2), fail(1), pass(0)] }));
    expect(h.state).toBe("degrading");
    expect(h.consecutive_failures).toBe(2);
  });

  it("catches a skill failing badly without a clean streak", () => {
    // fail, pass, fail, fail, pass → no streak of 2 at the head, but 3 of 5 recent runs failed.
    const h = assessSkillHealth(
      meta({ success_count: 10, failure_count: 3, recent_outcomes: [fail(5), pass(4), fail(3), fail(2), pass(1)] })
    );
    expect(h.state).toBe("degrading");
  });

  it("does not condemn a skill for one recent failure among successes", () => {
    const h = assessSkillHealth(
      meta({ success_count: 9, failure_count: 1, recent_outcomes: [pass(4), fail(3), pass(2), pass(1)] })
    );
    expect(h.state).toBe("proven");
    expect(h.consecutive_failures).toBe(0);
  });

  it("treats a script with no track record as unproven, not proven", () => {
    expect(assessSkillHealth(meta()).state).toBe("unproven");
    expect(assessSkillHealth(meta({ success_count: 1, recent_outcomes: [pass(0)] })).state).toBe("unproven");
  });

  it("reads a pre-existing script (no window) as unproven rather than crashing", () => {
    // recent_outcomes is optional — scripts written before it existed must still assess.
    const h = assessSkillHealth(meta({ success_count: 40, failure_count: 0 }));
    expect(h.state).toBe("proven");
    expect(h.recent_runs).toBe(0);
  });
});

describe("recordRecentOutcome", () => {
  it("keeps the window bounded and newest-first", () => {
    let w = undefined as ReturnType<typeof recordRecentOutcome> | undefined;
    for (let i = 0; i < RECENT_OUTCOME_WINDOW + 5; i++) w = recordRecentOutcome(w, { ok: true, at: i });
    expect(w!.length).toBe(RECENT_OUTCOME_WINDOW);
    expect(w![0]!.at).toBe(RECENT_OUTCOME_WINDOW + 4); // newest first
  });

  it("records an error on a failure and truncates it, and never on a success", () => {
    const long = "x".repeat(MAX_RECORDED_ERROR_CHARS + 200);
    const w = recordRecentOutcome(undefined, { ok: false, at: 1, error: long });
    expect(w[0]!.error!.length).toBe(MAX_RECORDED_ERROR_CHARS);
    const ok = recordRecentOutcome(undefined, { ok: true, at: 2, error: "ignored" });
    expect(ok[0]!.error).toBeUndefined();
  });
});

describe("SkillLibrary.recordOutcome persists the window", () => {
  let lib: SkillLibrary;
  beforeEach(() => {
    lib = new SkillLibrary(makeR2(), "space-1");
  });

  it("stores the failure reason so a later repair can be aimed at it", async () => {
    await lib.create({ name: "quote", metadata: { description: "x", domain: "compute", requires_tier: 1 } });
    await lib.recordOutcome("quote", false, "TypeError: brief.split is not a function");
    const m = await lib.readMetadata("quote");
    expect(m!.failure_count).toBe(1);
    expect(m!.recent_outcomes?.[0]?.error).toContain("brief.split is not a function");
    expect(assessSkillHealth(m!).last_error).toContain("brief.split");
  });
});

describe("script.find ranking", () => {
  it("demotes a broken skill below a working one, but still returns it", async () => {
    const env = makeEnv();
    const lib = new SkillLibrary(env.scriptsBucket, env.spaceId);
    await lib.create({ name: "quote-job", metadata: { description: "quote a job", domain: "compute", requires_tier: 1 } });
    await lib.create({ name: "quote-basic", metadata: { description: "quote a job", domain: "compute", requires_tier: 1 } });

    // quote-job has the better lifetime record, and is broken right now.
    for (let i = 0; i < 8; i++) await lib.recordOutcome("quote-job", true);
    for (let i = 0; i < 3; i++) await lib.recordOutcome("quote-job", false, "API returned 500");
    // quote-basic is merely fine.
    for (let i = 0; i < 3; i++) await lib.recordOutcome("quote-basic", true);

    const found = await scriptFind(env, "quote a job", { limit: 5 });
    const names = found.map((c) => c.name);
    // Still findable — repair depends on it.
    expect(names).toContain("quote-job");
    // But the merely-fine one now wins.
    expect(names[0]).toBe("quote-basic");
    expect(found.find((c) => c.name === "quote-job")!.health!.state).toBe("broken");
  });

  it("attaches the health verdict to every candidate", async () => {
    const env = makeEnv();
    const lib = new SkillLibrary(env.scriptsBucket, env.spaceId);
    await lib.create({ name: "greet", metadata: { description: "say hello", domain: "compute", requires_tier: 1 } });
    const [c] = await scriptFind(env, "say hello", { limit: 1 });
    expect(c!.health).toBeDefined();
    expect(c!.health!.state).toBe("unproven");
  });
});

describe("healthConfidenceMultiplier / isSafeToAutoRun", () => {
  it("only a proven skill may run with no model in the loop", () => {
    expect(isSafeToAutoRun("proven")).toBe(true);
    expect(isSafeToAutoRun("unproven")).toBe(false);
    expect(isSafeToAutoRun("degrading")).toBe(false);
    expect(isSafeToAutoRun("broken")).toBe(false);
  });

  it("demotes broken hardest, leaves proven untouched", () => {
    expect(healthConfidenceMultiplier("proven")).toBe(1);
    expect(healthConfidenceMultiplier("broken")).toBeLessThan(healthConfidenceMultiplier("degrading"));
    expect(healthConfidenceMultiplier("broken")).toBeGreaterThan(0); // never zero: must stay findable
  });
});

describe("the loop routes a broken skill to repair instead of running it", () => {
  /** Records what the reasoner was asked, so we can assert on the repair target it received. */
  function recordingReasoner(decision: ReasonDecision) {
    const seen: Array<Record<string, unknown>> = [];
    const reasoner: Reasoner = {
      async decide(input) {
        seen.push(input as unknown as Record<string, unknown>);
        return decision;
      },
    };
    return { reasoner, seen };
  }

  it("does not auto-run a skill that failed its last three runs — it patches it, aimed at the real error", async () => {
    const env = makeEnv();
    const lib = new SkillLibrary(env.scriptsBucket, env.spaceId);
    await lib.create({
      name: "fetch-prices",
      code: "export default async () => ({ ok: true })",
      metadata: { description: "fetch prices", domain: "compute", requires_tier: 1 },
    });
    // A strong lifetime record — the old gate would have run this at L1 without a second thought.
    for (let i = 0; i < 12; i++) await lib.recordOutcome("fetch-prices", true);
    for (let i = 0; i < 3; i++) await lib.recordOutcome("fetch-prices", false, "selector .price not found");

    const { reasoner, seen } = recordingReasoner({ action: "answer", text: "reported" });
    const tools = new ScriptToolSurface(env, []);
    const result = await runScriptLoop(env, tools, reasoner, [], { goal: "fetch prices", maxSteps: 1 });

    // The model was consulted at all — that is the fix. Previously this ran unattended.
    expect(seen.length).toBeGreaterThan(0);
    expect(result.level).not.toBe("L1");

    const repair = seen.find((s) => s["repairTarget"])?.["repairTarget"] as { name: string; failureReason: string } | undefined;
    expect(repair?.name).toBe("fetch-prices");
    // The repair carries the skill's OWN recorded error, not a generic "it's stale".
    expect(repair?.failureReason).toContain("selector .price not found");
  });

  it("still runs a proven skill directly, with no model call", async () => {
    const env = makeEnv();
    const lib = new SkillLibrary(env.scriptsBucket, env.spaceId);
    await lib.create({
      name: "greet",
      code: "export default async () => ({ greeted: true })",
      metadata: { description: "greet someone", domain: "compute", requires_tier: 1, fingerprint_schema: {} },
    });
    for (let i = 0; i < 6; i++) await lib.recordOutcome("greet", true);

    let called = 0;
    const reasoner: Reasoner = {
      async decide() {
        called += 1;
        return { action: "give_up", reason: "should not be reached" };
      },
    };
    const tools = new ScriptToolSurface(env, []);
    const result = await runScriptLoop(env, tools, reasoner, [], { goal: "greet someone", maxSteps: 1 });
    expect(result.level).toBe("L1");
    expect(called).toBe(0);
  });
});
