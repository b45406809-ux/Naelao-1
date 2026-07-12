/**
 * web-search (spec §12.3) — Tier 2 isolate. search(query), fetch_page(url),
 * extract_content(url, schema), grounded_answer(query) (§A1.25).
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
 *
 * `grounded_answer` (§A1.25) is a DIFFERENT mechanism, not a Tavily proxy: it calls the LLM
 * directly with Anthropic's native web-search tool enabled (proxied transparently by CF AI
 * Gateway — Unified Billing, no separate provider key). Search-and-synthesize happens in one
 * gateway-billed call instead of a search round trip + a second summarization call. Its token
 * usage is real and gets billed exactly like any reasoner call (see ScriptToolSurface.run()).
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
    // §A1.25: search-and-synthesize in ONE gateway-billed call — a cheap model with Anthropic's
    // native web-search tool enabled (proxied transparently by CF AI Gateway, same Unified
    // Billing as every other LLM call, no separate Tavily round trip for this op). Real usage is
    // returned in `output.usage` so ScriptToolSurface.run() bills it like any reasoner call —
    // this is NOT a free LLM call just because it's invoked from inside a script.
    async grounded_answer(args, ctx) {
      if (!ctx.env.llmCaller) {
        return { ok: false, reason: "grounded_answer unavailable: no LLM credentials configured on this host" };
      }
      const query = String(args["query"] ?? "");
      if (!query) throw new Error("grounded_answer requires 'query'");
      const model = typeof args["model"] === "string" ? (args["model"] as string) : "claude-haiku-4-5-20251001";
      const maxUses = typeof args["max_results"] === "number" ? (args["max_results"] as number) : undefined;
      const result = await ctx.env.llmCaller.callWithNativeWebSearch({ model, query, maxUses });
      return {
        answer: result.answer,
        citations: result.citations,
        usage: { tokens_used: result.tokens_used, input_tokens: result.input_tokens, output_tokens: result.output_tokens },
      };
    },
  },
};
