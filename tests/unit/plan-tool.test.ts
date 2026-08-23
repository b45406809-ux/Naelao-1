// The `plan` prebuilt (Claude Code's TodoWrite pattern) + loop.ts's plan gate: once an agent sets
// a plan, it may not answer/give_up while any step is still open. This is the enforcement behind
// "a research agent shouldn't stop half-done" — the tool alone is a suggestion; the loop gate is
// what gives it teeth.

import { describe, it, expect } from "vitest";
import { runScriptLoop, type Reasoner, type ReasonDecision } from "../../workers/agents/src/script-engine/loop.js";
import { ScriptToolSurface } from "../../workers/agents/src/script-engine/tool-surface.js";
import { applyPlanOp } from "../../workers/agents/src/script-engine/prebuilt/plan.js";
import type { ScriptEngineEnv, PlanState } from "../../workers/agents/src/script-engine/types.js";

function makeR2(): R2Bucket {
  const store = new Map<string, string>();
  return {
    async put(key: string, value: unknown) { store.set(key, typeof value === "string" ? value : String(value)); return {} as R2Object; },
    async get(key: string) { const v = store.get(key); return v === undefined ? null : ({ text: async () => v, uploaded: new Date() } as unknown as R2ObjectBody); },
    async delete(key: string) { store.delete(key); },
    async list() { return { objects: [], truncated: false } as unknown as R2Objects; },
  } as unknown as R2Bucket;
}

function makeEnv(): ScriptEngineEnv {
  return { scriptsBucket: makeR2(), spaceId: "space-1", agentId: "agent-1", tenantId: "tenant-1" };
}

function scriptedReasoner(decisions: ReasonDecision[]) {
  const seen: Array<Parameters<Reasoner["decide"]>[0]> = [];
  let i = 0;
  const reasoner: Reasoner = {
    async decide(input) { seen.push(input); return decisions[Math.min(i++, decisions.length - 1)]!; },
  };
  return { reasoner, seen };
}

const LOOP_OPTS = { goal: "do the thing", startupObserve: "observe_filesystem", forceLevel: "L4" as const };

describe("applyPlanOp — the shared plan-mutation function", () => {
  it("plan.set replaces the whole plan with fresh, not-done steps", () => {
    const state: PlanState = { steps: [] };
    applyPlanOp(state, "plan.set", { steps: ["find sources", "verify claims", "write report"] });
    expect(state.steps).toHaveLength(3);
    expect(state.steps.every((s) => !s.done)).toBe(true);
    expect(state.steps[0]!.text).toBe("find sources");
  });

  it("plan.complete_step marks by id AND by exact text", () => {
    const state: PlanState = { steps: [] };
    applyPlanOp(state, "plan.set", { steps: ["alpha", "beta"] });
    const alphaId = state.steps[0]!.id;
    applyPlanOp(state, "plan.complete_step", { step: alphaId });
    applyPlanOp(state, "plan.complete_step", { step: "beta" }); // by text
    expect(state.steps.every((s) => s.done)).toBe(true);
  });

  it("plan.add_step appends; plan.clear empties", () => {
    const state: PlanState = { steps: [] };
    applyPlanOp(state, "plan.set", { steps: ["one"] });
    applyPlanOp(state, "plan.add_step", { step: "two" });
    expect(state.steps).toHaveLength(2);
    applyPlanOp(state, "plan.clear", {});
    expect(state.steps).toHaveLength(0);
  });

  it("caps a runaway plan.set at MAX_PLAN_STEPS", () => {
    const state: PlanState = { steps: [] };
    applyPlanOp(state, "plan.set", { steps: Array.from({ length: 200 }, (_, i) => `step ${i}`) });
    expect(state.steps.length).toBeLessThanOrEqual(40);
  });
});

describe("the plan prebuilt ops (through ScriptToolSurface)", () => {
  it("plan.set writes env.plan and reports the board; plan.complete_step ticks a step", async () => {
    const env = makeEnv();
    env.plan = { steps: [] }; // the loop normally does this; set it here to drive the op directly
    const tools = new ScriptToolSurface(env, ["plan"]);

    const setRes = await tools.run("plan.set", { steps: ["a", "b"] });
    expect(setRes.ok).toBe(true);
    expect((setRes.output as { total: number; remaining: number }).total).toBe(2);
    expect((setRes.output as { remaining: number }).remaining).toBe(2);
    expect(env.plan.steps).toHaveLength(2);

    const doneRes = await tools.run("plan.complete_step", { step: "a" });
    expect(doneRes.ok).toBe(true);
    expect((doneRes.output as { completed: number }).completed).toBe(1);
    expect(env.plan.steps.find((s) => s.text === "a")!.done).toBe(true);
  });

  it("plan.complete_step on a non-existent step reports ok:false in its output, not a silent success", async () => {
    const env = makeEnv();
    env.plan = { steps: [] };
    const tools = new ScriptToolSurface(env, ["plan"]);
    await tools.run("plan.set", { steps: ["real"] });
    const res = await tools.run("plan.complete_step", { step: "does-not-exist" });
    // The op ran (ScriptRunResult.ok true, the codebase convention), but its OWN output.ok is false.
    expect((res.output as { ok: boolean }).ok).toBe(false);
    expect(env.plan.steps[0]!.done).toBe(false); // nothing was marked
  });

  it("degrades to a clear message when there is no active run (env.plan absent)", async () => {
    const env = makeEnv(); // no env.plan
    const tools = new ScriptToolSurface(env, ["plan"]);
    const res = await tools.run("plan.status", {});
    const out = res.output as { ok: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/live agent run/i);
  });
});

describe("loop plan gate — don't stop until the plan is done", () => {
  it("refuses a premature answer while a step is open, then allows it once the plan is finished", async () => {
    const env = makeEnv();
    const tools = new ScriptToolSurface(env, ["plan"]);
    const { reasoner, seen } = scriptedReasoner([
      { action: "run", name: "plan.set", params: { steps: ["step one", "step two"] } },
      { action: "answer", text: "premature — should be refused" },
      { action: "run", name: "plan.complete_step", params: { step: "step one" } },
      { action: "run", name: "plan.complete_step", params: { step: "step two" } },
      { action: "answer", text: "all done" },
    ]);

    const result = await runScriptLoop(env, tools, reasoner, ["plan"], LOOP_OPTS);

    // The premature answer did NOT end the run; the final answer (after completing the plan) did.
    expect(result.result?.ok).toBe(true);
    expect(result.result?.output).toBe("all done");
    // 5 decide calls: the refused answer forced an extra turn rather than ending the run.
    expect(seen).toHaveLength(5);
  });

  it("shows the model a plan-not-finished correction after a refused stop", async () => {
    const env = makeEnv();
    const tools = new ScriptToolSurface(env, ["plan"]);
    const { reasoner, seen } = scriptedReasoner([
      { action: "run", name: "plan.set", params: { steps: ["only step"] } },
      { action: "answer", text: "too early" },
      { action: "run", name: "plan.complete_step", params: { step: "only step" } },
      { action: "answer", text: "done" },
    ]);

    await runScriptLoop(env, tools, reasoner, ["plan"], LOOP_OPTS);

    // The turn AFTER the refused answer must carry the correction in its priorSteps.
    const afterRefusal = seen[2]!.priorSteps ?? [];
    const correction = afterRefusal.find((p) => p.name === "(plan not finished)");
    expect(correction).toBeDefined();
    expect(correction!.ok).toBe(false);
    expect(correction!.error).toMatch(/1 step\(s\) not marked done/);
  });

  it("passes the committed plan to the reasoner once one is set", async () => {
    const env = makeEnv();
    const tools = new ScriptToolSurface(env, ["plan"]);
    const { reasoner, seen } = scriptedReasoner([
      { action: "run", name: "plan.set", params: { steps: ["x", "y"] } },
      { action: "run", name: "plan.complete_step", params: { step: "x" } },
      { action: "run", name: "plan.complete_step", params: { step: "y" } },
      { action: "answer", text: "done" },
    ]);

    await runScriptLoop(env, tools, reasoner, ["plan"], LOOP_OPTS);

    // First decision: no plan yet. A later decision (after plan.set): the plan is present.
    expect(seen[0]!.plan).toBeUndefined();
    const withPlan = seen.find((s) => s.plan !== undefined);
    expect(withPlan).toBeDefined();
    expect(withPlan!.plan!.total).toBe(2);
  });

  it("give_up is gated the same as answer while a plan is open", async () => {
    const env = makeEnv();
    const tools = new ScriptToolSurface(env, ["plan"]);
    const { reasoner, seen } = scriptedReasoner([
      { action: "run", name: "plan.set", params: { steps: ["do it"] } },
      { action: "give_up", reason: "bailing early" },
      { action: "run", name: "plan.complete_step", params: { step: "do it" } },
      { action: "answer", text: "finished after all" },
    ]);

    const result = await runScriptLoop(env, tools, reasoner, ["plan"], LOOP_OPTS);
    // The give_up with an open plan was refused; the run continued and answered.
    expect(result.result?.ok).toBe(true);
    expect(result.result?.output).toBe("finished after all");
    expect(seen).toHaveLength(4);
  });

  it("a run with no plan is unaffected — answers immediately", async () => {
    const env = makeEnv();
    const tools = new ScriptToolSurface(env, ["plan"]);
    const { reasoner, seen } = scriptedReasoner([
      { action: "answer", text: "no plan, straight answer" },
    ]);
    const result = await runScriptLoop(env, tools, reasoner, ["plan"], LOOP_OPTS);
    expect(result.result?.output).toBe("no plan, straight answer");
    expect(seen).toHaveLength(1);
  });

  it("a plan set before a suspend is reconstructed on resume (resumeSteps), so the gate still applies", async () => {
    const env = makeEnv();
    const tools = new ScriptToolSurface(env, ["plan"]);
    // Resume: the original run had set a 2-step plan and completed one; the plan.* calls are in
    // resumeSteps as history (not re-executed). The resumed run tries to answer with the second
    // step still open → must be refused.
    const { reasoner, seen } = scriptedReasoner([
      { action: "answer", text: "resuming and stopping early" }, // refused: step two still open
      { action: "run", name: "plan.complete_step", params: { step: "step two" } },
      { action: "answer", text: "now finished" },
    ]);

    const result = await runScriptLoop(env, tools, reasoner, ["plan"], {
      ...LOOP_OPTS,
      resumeSteps: [
        { name: "plan.set", params: { steps: ["step one", "step two"] }, ok: true },
        { name: "plan.complete_step", params: { step: "step one" }, ok: true },
      ],
    });

    expect(result.result?.output).toBe("now finished");
    // The first answer was refused because the reconstructed plan still had step two open.
    expect(seen).toHaveLength(3);
  });
});
