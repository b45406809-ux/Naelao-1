/**
 * fabric (Memory OS Layer 4 — spec "6-Layer Memory OS", byte ~148161: "Cross-session context
 * consolidator based on the Icarus framework. Runs LLM-driven session extraction post-run and
 * exposes tools such as fabric_recall and fabric_brief to summarize work.").
 *
 * The "LLM-driven session extraction" is the AGENT'S OWN job — it calls fabric.record with
 * whatever summary/key_insights it distills from the run it just finished, the same
 * self-managed pattern as memory.remember (Hermes pattern). NaelaoAgentDO also auto-records a
 * lightweight fabric entry after every successful /script/run so cross-session context exists
 * even for agents that never call this explicitly — see handleScriptRun.
 */

import type { PrebuiltScript, PrebuiltOpContext } from "./index.js";

function userIdFor(args: Record<string, unknown>, ctx: PrebuiltOpContext): string | undefined {
  const explicit = args["user_id"];
  if (typeof explicit === "string" && explicit) return explicit;
  return ctx.env.userId;
}

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export const fabric: PrebuiltScript = {
  name: "fabric",
  description:
    "Cross-session memory (Layer 4): record what this session accomplished, recall past sessions relevant to a topic, or get a quick brief of recent work.",
  domain: "knowledge",
  requires_tier: 1,
  operations: {
    async "fabric.record"(args, ctx) {
      if (!ctx.env.memoryStore) return { ok: false, reason: "memory store not available in this environment" };
      const summary = String(args["summary"] ?? "");
      if (!summary) throw new Error("fabric.record requires 'summary'");
      const sessionId = String(args["session_id"] ?? ctx.env.agentId ?? "unknown");
      const userId = userIdFor(args, ctx);
      return ctx.env.memoryStore.recordFabric({
        ...(userId ? { userId } : {}),
        sessionId,
        summary,
        keyInsights: stringArray(args["key_insights"]),
      });
    },
    async "fabric.recall"(args, ctx) {
      if (!ctx.env.memoryStore) return { ok: false, reason: "memory store not available in this environment" };
      const text = String(args["query"] ?? args["text"] ?? "");
      if (!text) throw new Error("fabric.recall requires 'query'");
      const userId = userIdFor(args, ctx);
      return ctx.env.memoryStore.recallFabric({
        ...(userId ? { userId } : {}),
        text,
        limit: typeof args["limit"] === "number" ? (args["limit"] as number) : 5,
      });
    },
    async "fabric.brief"(args, ctx) {
      if (!ctx.env.memoryStore) return { ok: false, reason: "memory store not available in this environment" };
      const userId = userIdFor(args, ctx);
      return ctx.env.memoryStore.briefFabric(userId, typeof args["limit"] === "number" ? (args["limit"] as number) : 5);
    },
  },
  paramHints: {
    "fabric.record": "summary (string, REQUIRED — the field is `summary`, NOT `content`/`text`/`note`). tags (string[], optional).",
    "fabric.recall": "query (string, REQUIRED — the field is `query`, not `text`). limit (number, optional).",
    "fabric.brief": "limit (number, optional) — no required fields.",
  },
};
