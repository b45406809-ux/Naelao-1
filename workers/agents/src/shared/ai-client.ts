/**
 * Canonical AI client factory — spec §15.
 *
 * Every LLM call in Naelao routes through Cloudflare AI Gateway (spec §15):
 *   https://gateway.ai.cloudflare.com/v1/{ACCOUNT_ID}/{GATEWAY_ID}/anthropic/v1/messages
 *
 * The gateway provides: per-tenant analytics, semantic caching, fallback routing,
 * per-space rate limits, and BYOK. This is the ONLY place in the codebase that
 * constructs Anthropic API URLs.
 *
 * For CF Workers AI (free-tier agents, sub-agent vision), use callWorkersAI().
 */

const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_BETA    = "prompt-caching-2024-07-31";
const DIRECT_ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

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
}

export type LLMProvider = "platform" | "cf-workers-ai" | "byok-anthropic";

export interface LLMConfig {
  provider: LLMProvider;
  url: string;
  apiKey: string;
  headers: Record<string, string>;
}

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

/**
 * Resolve Anthropic URL: gateway when NAELAO_ACCOUNT_ID is real, direct otherwise.
 * This means local dev / tests (placeholder) never hit the gateway.
 */
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
