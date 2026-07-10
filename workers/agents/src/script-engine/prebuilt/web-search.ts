/**
 * web-search (spec §12.3) — Tier 2 isolate. search(query), fetch_page(url),
 * extract_content(url, schema).
 *
 * UNIVERSAL / PLATFORM-PROVIDED (CLAUDE.md "universal tools" principle): web search is bundled
 * by Naelao exactly like Claude/ChatGPT bundle it — the builder never brings their own search
 * API key. The platform holds ONE search-provider key (Tavily) as a Workers Secret on the
 * knowledge worker, and every agent gets search for free. This is NOT the BYO-key
 * `space_credentials` model (that is only for a builder's own external accounts, e.g. their
 * Whop/Gumroad via mcp-connector). The key never reaches the agent — the isolate only ever sees
 * normalized results.
 *
 * `search`/`extract_content` need the platform provider key; when it is unset the op reports
 * itself unconfigured (`configured:false`) rather than silently returning empty results.
 * `fetch_page` is a generic SSRF-guarded HTTP GET and needs no key — it works out of the box.
 *
 * The route is HMAC-gated (like every other /internal/* route on the knowledge worker), so we
 * mint a short-lived tenant-scoped internal token per call — the agent never gets the key.
 */

import type { PrebuiltScript, PrebuiltOpContext } from "./index.js";
import { mintInternalToken } from "@naelao/http";

async function proxy(ctx: PrebuiltOpContext, path: string, body: unknown): Promise<unknown> {
  if (!ctx.env.knowledgeWorker) {
    throw new Error("web-search: search proxy (KNOWLEDGE_WORKER) not configured");
  }
  const token = await mintInternalToken(ctx.env.platformSecret ?? "", ctx.env.tenantId);
  const resp = await ctx.env.knowledgeWorker.fetch(
    new Request(`http://knowledge-worker${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": ctx.env.tenantId,
        "x-naelao-internal-token": token,
      },
      body: JSON.stringify(body),
    })
  );
  if (!resp.ok) throw new Error(`web-search ${path} failed: ${resp.status}`);
  return await resp.json();
}

export const webSearch: PrebuiltScript = {
  name: "web-search",
  description: "Search the web, fetch a page, and extract structured content (platform-provided, no key required).",
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
