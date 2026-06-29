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

function hooks(ctx: PrebuiltOpContext): OrchestrationHooks {
  return ctx.env.orchestration ?? {};
}

export const subAgent: PrebuiltScript = {
  name: "sub-agent",
  description: "Spawn, message, and terminate sub-agents for parallel work.",
  domain: "orchestration",
  requires_tier: 2,
  operations: {
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
