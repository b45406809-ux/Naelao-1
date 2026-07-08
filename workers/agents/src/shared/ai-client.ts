/**
 * Canonical AI client factory — spec §15.
 *
 * Every LLM call in Naelao routes through Cloudflare AI Gateway (spec §15).
 * Two endpoint modes:
 *
 *  1. Provider-specific (single provider, used for direct Anthropic calls without fallback):
 *     https://gateway.ai.cloudflare.com/v1/{ACCOUNT_ID}/{GATEWAY_ID}/anthropic/v1/messages
 *
 *  2. Universal Endpoint (multi-provider failover — CF AI Gateway routes to the first
 *     available provider in the `providers` array; the gateway itself handles failover, no
 *     application-level retry needed):
 *     POST https://gateway.ai.cloudflare.com/v1/{ACCOUNT_ID}/{GATEWAY_ID}
 *     Body: { "providers": [ { "provider": "anthropic", ... }, { "provider": "workers-ai", ... } ] }
 *
 * The universal endpoint is what implements cross-PROVIDER failover beyond CF AI Gateway's own
 * dashboard-configurable same-provider retries. This is the ONLY place in the codebase that
 * constructs Anthropic or CF AI Gateway URLs.
 *
 * For CF Workers AI (embeddings, free-tier sub-agent vision), use callWorkersAI() directly.
 */

const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_BETA    = "prompt-caching-2024-07-31";
const DIRECT_ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

export const FALLBACK_MODEL = "@cf/meta/llama-3.1-8b-instruct";

export interface AIClientContext {
  spaceId: string;
  userId?: string;
  agentId?: string;
  threadId?: string;
  model?: string;
  /** Disable semantic caching for real-time conversational calls. */
  skipCache?: boolean;
}

export interface GatewayOpts {
  accountId: string;
  gatewayId: string;
  /** CF API token — required to use the Workers AI provider in the Universal Endpoint.
   *  Without it, the universal body falls back to Anthropic-only (same as the provider-specific
   *  URL). Supplied via `CF_API_TOKEN` worker secret. */
  cfApiToken?: string;
}

export type LLMProvider = "platform" | "cf-workers-ai" | "byok-anthropic";

export interface LLMConfig {
  provider: LLMProvider;
  url: string;
  apiKey: string;
  headers: Record<string, string>;
}

// ── Provider-specific Anthropic endpoint ─────────────────────────────────────

export function gatewayUrl(opts: GatewayOpts): string {
  return `https://gateway.ai.cloudflare.com/v1/${opts.accountId}/${opts.gatewayId}/anthropic/v1/messages`;
}

/** Per-call headers including `cf-aig-metadata` for tenant tracking (spec §15). */
export function gatewayHeaders(
  apiKey: string,
  ctx: AIClientContext,
): Record<string, string> {
  const metadata = JSON.stringify({
    spaceId:  ctx.spaceId,
    userId:   ctx.userId   ?? "system",
    agentId:  ctx.agentId  ?? "unknown",
    threadId: ctx.threadId ?? "unknown",
    model:    ctx.model    ?? "claude-haiku-4-5-20251001",
    platform: "naelao",
    version:  "1.0",
  });
  return {
    "x-api-key":         apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
    "anthropic-beta":    ANTHROPIC_BETA,
    "content-type":      "application/json",
    "cf-aig-metadata":   metadata,
    "cf-aig-cache-ttl":  ctx.skipCache ? "0" : "3600",
  };
}

function directHeaders(apiKey: string): Record<string, string> {
  return {
    "x-api-key":         apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
    "anthropic-beta":    ANTHROPIC_BETA,
    "content-type":      "application/json",
  };
}

/** Resolve Anthropic URL: gateway when NAELAO_ACCOUNT_ID is real, direct otherwise. */
export function resolveAnthropicUrl(opts: GatewayOpts): string {
  if (!opts.accountId || opts.accountId === "placeholder") return DIRECT_ANTHROPIC_URL;
  return gatewayUrl(opts);
}

export function resolveAnthropicHeaders(
  apiKey: string,
  opts: GatewayOpts,
  ctx: AIClientContext,
): Record<string, string> {
  if (!opts.accountId || opts.accountId === "placeholder") return directHeaders(apiKey);
  return gatewayHeaders(apiKey, ctx);
}

export function buildPlatformLLMConfig(
  apiKey: string,
  opts: GatewayOpts,
  ctx: AIClientContext,
): LLMConfig {
  return {
    provider: "platform",
    url:      resolveAnthropicUrl(opts),
    apiKey,
    headers:  resolveAnthropicHeaders(apiKey, opts, ctx),
  };
}

// ── CF AI Gateway Universal Endpoint (multi-provider failover) ────────────────

/** The Universal Endpoint URL — providers are specified in the request BODY, not the URL path. */
export function universalGatewayUrl(opts: GatewayOpts): string {
  return `https://gateway.ai.cloudflare.com/v1/${opts.accountId}/${opts.gatewayId}`;
}

export interface UniversalProvider {
  provider: string;
  endpoint: string;
  headers: Record<string, string>;
  query: Record<string, unknown>;
}

/**
 * Build a Universal Endpoint request body with Anthropic as primary + Workers AI as fallback.
 * CF AI Gateway tries providers in order and returns the first success in the provider's native
 * response format. When cfApiToken is absent, returns Anthropic-only (no fallback configured at
 * the gateway level — degrades cleanly).
 */
export function buildUniversalBody(opts: {
  apiKey: string;
  cfApiToken: string | undefined;
  gatewayOpts: GatewayOpts;
  ctx: AIClientContext;
  query: {
    model: string;
    max_tokens: number;
    system: string;
    messages: Array<{ role: string; content: string }>;
  };
}): string {
  const { apiKey, cfApiToken, ctx, query } = opts;
  const metadata = JSON.stringify({
    spaceId:  ctx.spaceId,
    userId:   ctx.userId  ?? "system",
    agentId:  ctx.agentId ?? "unknown",
    platform: "naelao",
    version:  "1.0",
  });

  const anthropicProvider: UniversalProvider = {
    provider: "anthropic",
    endpoint: "messages",
    headers: {
      "x-api-key":         apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-beta":    ANTHROPIC_BETA,
      "cf-aig-metadata":   metadata,
      "cf-aig-cache-ttl":  ctx.skipCache ? "0" : "0", // always no-cache for reasoner calls
    },
    query: { ...query },
  };

  const providers: UniversalProvider[] = [anthropicProvider];

  // Workers AI fallback — only wired when a CF API token is available (required by the Universal
  // Endpoint's workers-ai provider; the AI binding is a different access path). The model is the
  // same Llama 3.1 8B used for the existing embeddings path so no new model bootstrapping needed.
  if (cfApiToken) {
    providers.push({
      provider: "workers-ai",
      endpoint: FALLBACK_MODEL,
      headers: {
        "Authorization": `Bearer ${cfApiToken}`,
        "cf-aig-metadata": metadata,
      },
      query: {
        messages: [
          { role: "system", content: query.system },
          ...query.messages,
        ],
        max_tokens: query.max_tokens,
      },
    });
  }

  return JSON.stringify({ providers });
}

/**
 * Normalize the response body from the CF AI Gateway Universal Endpoint.
 * Anthropic format: { content: [{ type: "text", text: "..." }], usage: { ... } }
 * Workers AI format: { result: { response: "..." }, success: true }
 * Returns a stable { text, usage } so the reasoner doesn't need to know which provider fired.
 */
export function normalizeUniversalResponse(data: unknown): {
  text: string;
  usage: { input_tokens: number; output_tokens: number } | undefined;
} {
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    // Anthropic native format
    if (Array.isArray(d["content"])) {
      const text = (d["content"] as Array<{ type?: string; text?: string }>)
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("");
      const u = d["usage"] as { input_tokens?: number; output_tokens?: number } | undefined;
      return {
        text,
        usage: u ? { input_tokens: u.input_tokens ?? 0, output_tokens: u.output_tokens ?? 0 } : undefined,
      };
    }
    // Workers AI native format (via Universal Endpoint)
    const result = d["result"] as Record<string, unknown> | undefined;
    if (result && typeof result["response"] === "string") {
      const u = result["usage"] as { prompt_tokens?: number; completion_tokens?: number } | undefined;
      return {
        text: result["response"],
        usage: u
          ? { input_tokens: u.prompt_tokens ?? 0, output_tokens: u.completion_tokens ?? 0 }
          : undefined,
      };
    }
  }
  return { text: "", usage: undefined };
}

// ── CF Workers AI (embeddings + free-tier) ────────────────────────────────────

/**
 * CF Workers AI — cheaper open-source models (free tier default) and vision.
 * Models: "@cf/meta/llama-3.1-8b-instruct" | "@cf/llava-hf/llava-1.5-7b-hf"
 */
export async function callWorkersAI(
  ai: Ai,
  model: string,
  prompt: string,
  maxTokens = 512,
): Promise<string> {
  const result = await ai.run(model as Parameters<Ai["run"]>[0], {
    prompt,
    max_tokens: maxTokens,
  } as Parameters<Ai["run"]>[1]);

  if (result && typeof result === "object" && "response" in result) {
    return String((result as { response: unknown }).response ?? "");
  }
  return "";
}
