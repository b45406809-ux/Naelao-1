/**
 * knowledge-base (spec §12.3) — Vectorize RAG integration for long-term semantic memory
 * that persists across sessions. Tier 2.
 *
 * Operations: knowledge.search, knowledge.index, knowledge.delete.
 * Routed through the knowledge worker service binding (which owns the shared multi-tenant
 * Vectorize index with spaceId filtering — see CLAUDE.md).
 */

import type { PrebuiltScript, PrebuiltOpContext } from "./index.js";
import { mintInternalToken } from "@naelao/http";

function reqWorker(ctx: PrebuiltOpContext): Fetcher {
  if (!ctx.env.knowledgeWorker) {
    throw new Error("knowledge-base: KNOWLEDGE_WORKER binding not configured");
  }
  return ctx.env.knowledgeWorker;
}

async function internalHeaders(ctx: PrebuiltOpContext, extra?: Record<string, string>): Promise<Record<string, string>> {
  return {
    "x-naelao-tenant-id": ctx.env.tenantId,
    "x-naelao-internal-token": await mintInternalToken(ctx.env.platformSecret ?? "", ctx.env.tenantId),
    ...extra,
  };
}

export const knowledgeBase: PrebuiltScript = {
  name: "knowledge-base",
  description: "Semantic search, index, and delete over the Space knowledge base (Vectorize RAG).",
  domain: "knowledge",
  requires_tier: 2,
  // Phase 5: knowledge.index/knowledge.delete previously called routes that have never existed on
  // the real knowledge worker (/kb/index, /kb/{id} — the real routes are /kb/documents and
  // /kb/documents/:docId) — every real call 404'd. Fixed to the real contract; param hints (item
  // 133's own convention) name the actual required fields since the op names alone don't.
  paramHints: {
    "knowledge.search": "{query: string, top_k?: number}",
    "knowledge.index": "{title: string, content: string, content_type?: 'text'|'url'|'code'|'pdf', source_url?: string} — title and content are BOTH required, or the write is rejected.",
    "knowledge.delete": "{id: string} — the kb_documents row id returned by knowledge.index (its own 'id' field), not a raw filename.",
  },
  operations: {
    async "knowledge.search"(args, ctx) {
      const query = String(args["query"] ?? "");
      const topK = typeof args["top_k"] === "number" ? (args["top_k"] as number) : 5;
      const resp = await reqWorker(ctx).fetch(
        new Request(
          `http://knowledge-worker/spaces/${ctx.env.spaceId}/kb/search?q=${encodeURIComponent(query)}&top_k=${topK}`,
          { headers: await internalHeaders(ctx) }
        )
      );
      if (!resp.ok) throw new Error(`knowledge.search failed: ${resp.status}`);
      return await resp.json();
    },

    async "knowledge.index"(args, ctx) {
      const title = String(args["title"] ?? "").trim();
      const content = String(args["content"] ?? "");
      if (!title) throw new Error("knowledge.index requires a non-empty 'title'");
      if (!content) throw new Error("knowledge.index requires non-empty 'content'");
      const contentType = typeof args["content_type"] === "string" ? args["content_type"] : "text";
      const resp = await reqWorker(ctx).fetch(
        new Request(`http://knowledge-worker/spaces/${ctx.env.spaceId}/kb/documents`, {
          method: "POST",
          headers: await internalHeaders(ctx, { "content-type": "application/json" }),
          body: JSON.stringify({
            title,
            content,
            content_type: contentType,
            ...(typeof args["source_url"] === "string" ? { source_url: args["source_url"] } : {}),
            // Project-scoped writes stay in that project's own KB slice — never inferred when the
            // caller is the space-wide assistant (ctx.env.projectId absent for that context).
            ...(ctx.env.projectId ? { project_id: ctx.env.projectId } : {}),
          }),
        })
      );
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new Error(`knowledge.index failed: ${resp.status}${body ? ` — ${body}` : ""}`);
      }
      return await resp.json();
    },

    async "knowledge.delete"(args, ctx) {
      const id = String(args["id"] ?? "");
      if (!id) throw new Error("knowledge.delete requires 'id'");
      const resp = await reqWorker(ctx).fetch(
        new Request(`http://knowledge-worker/spaces/${ctx.env.spaceId}/kb/documents/${encodeURIComponent(id)}`, {
          method: "DELETE",
          headers: await internalHeaders(ctx),
        })
      );
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new Error(`knowledge.delete failed: ${resp.status}${body ? ` — ${body}` : ""}`);
      }
      return { ok: true };
    },
  },
};
