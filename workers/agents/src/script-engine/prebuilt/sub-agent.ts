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
    "Spawn, resume, and inspect delegated workers, and see which models a spawn " +
    "can actually be given.",
  domain: "orchestration",
  requires_tier: 2,
  paramHints: {
    "agent.spawn":
      "tasks (array, required) — each {goal, worker_model?, maxTokens?, model_requirements?:{inputModalities:[text|image|audio|video],minContextTokens:16000..2000000}}. worker_model is accepted only when the owner configured planner selection and the exact model appears in agent.list_models. In automatic mode omit it; System One selects from live-card-verified candidates. Use a " +
      "stable sub_agent_id to address a worker session; use resume:true only to continue that session.",
    "agent.list_models":
      "No arguments. Returns every model a spawn may name, with its context window, whether it " +
      "supports a thinking budget, and its cost tier — call this before guessing a model id.",
    "agent.resume":
      "id (string, required) — an existing worker session id; answer (string) or task (string) explains the clarification/follow-up. Resumes the same worker session and branch.",
    "agent.send":
      "id (string, required) and task (string or object, required). Continue work through the parent planner on that existing session; this is not peer-to-peer worker messaging.",
    "agent.receive":
      "id (string, required). Read the worker status, output, checkpoint, question, and retained workspace branch before deciding whether to resume it.",
  },
  operations: {
    // Every op that takes a model needs a way to find out what the real ones are. Without this an
    // agent either guesses an id (and gets a provider 404) or never sets one at all, which makes
    // the whole per-task model choice unusable in practice.
    async "agent.list_models"(_args, ctx) {
      return {
        default: DEFAULT_WORKING_MODEL,
        worker_selection_mode: ctx.env.workerModelPool?.selectionMode ?? "automatic",
        configured_worker_models: (ctx.env.workerModelCandidates ?? []).map(card => ({ id: card.model, name: card.name,
          context_window: card.contextLength, input_modalities:card.inputModalities, output_modalities:card.outputModalities, supported_parameters:card.supportedParameters, card_observed_at:card.catalogObservedAt, input_usd_per_million: card.promptPriceUsdPerToken === undefined ? null : card.promptPriceUsdPerToken * 1_000_000,
          output_usd_per_million: card.completionPriceUsdPerToken === undefined ? null : card.completionPriceUsdPerToken * 1_000_000 })),
        models: [...ALLOWED_MODELS.map((m) => {
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
        }), ...(ctx.env.workerModelCandidates ?? []).map(card => ({ id: card.model, family: "OpenRouter", cost_tier: null,
          context_window: card.contextLength ?? null, supports_thinking: false, thinking_levels: [], best_for: [],
          name: card.name, provider: "openrouter", source: "owner_configured_pool", input_modalities:card.inputModalities, output_modalities:card.outputModalities, supported_parameters:card.supportedParameters, card_observed_at:card.catalogObservedAt,
          input_usd_per_million: card.promptPriceUsdPerToken === undefined ? null : card.promptPriceUsdPerToken * 1_000_000,
          output_usd_per_million: card.completionPriceUsdPerToken === undefined ? null : card.completionPriceUsdPerToken * 1_000_000 })),
        ],
      };
    },
    async "agent.spawn"(args, ctx) {
      const h = hooks(ctx);
      if (!h.spawnSubAgent) return { ok: false, reason: "sub-agent spawning not available in this environment" };
      // Validate any explicitly-named model BEFORE delegating. A wrong id must get a real
      // "not available / did you mean" answer, not a silent clamp (which read as a misleading
      // "too expensive for your Effort" reason, since resolveEscalationModel can't tell an
      // invalid id from a valid-but-pricey one) and never a bare provider 404 down the line.
      // Built-in model identifiers and owner-configured OpenRouter models are validated separately.
      const tasks = Array.isArray(args["tasks"]) ? (args["tasks"] as Array<Record<string, unknown>>) : [];
      for (const t of tasks) {
        const m = t && typeof t["worker_model"] === "string" ? (t["worker_model"] as string) : "";
        if (m && (!ctx.env.workerModelPool || ctx.env.workerModelPool.selectionMode !== "planner"
          || !ctx.env.workerModelCandidates?.some(card => card.model === m))) {
          return { ok: false, error: `worker model '${m}' is not in the owner's currently enabled model pool`, available_models: (ctx.env.workerModelCandidates ?? []).map(card => card.model) };
        }
        const legacy = t && typeof t["model"] === "string" ? (t["model"] as string) : "";
        if (legacy && !isAllowedModel(legacy)) {
          const suggestions = suggestModels(legacy);
          return {
            ok: false,
            error:
              `model "${legacy}" is not available.` +
              (suggestions.length ? ` Did you mean: ${suggestions.join(", ")}?` : "") +
              ` Call agent.list_models to see every model a spawn may name (omit "model" to let the platform choose).`,
            did_you_mean: suggestions,
            available_models: ALLOWED_MODELS as readonly string[],
          };
        }
      }
      return await h.spawnSubAgent(args);
    },
    async "agent.resume"(args, ctx) {
      const h = hooks(ctx);
      if (!h.spawnSubAgent) return { ok: false, reason: "worker session resume is not available" };
      const id = typeof args["id"] === "string" ? args["id"].trim() : "";
      const answer = typeof args["answer"] === "string" ? args["answer"].trim() : "";
      const task = typeof args["task"] === "string" ? args["task"].trim() : "";
      if (!id || id.length > 192 || (!answer && !task) || answer.length > 8_000 || task.length > 4_000)
        return { ok: false, reason: "agent.resume requires a valid id and a bounded answer or follow-up task" };
      return h.spawnSubAgent({ tasks: [{ sub_agent_id: id, resume: true, ...(answer ? { answer } : {}), ...(task ? { goal: task } : {}) }] });
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
