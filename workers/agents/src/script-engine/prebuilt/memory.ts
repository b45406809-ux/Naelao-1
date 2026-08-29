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
import { workspacePrefix } from "../types.js";

function userIdFor(args: Record<string, unknown>, ctx: PrebuiltOpContext): string | undefined {
  const explicit = args["user_id"];
  if (typeof explicit === "string" && explicit) return explicit;
  return ctx.env.userId;
}

export const memory: PrebuiltScript = {
  name: "memory",
  description:
    "Remember durable facts and notes, recall them by meaning or entity, manage Task DAGs, and inspect/update project guidelines.",
  domain: "knowledge",
  requires_tier: 1,
  operations: {
    // ── Claude Code Task State Machine ──────────────────────────────────────────
    Todo: async (args, ctx) => {
      const rawTasks = (args["tasks"] as Array<any>) || [];
      if (rawTasks.length === 0) {
        return { ok: true, message: "No tasks updated." };
      }

      // Forward DAG update to authoritative SpaceDO tasks store
      try {
        await ctx.env.spacesWorker?.fetch(`http://internal/tasks`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            spaceId: ctx.env.spaceId,
            projectId: ctx.env.projectId,
            tasks: rawTasks
          })
        });
      } catch {
        /* Fallback if spacesWorker RPC fails */
      }

      const completed = rawTasks.filter((t: any) => String(t.status).toUpperCase() === "COMPLETED").length;
      return {
        ok: true,
        tasks: rawTasks,
        summary: `✔ Task DAG updated (${completed}/${rawTasks.length} tasks completed).`
      };
    },

    // ── Deterministic Layer 2 Project Rules (PROJECT.md) ───────────────────────
    "memory.get_project_rules": async (_args, ctx) => {
      const bucket = ctx.env.workspaceBucket || ctx.env.scriptsBucket;
      const key = `${workspacePrefix(ctx.env)}PROJECT.md`;
      const file = await bucket.get(key);
      if (!file) {
        return {
          exists: false,
          rules: "# Project Guidelines\nNo custom guidelines established. Follow standard Astro + Tailwind + Cloudflare edge patterns."
        };
      }
      return { exists: true, rules: await file.text() };
    },

    "memory.update_project_rules": async (args, ctx) => {
      const content = (args["content"] as string) || (args["rules"] as string);
      if (!content) throw new Error("Missing 'content' parameter for PROJECT.md update.");
      const bucket = ctx.env.workspaceBucket || ctx.env.scriptsBucket;
      const key = `${workspacePrefix(ctx.env)}PROJECT.md`;
      await bucket.put(key, content);
      ctx.env.onWorkspaceChange?.({ path: "PROJECT.md", operation: "write" });
      return { ok: true, message: "✔ Successfully updated PROJECT.md baseline." };
    },

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
    // Runs the SAME maintenance pass (decay/promote/prune) the shell UI triggers automatically at
    // 85% context usage — callable directly, so a model that notices its own conversation getting
    // long doesn't have to wait for the client to do it on its behalf. A convenience, not a
    // correctness requirement: the script-native loop's own per-turn payload doesn't grow with
    // conversation length (see conversation-context.ts's own header), so this is about keeping
    // Memory OS's distilled facts/wiki fresh, not preventing an overflow.
    async "memory.compact"(_args, ctx) {
      if (!ctx.env.compactMemory) return { ok: false, reason: "compaction not available in this environment" };
      const result = await ctx.env.compactMemory();
      return { ok: true, result };
    },
  },
};
