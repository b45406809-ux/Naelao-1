/**
 * plan — the agent's own checklist for the CURRENT run (Claude Code's TodoWrite pattern),
 * distinct from `tasks` (the durable, per-project, cross-agent DAG in SpaceDO — see tasks.ts).
 *
 * Why a run-scoped plan matters, and why it has teeth: a research/multi-step agent that lays out a
 * plan and then stops after the first easy step is the single most common way autonomous work goes
 * half-done. So this is NOT a passive note-taking tool — once a plan is set, loop.ts REFUSES a
 * terminal `answer`/`give_up` while any step is still incomplete, telling the model to finish the
 * work and mark the step done (plan.complete_step) first. The only ways a run with an unfinished
 * plan ends are the ones the user explicitly allows: a real error, running out of budget/time, or
 * the user pressing Stop. See loop.ts's plan gate.
 *
 * State lives on `ctx.env.plan` — a single mutable object the loop owns (it creates one fresh per
 * run and reconstructs it from a resumed run's history). These ops read/write that same object, so
 * what the model sees here is exactly what the loop enforces. When there is no active run wiring it
 * (a bare test/caller), the ops degrade to a clear message rather than throwing.
 */

import type { PrebuiltScript, PrebuiltOpContext } from "./index.js";
import type { PlanState, PlanStep } from "../types.js";

/** Cap the plan so a runaway plan.set can't bloat the reasoner payload — a real plan is a handful
 *  of steps, not hundreds. */
const MAX_PLAN_STEPS = 40;

function slug(text: string, index: number): string {
  const base = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
  return `s${index + 1}${base ? "-" + base : ""}`;
}

/** Match a step by its id OR by an exact (case-insensitive, trimmed) text match — models refer to
 *  a step by whichever they have to hand, and forcing them to remember the generated id would just
 *  create a failure mode. */
function findStep(state: PlanState, ref: string): PlanStep | undefined {
  const needle = ref.trim().toLowerCase();
  return state.steps.find((s) => s.id === ref || s.text.trim().toLowerCase() === needle);
}

/**
 * Apply one plan operation to a plan state, in place, and return that same state.
 *
 * The SINGLE source of truth for what each plan op does — used both by the prebuilt ops below (the
 * live path) AND by loop.ts's reconstruction of a resumed run's plan (replaying the recorded
 * plan.* calls from resumeSteps). Keeping both on one function is what guarantees a reconstructed
 * plan is byte-identical to the one the original run held.
 */
export function applyPlanOp(state: PlanState, name: string, params: Record<string, unknown>): PlanState {
  switch (name) {
    case "plan.set": {
      const raw = Array.isArray(params["steps"]) ? (params["steps"] as unknown[]) : [];
      const texts = raw.map((s) => String(s).trim()).filter(Boolean).slice(0, MAX_PLAN_STEPS);
      state.steps = texts.map((text, i) => ({ id: slug(text, i), text, done: false }));
      return state;
    }
    case "plan.add_step": {
      if (state.steps.length >= MAX_PLAN_STEPS) return state;
      const text = String(params["step"] ?? "").trim();
      if (text) state.steps.push({ id: slug(text, state.steps.length), text, done: false });
      return state;
    }
    case "plan.complete_step": {
      const ref = String(params["step"] ?? "").trim();
      const target = ref ? findStep(state, ref) : undefined;
      if (target) target.done = true;
      return state;
    }
    case "plan.clear": {
      state.steps = [];
      return state;
    }
    default:
      return state;
  }
}

/** Human-readable snapshot of the plan, returned by every op so the model always sees the whole
 *  board (done/total + each step's status) after touching it. */
function render(state: PlanState): { ok: true; total: number; completed: number; remaining: number; steps: Array<{ id: string; text: string; done: boolean }> } {
  const completed = state.steps.filter((s) => s.done).length;
  return {
    ok: true,
    total: state.steps.length,
    completed,
    remaining: state.steps.length - completed,
    steps: state.steps.map((s) => ({ id: s.id, text: s.text, done: s.done })),
  };
}

function ensurePlan(ctx: PrebuiltOpContext): PlanState | { ok: false; error: string } {
  if (!ctx.env.plan) {
    return { ok: false, error: "plan is only available inside a live agent run (the loop wires it) — there is nothing to plan against here." };
  }
  return ctx.env.plan;
}

export const plan: PrebuiltScript = {
  name: "plan",
  description:
    "Your checklist for THIS task. Lay out the steps up front with plan.set, then work through " +
    "them and mark each done with plan.complete_step as you finish it. Once you set a plan you are " +
    "held to it: you cannot answer or give up while steps are still open — finish the work and tick " +
    "the step, or (only if a step is genuinely impossible) say so plainly in your answer. Use this " +
    "for anything with more than one real step; it is what keeps a multi-step job from stopping " +
    "half-done.",
  domain: "orchestration",
  requires_tier: 1,
  paramHints: {
    "plan.set": "steps (string[], REQUIRED) — the ordered steps you intend to do, one short phrase each.",
    "plan.add_step": "step (string, REQUIRED) — one new step to append to the current plan.",
    "plan.complete_step": "step (string, REQUIRED) — the id (from plan.status) OR the exact text of the step you just finished.",
    "plan.status": "no params — returns the current plan with each step's done/not-done status.",
    "plan.clear": "no params — discards the current plan entirely (rarely needed; prefer completing steps).",
  },
  operations: {
    async "plan.set"(a, c) {
      const state = ensurePlan(c);
      if ("error" in state) return state;
      if (!Array.isArray(a["steps"]) || a["steps"].length === 0) {
        return { ok: false, error: "plan.set requires a non-empty 'steps' array (the ordered steps you'll do)." };
      }
      applyPlanOp(state, "plan.set", a);
      return render(state);
    },
    async "plan.add_step"(a, c) {
      const state = ensurePlan(c);
      if ("error" in state) return state;
      if (!String(a["step"] ?? "").trim()) return { ok: false, error: "plan.add_step requires 'step' (the step text)." };
      applyPlanOp(state, "plan.add_step", a);
      return render(state);
    },
    async "plan.complete_step"(a, c) {
      const state = ensurePlan(c);
      if ("error" in state) return state;
      const ref = String(a["step"] ?? "").trim();
      if (!ref) return { ok: false, error: "plan.complete_step requires 'step' (the id or exact text of the finished step)." };
      const before = state.steps.filter((s) => s.done).length;
      applyPlanOp(state, "plan.complete_step", a);
      const after = state.steps.filter((s) => s.done).length;
      if (after === before) {
        const snapshot = render(state);
        return {
          ok: false,
          error: `no plan step matches "${ref}". Use plan.status to see the exact ids/text.`,
          total: snapshot.total,
          remaining: snapshot.remaining,
          steps: snapshot.steps,
        };
      }
      return render(state);
    },
    async "plan.status"(_a, c) {
      const state = ensurePlan(c);
      if ("error" in state) return state;
      return render(state);
    },
    async "plan.clear"(_a, c) {
      const state = ensurePlan(c);
      if ("error" in state) return state;
      applyPlanOp(state, "plan.clear", {});
      return render(state);
    },
  },
};
