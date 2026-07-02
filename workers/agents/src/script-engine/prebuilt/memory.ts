/**
 * memory (spec "Space Assistants — OpenClaw + CF Thinker + Memory OS", byte ~141822) —
 * the agent's self-managed memory. Operations: memory.remember, memory.recall, memory.forget.
 *
 * This is the missing "Hermes pattern" piece: rather than memory being something the host
 * silently injects into every prompt, the agent can explicitly write and query it mid-task
 * ("the customer said they prefer email over Slack — remember that"). Backed by
 * NaelaoAgentDO's Memory OS (structured facts + episodic log + Vectorize semantic layer),
 * injected as `ctx.env.memoryStore`. Degrades honestly when the host hasn't wired it.
 *
 * Defaults to the current run's `userId` (set per /script/run call) so per-user facts never
 * bleed across users in shared-assistant mode — pass `user_id` explicitly to override (e.g.
 * an admin's assistant remembering a space-wide fact with no user scope).
 */

import type { PrebuiltScript, PrebuiltOpContext } from "./index.js";

function userIdFor(args: Record<string, unknown>, ctx: PrebuiltOpContext): string | undefined {
  const explicit = args["user_id"];
  if (typeof explicit === "string" && explicit) return explicit;
  return ctx.env.userId;
}

export const memory: PrebuiltScript = {
  name: "memory",
  description:
    "Remember durable facts and notes, recall them by meaning or entity, and forget what's stale.",
  domain: "knowledge",
  requires_tier: 1,
  operations: {
    async "memory.remember"(args, ctx) {
      if (!ctx.env.memoryStore) return { ok: false, reason: "memory store not available in this environment" };
      const text = String(args["text"] ?? "");
      if (!text) throw new Error("memory.remember requires 'text'");
      const userId = userIdFor(args, ctx);
      return ctx.env.memoryStore.remember({
        ...(userId ? { userId } : {}),
        text,
        ...(args["entity"] ? { entity: String(args["entity"]) } : {}),
        ...(args["relation"] ? { relation: String(args["relation"]) } : {}),
        ...(args["attribute"] ? { attribute: String(args["attribute"]) } : {}),
        ...(typeof args["importance"] === "number" ? { importance: args["importance"] as number } : {}),
      });
    },
    async "memory.recall"(args, ctx) {
      if (!ctx.env.memoryStore) return { ok: false, reason: "memory store not available in this environment" };
      const text = String(args["query"] ?? args["text"] ?? "");
      if (!text) throw new Error("memory.recall requires 'query'");
      const userId = userIdFor(args, ctx);
      return ctx.env.memoryStore.recall({
        ...(userId ? { userId } : {}),
        text,
        limit: typeof args["limit"] === "number" ? (args["limit"] as number) : 5,
      });
    },
    async "memory.forget"(args, ctx) {
      if (!ctx.env.memoryStore) return { ok: false, reason: "memory store not available in this environment" };
      const id = String(args["id"] ?? "");
      if (!id) throw new Error("memory.forget requires 'id'");
      await ctx.env.memoryStore.forget(id);
      return { ok: true };
    },
  },
};
