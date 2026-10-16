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
 * run and reconstructs it from a resumed run's history). Edits are grouped in open/close
 * transactions; closing classifies the whole worker board once, while status changes are handled
 * deterministically and can prewarm the next exact authorized runtime. These ops read/write that same object, so
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
    case "plan.open_edit":
      if (state.editing) throw new Error("plan_edit_already_open");
      state.editing = true;
      return state;
    case "plan.set": {
      if (!state.editing) throw new Error("open_plan_edit_before_mutating_board");
      if (state.steps.some(step => step.status === "active")) throw new Error("cannot_replace_board_while_step_is_active");
      const raw = Array.isArray(params["steps"]) ? (params["steps"] as unknown[]) : [];
      const texts = raw.map((s) => String(s).trim()).filter(Boolean).slice(0, MAX_PLAN_STEPS);
      state.steps = texts.map((text, i) => ({ id: slug(text, i), text, done: false, status: "pending" as const }));
      return state;
    }
    case "plan.add_step": {
      if (!state.editing) throw new Error("open_plan_edit_before_mutating_board");
      if (state.steps.length >= MAX_PLAN_STEPS) return state;
      const text = String(params["step"] ?? "").trim();
      if (text) state.steps.push({ id: slug(text, state.steps.length), text, done: false, status: "pending" });
      return state;
    }
    case "plan.edit_step": {
      if (!state.editing) throw new Error("open_plan_edit_before_mutating_board");
      const target = findStep(state, String(params["step"] ?? ""));
      const text = String(params["text"] ?? "").trim();
      if (target && text && target.status !== "completed") {
        target.text = text;
        delete target.runtimeCapability;
        delete target.runtimeConfidence;
      }
      return state;
    }
    case "plan.remove_step": {
      if (!state.editing) throw new Error("open_plan_edit_before_mutating_board");
      const target = findStep(state, String(params["step"] ?? ""));
      if (target && target.status !== "active") state.steps = state.steps.filter((step) => step !== target);
      return state;
    }
    case "plan.close_edit": {
      state.editing = false;
      return state;
    }
    case "plan.start_step": {
      if (state.editing) throw new Error("close_plan_edit_before_starting_work");
      const target = findStep(state, String(params["step"] ?? ""));
      if (!target) return state;
      if (target.status === "completed" || target.done) return state;
      if (state.steps.some((step) => step.status === "active")) throw new Error("another_plan_step_is_active");
      const index = state.steps.indexOf(target);
      if (state.steps.slice(0, index).some((step) => step.status !== "completed" && !step.done)) throw new Error("earlier_plan_steps_must_be_completed_first");
      target.status = "active";
      return state;
    }
    case "plan.complete_step": {
      if (state.editing) throw new Error("close_plan_edit_before_status_change");
      const ref = String(params["step"] ?? "").trim();
      const target = ref ? findStep(state, ref) : undefined;
      if (target?.status === "active") { target.done = true; target.status = "completed"; }
      return state;
    }
    case "plan.clear": {
      if (!state.editing) throw new Error("open_plan_edit_before_mutating_board");
      if (state.steps.some(step => step.status === "active")) throw new Error("cannot_clear_board_while_step_is_active");
      state.steps = [];
      return state;
    }
    default:
      return state;
  }
}

/** Human-readable snapshot of the plan, returned by every op so the model always sees the whole
 *  board (done/total + each step's status) after touching it. */
function render(state: PlanState): { ok: true; editing: boolean; total: number; completed: number; remaining: number; steps: Array<{ id: string; text: string; done: boolean; status: string; runtime_capability?: string; runtime_confidence?: number }> } {
  const completed = state.steps.filter((s) => s.done).length;
  return {
    ok: true,
    editing: state.editing === true,
    total: state.steps.length,
    completed,
    remaining: state.steps.length - completed,
    steps: state.steps.map((s) => ({ id: s.id, text: s.text, done: s.done, status: s.status ?? (s.done ? "completed" : "pending"),
      ...(s.runtimeCapability ? { runtime_capability: s.runtimeCapability } : {}), ...(s.runtimeConfidence !== undefined ? { runtime_confidence: s.runtimeConfidence } : {}) })),
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
    "Your checklist for THIS task. Open an edit transaction, lay out the steps with plan.set, then close it. Work through " +
    "them and mark each done with plan.complete_step as you finish it. Once you set a plan you are " +
    "held to it: you cannot answer or give up while steps are still open — finish the work and tick " +
    "the step, or (only if a step is genuinely impossible) say so plainly in your answer. Use this " +
    "for anything with more than one real step; it is what keeps a multi-step job from stopping " +
    "half-done.",
  domain: "orchestration",
  requires_tier: 1,
  paramHints: {
    "plan.open_edit": "Begin one board edit transaction. Then use plan.set/add_step/edit_step/remove_step as needed and call plan.close_edit once; that batches one System One classification over the complete edited board.",
    "plan.set": "steps (string[], REQUIRED) — replace the ordered worker checklist inside an open plan edit transaction; close with plan.close_edit before starting work.",
    "plan.add_step": "step (string, REQUIRED) — append a board item during one edit transaction; close with plan.close_edit when edits are complete.",
    "plan.edit_step": "step (string, REQUIRED) and text (string, REQUIRED) — revise an unfinished item during edit mode.",
    "plan.remove_step": "step (string, REQUIRED) — remove an unfinished item during edit mode.",
    "plan.close_edit": "Close the current edit transaction. System One classifies all items together against this worker's available tools and approved runtimes; it does not authorize tools or select images.",
    "plan.start_step": "step (string, REQUIRED) — mark the next in-order item active. The deterministic host pins its authorized runtime and best-effort prewarms the following pending item's exact runtime.",
    "plan.complete_step": "step (string, REQUIRED) — mark the active item completed. Status changes do not call System One; use plan.start_step on the next item.",
    "plan.status": "no params — returns the current plan with each step's done/not-done status.",
    "plan.clear": "no params — discards the current plan inside an edit transaction (rarely needed; prefer completing steps).",
  },
  operations: {
    async "plan.set"(a, c) {
      const state = ensurePlan(c);
      if ("error" in state) return state;
      if (!Array.isArray(a["steps"]) || a["steps"].length === 0) {
        return { ok: false, error: "plan.set requires a non-empty 'steps' array (the ordered steps you'll do)." };
      }
      if (!state.editing) return { ok: false, error: "open_plan_edit_before_mutating_board" };
      if (state.steps.some(step => step.status === "active")) return { ok: false, error: "cannot_replace_board_while_step_is_active" };
      applyPlanOp(state, "plan.set", a);
      return render(state);
    },
    async "plan.open_edit"(_a, c) {
      const state = ensurePlan(c); if ("error" in state) return state;
      applyPlanOp(state, "plan.open_edit", {}); return render(state);
    },
    async "plan.add_step"(a, c) {
      const state = ensurePlan(c);
      if ("error" in state) return state;
      if (!String(a["step"] ?? "").trim()) return { ok: false, error: "plan.add_step requires 'step' (the step text)." };
      if (!state.editing) return { ok: false, error: "open_plan_edit_before_mutating_board" };
      applyPlanOp(state, "plan.add_step", a);
      return render(state);
    },
    async "plan.edit_step"(a, c) {
      const state = ensurePlan(c); if ("error" in state) return state;
      if (!String(a["step"] ?? "").trim() || !String(a["text"] ?? "").trim()) return { ok: false, error: "plan.edit_step requires step and text" };
      if (!state.editing) return { ok: false, error: "open_plan_edit_before_mutating_board" };
      applyPlanOp(state, "plan.edit_step", a); return render(state);
    },
    async "plan.remove_step"(a, c) {
      const state = ensurePlan(c); if ("error" in state) return state;
      if (!String(a["step"] ?? "").trim()) return { ok: false, error: "plan.remove_step requires step" };
      if (!state.editing) return { ok: false, error: "open_plan_edit_before_mutating_board" };
      applyPlanOp(state, "plan.remove_step", a); return render(state);
    },
    async "plan.close_edit"(_a, c) {
      const state = ensurePlan(c); if ("error" in state) return state;
      if (!state.editing) return { ok: false, error: "no_plan_edit_is_open" };
      const classify = c.env.classifyPlanRuntimes;
      let classifications: Array<{ stepId: string; capability?: string; confidence: number }> = [];
      let classificationError: string | undefined;
      if (classify) {
        try { classifications = await classify({ steps: state.steps, availableTools: [...(c.commands?.keys() ?? [])] }); }
        catch (error) { classificationError = error instanceof Error ? error.message.slice(0, 200) : "system_one_classification_unavailable"; }
      }
      applyPlanOp(state, "plan.close_edit", {});
      const byId = new Map(classifications.map(item => [item.stepId, item]));
      for (const step of state.steps) {
        const match = byId.get(step.id);
        if (match?.capability) step.runtimeCapability = match.capability;
        else delete step.runtimeCapability;
        if (match) step.runtimeConfidence = match.confidence;
        else delete step.runtimeConfidence;
      }
      const activeIndex = state.steps.findIndex(step => step.status === "active");
      const next = state.steps.slice(activeIndex + 1).find(step => !step.done && step.status !== "completed");
      const prewarm = next?.runtimeCapability && c.env.prewarmPlanRuntime ? await c.env.prewarmPlanRuntime(next.runtimeCapability).catch(error => ({ warmed: false, error: String(error) })) : undefined;
      return { ...render(state), classification_count: classifications.length, ...(classificationError ? { classification_error: classificationError } : {}),
        ...(next ? { prewarm_next: { step_id: next.id, ...(next.runtimeCapability ? { capability: next.runtimeCapability } : {}), ...(prewarm ? { warmed: prewarm.warmed, ...(prewarm.error ? { error: prewarm.error } : {}) } : { warmed: false }) } } : {}) };
    },
    async "plan.start_step"(a, c) {
      const state = ensurePlan(c); if ("error" in state) return state;
      const ref = String(a["step"] ?? "").trim(), target = ref ? findStep(state, ref) : undefined;
      if (!target) return { ok: false, error: "plan.start_step requires an existing step id or exact text" };
      if (state.editing) return { ok: false, error: "close_plan_edit_before_starting_work" };
      if (target.status === "completed" || target.done) return { ok: false, error: "plan_step_already_completed" };
      if (state.steps.some(step => step.status === "active")) return { ok: false, error: "another_plan_step_is_active" };
      const targetIndex = state.steps.indexOf(target);
      if (state.steps.slice(0, targetIndex).some(step => step.status !== "completed" && !step.done)) return { ok: false, error: "earlier_plan_steps_must_be_completed_first" };
      if (target.runtimeCapability && c.env.activatePlanRuntime) {
        try { await c.env.activatePlanRuntime(target.runtimeCapability); }
        catch (error) { return { ok: false, error: error instanceof Error ? error.message : "planned_runtime_unavailable" }; }
      } else await c.env.activatePlanRuntime?.();
      applyPlanOp(state, "plan.start_step", a);
      const next = state.steps.slice(state.steps.indexOf(target) + 1).find(step => !step.done && step.status !== "completed");
      const prewarm = next?.runtimeCapability && c.env.prewarmPlanRuntime ? await c.env.prewarmPlanRuntime(next.runtimeCapability).catch(error => ({ warmed: false, error: String(error) })) : undefined;
      return { ...render(state), ...(next ? { prewarm_next: { step_id: next.id, ...(next.runtimeCapability ? { capability: next.runtimeCapability } : {}), ...(prewarm ? { warmed: prewarm.warmed, ...(prewarm.error ? { error: prewarm.error } : {}) } : { warmed: false }) } } : {}) };
    },
    async "plan.complete_step"(a, c) {
      const state = ensurePlan(c);
      if ("error" in state) return state;
      const ref = String(a["step"] ?? "").trim();
      if (!ref) return { ok: false, error: "plan.complete_step requires 'step' (the id or exact text of the finished step)." };
      if (state.editing) return { ok: false, error: "close_plan_edit_before_status_change" };
      const before = state.steps.filter((s) => s.done).length;
      const requested = findStep(state, ref);
      if (requested?.status !== "active") return { ok: false, error: "only_the_active_plan_step_can_be_completed" };
      applyPlanOp(state, "plan.complete_step", a);
      const after = state.steps.filter((s) => s.done).length;
      if (after === before) {
        const snapshot = render(state);
        return {
          ok: false,
          error: state.editing ? "close_plan_edit_before_status_change" : requested?.status !== "active" ? "only_the_active_plan_step_can_be_completed" : `no plan step matches "${ref}". Use plan.status to see the exact ids/text.`,
          total: snapshot.total,
          remaining: snapshot.remaining,
          steps: snapshot.steps,
        };
      }
      const completed = findStep(state, ref);
      if (completed?.status === "completed" && c.env.planContainerInstallationId) await c.env.activatePlanRuntime?.();
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
      if (!state.editing) return { ok: false, error: "open_plan_edit_before_mutating_board" };
      if (state.steps.some(step => step.status === "active")) return { ok: false, error: "cannot_clear_board_while_step_is_active" };
      applyPlanOp(state, "plan.clear", {});
      return render(state);
    },
  },
};
