/**
 * web-search (spec §12.3) — Tier 2 isolate. search(query), fetch_page(url),
 * extract_content(url, schema).
 *
 * The spec uses Tavily with the key in naelao-credentials. We route through the knowledge
 * worker's web-search proxy so the API key never reaches the agent (and lives in one place).
 * When the proxy is unavailable the operation reports itself unconfigured rather than
 * silently returning empty results.
 */

import type { PrebuiltScript, PrebuiltOpContext } from "./index.js";

async function proxy(ctx: PrebuiltOpContext, path: string, body: unknown): Promise<unknown> {
  if (!ctx.env.knowledgeWorker) {
    throw new Error("web-search: search proxy (KNOWLEDGE_WORKER) not configured");
  }
  const resp = await ctx.env.knowledgeWorker.fetch(
    new Request(`http://knowledge-worker${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": ctx.env.tenantId },
      body: JSON.stringify(body),
    })
  );
  if (!resp.ok) throw new Error(`web-search ${path} failed: ${resp.status}`);
  return await resp.json();
}

export const webSearch: PrebuiltScript = {
  name: "web-search",
  description: "Search the web, fetch a page, and extract structured content (Tavily via proxy).",
  domain: "api",
  requires_tier: 2,
  operations: {
    async search(args, ctx) {
      return proxy(ctx, "/internal/web-search/search", {
        query: String(args["query"] ?? ""),
        max_results: typeof args["max_results"] === "number" ? args["max_results"] : 10,
      });
    },
    async fetch_page(args, ctx) {
      return proxy(ctx, "/internal/web-search/fetch", { url: String(args["url"] ?? "") });
    },
    async extract_content(args, ctx) {
      return proxy(ctx, "/internal/web-search/extract", {
        url: String(args["url"] ?? ""),
        schema: args["schema"] ?? null,
      });
    },
  },
};
