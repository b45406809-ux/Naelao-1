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
  isAllowedModel,
  suggestModels,
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
      // Validate any explicitly-named model BEFORE delegating. A wrong id must get a real
      // "not available / did you mean" answer, not a silent clamp (which read as a misleading
      // "too expensive for your Effort" reason, since resolveEscalationModel can't tell an
      // invalid id from a valid-but-pricey one) and never a bare provider 404 down the line.
      // This is the model-selector's own allowlist — the same list agent.list_models returns.
      const tasks = Array.isArray(args["tasks"]) ? (args["tasks"] as Array<Record<string, unknown>>) : [];
      for (const t of tasks) {
        const m = t && typeof t["model"] === "string" ? (t["model"] as string) : "";
        if (m && !isAllowedModel(m)) {
          const suggestions = suggestModels(m);
          return {
            ok: false,
            error:
              `model "${m}" is not available.` +
              (suggestions.length ? ` Did you mean: ${suggestions.join(", ")}?` : "") +
              ` Call agent.list_models to see every model a spawn may name (omit "model" to let the platform choose).`,
            did_you_mean: suggestions,
            available_models: ALLOWED_MODELS as readonly string[],
          };
        }
      }
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
