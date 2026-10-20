/**
 * knowledge-base (spec §12.3) — Vectorize RAG integration for long-term semantic memory
 * that persists across sessions. Tier 2.
 *
 * Operations: knowledge.search, knowledge.index, knowledge.delete.
 * Routed through the knowledge worker service binding (which owns the shared multi-tenant
 * Vectorize index with spaceId filtering — see CLAUDE.md).
 */

import type { PrebuiltScript, PrebuiltOpContext } from "./index.js";
import { mintInternalToken, readBoundedResponseJson, readBoundedResponseText } from "@naelao/http";
import { wrapContextChunk } from "@naelao/rag";

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
    "x-naelao-user-id": ctx.env.userId ?? ctx.env.humanInvokerId ?? "system",
    "x-naelao-role": ctx.env.effectiveRole ?? "owner",
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
    "knowledge.search_brief": "{query: string, top_k?:1..5} — explicitly summarize authorized retrieved chunks; preserves source citations and labels derived text. Use ordinary search for exact quotations.",
    "knowledge.index": "{title: string, content: string, content_type?: 'text'|'url'|'code'|'pdf', source_url?: string} — title and content are BOTH required, or the write is rejected.",
    "knowledge.delete": "{id: string} — the kb_documents row id returned by knowledge.index (its own 'id' field), not a raw filename.",
    "knowledge.shared_document": "{source_space_id: string, document_id: string} — read one source document after its owner grants it and a member of this Space accepts that exact-document grant. Reads are audited and remain subject to source revocation.",
  },
  operations: {
    async "knowledge.search_brief"(args, ctx) {
      if (!ctx.env.documentProcessor || ctx.env.airGappedOnly || ctx.env.localModelMachine) throw new Error("document_processing_unavailable_for_retrieval");
      const topK = args["top_k"] ?? 3;
      if (!Number.isSafeInteger(topK) || Number(topK) < 1 || Number(topK) > 5) throw new Error("knowledge.search_brief top_k must be 1..5");
      const response = await knowledgeBase.operations["knowledge.search"]!({ query: args["query"], top_k: topK }, ctx) as { data?: Array<Record<string, unknown>>; [key: string]: unknown };
      if (!Array.isArray(response.data)) throw new Error("knowledge_search_response_invalid");
      const data: Array<Record<string, unknown>> = [];
      for (const hit of response.data) {
        if (typeof hit.content !== "string") throw new Error("knowledge_search_content_invalid");
        const result = await ctx.env.documentProcessor.summarize({ text: hit.content, sourceId: String(hit.chunk_id ?? hit.doc_id ?? "retrieved_chunk"),
          instructions: `Summarize this retrieved source for the question: ${String(args["query"] ?? "").slice(0, 2000)}. Keep relevant names, exact numbers, exclusions, conflicting claims and uncertainty. Never invent an answer absent from the source.`, maxOutputTokens: 500 });
        data.push({ ...hit, content: await wrapContextChunk({ content: `Derived summary, not a verbatim quotation:\n${result.text}` }),
          derivation: { kind: "summary", model: result.usage.model, source_chunk_id: hit.chunk_id, source_citation: hit.citation, processing_usage: result.usage } });
      }
      return { ...response, data, derived: true };
    },
    async "knowledge.search"(args, ctx) {
      const query = String(args["query"] ?? "");
      const topK = typeof args["top_k"] === "number" ? (args["top_k"] as number) : 5;
      const resp = await reqWorker(ctx).fetch(
        new Request(
          `http://knowledge-worker/spaces/${ctx.env.spaceId}/kb/search?q=${encodeURIComponent(query)}&top_k=${topK}${ctx.env.projectId ? `&project_id=${encodeURIComponent(ctx.env.projectId)}` : ""}`,
          { headers: await internalHeaders(ctx) }
        )
      );
      if (!resp.ok) throw new Error(`knowledge.search failed: ${resp.status}`);
      return await readBoundedResponseJson(resp, 2 * 1024 * 1024);
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
        const body = await readBoundedResponseText(resp, 8 * 1024).catch(() => "");
        throw new Error(`knowledge.index failed: ${resp.status}${body ? ` — ${body}` : ""}`);
      }
      return await readBoundedResponseJson(resp, 2 * 1024 * 1024);
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
        const body = await readBoundedResponseText(resp, 8 * 1024).catch(() => "");
        throw new Error(`knowledge.delete failed: ${resp.status}${body ? ` — ${body}` : ""}`);
      }
      return { ok: true };
    },

    async "knowledge.shared_document"(args, ctx) {
      if (!ctx.env.spacesWorker) throw new Error("shared knowledge unavailable: Spaces Worker binding not configured");
      if (!ctx.env.userId || !ctx.env.agentId || !ctx.env.runId) throw new Error("shared knowledge requires a user-bound agent run");
      const sourceSpaceId = String(args["source_space_id"] ?? "").trim();
      const documentId = String(args["document_id"] ?? "").trim();
      if (!sourceSpaceId || sourceSpaceId.length > 160 || !documentId || documentId.length > 160) throw new Error("source_space_id and document_id are required");
      const response = await ctx.env.spacesWorker.fetch(new Request(`http://spaces-worker/internal/spaces/${encodeURIComponent(ctx.env.spaceId)}/foundry/shared-document`, {
        method: "POST",
        headers: await internalHeaders(ctx, { "content-type": "application/json", "x-naelao-agent-id": ctx.env.agentId, "x-naelao-run-id": ctx.env.runId }),
        body: JSON.stringify({ source_space_id: sourceSpaceId, document_id: documentId }),
      }));
      if (!response.ok) throw new Error(`knowledge.shared_document failed: HTTP ${response.status}`);
      const result = await response.json<{ document: { id: string; title: string; source_url: string | null; content: string; chunk_count: number } }>();
      const maxChars = 30_000;
      const truncated = result.document.content.length > maxChars;
      return {
        document: { id: result.document.id, title: result.document.title, source_url: result.document.source_url, chunk_count: result.document.chunk_count },
        context: await wrapContextChunk({ content: JSON.stringify({ id: result.document.id, source: `explicitly shared document from Space ${sourceSpaceId}`, content: result.document.content.slice(0, maxChars) }) }),
        ...(truncated ? { truncated: true, original_chars: result.document.content.length } : {}),
      };
    },
  },
};
