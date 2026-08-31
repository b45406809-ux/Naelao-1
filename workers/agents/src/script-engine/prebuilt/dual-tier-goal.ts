/**
 * dual-tier-goal prebuilt script.
 *
 * Implements the Frontier-Planner + Open-Worker (Context Isolation) execution mode.
 * Provides the autonomous `engine.plan_and_delegate_goal` operation for both:
 * 1. The Space Assistant (CEO) — on autonomous cron wakes or incoming emails, evaluates
 *    task complexity and delegates coding tasks to cheap Edge Workers in the target project.
 * 2. Project Threads & Agents — triggered directly or via `/goal <prompt>` / `@agent /goal <prompt>`.
 */

import type { PrebuiltScript, PrebuiltOpContext } from "./index.js";
import { runDualTierPipeline, generateFrontierArchitecturePlan, parseGoalCommand } from "../dual-tier-executor.js";

export const dualTierGoal: PrebuiltScript = {
  name: "dual_tier_goal",
  description:
    "Dual-Tier Architecture Mode (Frontier-Planner + Open-Worker Context Isolation). " +
    "Uses high-IQ Frontier models (Claude 3.7 / Opus / o3) to plan a clean Task DAG, " +
    "delegates isolated code tasks to cheap Edge Workers (Llama 3.3 70B / Qwen 2.5 Coder), " +
    "and audits the final diff with zero context pollution.",
  domain: "workflow",
  requires_tier: 1,
  operations: {
    "engine.plan_and_delegate_goal": async (args: Record<string, unknown>, ctx: PrebuiltOpContext) => {
      const rawGoal = String(args["goal"] ?? args["prompt"] ?? args["message"] ?? "").trim();
      if (!rawGoal) {
        throw new Error("'goal' (string describing the objective) is required");
      }

      const parsed = parseGoalCommand(rawGoal);
      const effectiveGoal = parsed.goalPrompt || rawGoal;

      const result = await runDualTierPipeline(effectiveGoal, ctx.env);
      return result;
    },

    "goal.plan": async (args: Record<string, unknown>, ctx: PrebuiltOpContext) => {
      const rawGoal = String(args["goal"] ?? args["prompt"] ?? "").trim();
      if (!rawGoal) {
        throw new Error("'goal' (string describing the objective) is required");
      }
      return await generateFrontierArchitecturePlan(rawGoal, ctx.env);
    },

    "goal.execute": async (args: Record<string, unknown>, ctx: PrebuiltOpContext) => {
      const rawGoal = String(args["goal"] ?? args["prompt"] ?? "").trim();
      if (!rawGoal) {
        throw new Error("'goal' (string describing the objective) is required");
      }
      return await runDualTierPipeline(rawGoal, ctx.env);
    },
  },
  paramHints: {
    "engine.plan_and_delegate_goal": "goal: string",
    "goal.plan": "goal: string",
    "goal.execute": "goal: string",
  },
};
