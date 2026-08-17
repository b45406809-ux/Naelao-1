/**
 * sub-agent (spec §12.1) — spawn and coordinate sub-agents for parallel task execution.
 * Operations: agent.spawn, agent.send, agent.receive, agent.terminate.
 *
 * Spawning a sub-agent needs the NaelaoAgentDO namespace, which the engine does not own,
 * so these operations delegate to host-provided orchestration hooks. When the host has
 * not wired them, the operation reports itself unavailable (honest degradation).
 */

import type { PrebuiltScript, PrebuiltOpContext } from "./index.js";
import type { OrchestrationHooks } from "../types.js";
import {
  ALLOWED_MODELS,
  DEFAULT_WORKING_MODEL,
  capabilityForModel,
  contextWindowForModel,
  benchmarkForModel,
} from "@naelao/billing-core";

function hooks(ctx: PrebuiltOpContext): OrchestrationHooks {
  return ctx.env.orchestration ?? {};
}

export const subAgent: PrebuiltScript = {
  name: "sub-agent",
  description:
    "Spawn, message, and terminate sub-agents for parallel work, and see which models a spawn " +
    "can actually be given.",
  domain: "orchestration",
  requires_tier: 2,
  paramHints: {
    "agent.spawn":
      "tasks (array, required) — each {goal, model?, maxTokens?}. `model` must be one from " +
      "agent.list_models; an unavailable or too-expensive one is clamped to what the current " +
      "Effort setting allows and the result says so. Omit it to let the platform choose.",
    "agent.list_models":
      "No arguments. Returns every model a spawn may name, with its context window, whether it " +
      "supports a thinking budget, and its cost tier — call this before guessing a model id.",
  },
  operations: {
    // Every op that takes a model needs a way to find out what the real ones are. Without this an
    // agent either guesses an id (and gets a provider 404) or never sets one at all, which makes
    // the whole per-task model choice unusable in practice.
    async "agent.list_models"() {
      return {
        default: DEFAULT_WORKING_MODEL,
        models: ALLOWED_MODELS.map((m) => {
          const cap = capabilityForModel(m);
          const bench = benchmarkForModel(m);
          return {
            id: m,
            family: bench?.family ?? null,
            cost_tier: bench?.costTier ?? null,
            context_window: contextWindowForModel(m),
            supports_thinking: cap.reasoningLevels.length > 0,
            thinking_levels: cap.reasoningLevels,
            best_for: bench?.bestFor ?? [],
          };
        }),
      };
    },
    async "agent.spawn"(args, ctx) {
      const h = hooks(ctx);
      if (!h.spawnSubAgent) return { ok: false, reason: "sub-agent spawning not available in this environment" };
      return await h.spawnSubAgent(args);
    },
    async "agent.send"(args, ctx) {
      const h = hooks(ctx);
      if (!h.sendToSubAgent) return { ok: false, reason: "sub-agent messaging not available" };
      return await h.sendToSubAgent(String(args["id"] ?? ""), args["task"]);
    },
    async "agent.receive"(args, ctx) {
      const h = hooks(ctx);
      if (!h.receiveFromSubAgent) return { ok: false, reason: "sub-agent receive not available" };
      return await h.receiveFromSubAgent(String(args["id"] ?? ""));
    },
    async "agent.terminate"(args, ctx) {
      const h = hooks(ctx);
      if (!h.terminateSubAgent) return { ok: false, reason: "sub-agent terminate not available" };
      await h.terminateSubAgent(String(args["id"] ?? ""));
      return { ok: true };
    },
  },
};
