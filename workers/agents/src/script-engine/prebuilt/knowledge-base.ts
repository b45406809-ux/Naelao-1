/**
 * knowledge-base (spec §12.3) — Vectorize RAG integration for long-term semantic memory
 * that persists across sessions. Tier 2.
 *
 * Operations: knowledge.search, knowledge.index, knowledge.delete.
 * Routed through the knowledge worker service binding (which owns the shared multi-tenant
 * Vectorize index with spaceId filtering — see CLAUDE.md).
 */

import type { PrebuiltScript, PrebuiltOpContext } from "./index.js";

function reqWorker(ctx: PrebuiltOpContext): Fetcher {
  if (!ctx.env.knowledgeWorker) {
    throw new Error("knowledge-base: KNOWLEDGE_WORKER binding not configured");
  }
  return ctx.env.knowledgeWorker;
}

export const knowledgeBase: PrebuiltScript = {
  name: "knowledge-base",
  description: "Semantic search, index, and delete over the Space knowledge base (Vectorize RAG).",
  domain: "knowledge",
  requires_tier: 2,
  operations: {
    async "knowledge.search"(args, ctx) {
      const query = String(args["query"] ?? "");
      const topK = typeof args["top_k"] === "number" ? (args["top_k"] as number) : 5;
      const resp = await reqWorker(ctx).fetch(
        new Request(
          `http://knowledge-worker/spaces/${ctx.env.spaceId}/kb/search?q=${encodeURIComponent(query)}&top_k=${topK}`,
          { headers: { "x-naelao-tenant-id": ctx.env.tenantId } }
        )
      );
      if (!resp.ok) throw new Error(`knowledge.search failed: ${resp.status}`);
      return await resp.json();
    },

    async "knowledge.index"(args, ctx) {
      const resp = await reqWorker(ctx).fetch(
        new Request(`http://knowledge-worker/spaces/${ctx.env.spaceId}/kb/index`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-naelao-tenant-id": ctx.env.tenantId },
          body: JSON.stringify({ text: args["text"], metadata: args["metadata"] ?? {} }),
        })
      );
      if (!resp.ok) throw new Error(`knowledge.index failed: ${resp.status}`);
      return await resp.json();
    },

    async "knowledge.delete"(args, ctx) {
      const id = String(args["id"] ?? "");
      const resp = await reqWorker(ctx).fetch(
        new Request(`http://knowledge-worker/spaces/${ctx.env.spaceId}/kb/${encodeURIComponent(id)}`, {
          method: "DELETE",
          headers: { "x-naelao-tenant-id": ctx.env.tenantId },
        })
      );
      if (!resp.ok) throw new Error(`knowledge.delete failed: ${resp.status}`);
      return { ok: true };
    },
  },
};
