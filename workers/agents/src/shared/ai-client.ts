/**
 * Canonical AI client factory — spec §15.
 *
 * Every LLM call in Naelao routes through Cloudflare AI Gateway (spec §15) using the
 * Universal Endpoint. The provider is inferred from the model name — callers pick a model
 * and the gateway handles routing. No hardcoded provider preference.
 *
 * Universal Endpoint:
 *   POST https://gateway.ai.cloudflare.com/v1/{ACCOUNT_ID}/{GATEWAY_ID}
 *   Body: { "providers": [ { "provider": "<inferred>", ... } ] }
 *
 * Provider inference (inferProvider):
 *   "@cf/*"       → workers-ai   (CF Workers AI models)
 *   "claude*"     → anthropic    (Anthropic Claude models)
 *   "gpt-*" / "o1*" / "o3*" → openai
 *   anything else → anthropic    (safe default; gateway will reject unknown models)
 *
 * For CF Workers AI (embeddings, free-tier sub-agent vision), use callWorkersAI() directly.
 */

const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_BETA    = "prompt-caching-2024-07-31";

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
  /** CF API token — required when the selected model routes to the workers-ai provider.
   *  Supplied via `CF_API_TOKEN` worker secret. Not needed for Anthropic or OpenAI models. */
  cfApiToken?: string;
}

// ── CF AI Gateway Universal Endpoint ─────────────────────────────────────────

/** The Universal Endpoint URL — provider and model are specified in the request BODY. */
export function universalGatewayUrl(opts: GatewayOpts): string {
  return `https://gateway.ai.cloudflare.com/v1/${opts.accountId}/${opts.gatewayId}`;
}

export interface UniversalProvider {
  provider: string;
  endpoint: string;
  headers: Record<string, string>;
  query: Record<string, unknown>;
}

/** Infer the CF AI Gateway provider string from a model name. */
export function inferProvider(model: string): string {
  if (model.startsWith("@cf/")) return "workers-ai";
  if (model.startsWith("gpt-") || model.startsWith("o1-") || model.startsWith("o3-")) return "openai";
  return "anthropic";
}

/**
 * Build a Universal Endpoint request body with a single provider entry inferred from the
 * model name. The gateway handles routing — callers just pick a model.
 */
export function buildUniversalBody(opts: {
  apiKey: string;
  cfApiToken?: string;
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
  const skipCache = ctx.skipCache ?? false;
  const provider  = inferProvider(query.model);

  let entry: UniversalProvider;

  if (provider === "workers-ai") {
    entry = {
      provider: "workers-ai",
      endpoint: query.model,
      headers: {
        "Authorization":   `Bearer ${cfApiToken ?? ""}`,
        "cf-aig-metadata": metadata,
      },
      query: {
        messages: [
          { role: "system", content: query.system },
          ...query.messages,
        ],
        max_tokens: query.max_tokens,
      },
    };
  } else if (provider === "anthropic") {
    entry = {
      provider: "anthropic",
      endpoint: "messages",
      headers: {
        "x-api-key":         apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "anthropic-beta":    ANTHROPIC_BETA,
        "cf-aig-metadata":   metadata,
        "cf-aig-cache-ttl":  skipCache ? "0" : "0",
      },
      query: { ...query },
    };
  } else {
    // OpenAI and OpenAI-compatible providers
    entry = {
      provider,
      endpoint: "chat/completions",
      headers: {
        "Authorization":   `Bearer ${apiKey}`,
        "cf-aig-metadata": metadata,
        "cf-aig-cache-ttl": skipCache ? "0" : "0",
      },
      query: {
        model:      query.model,
        max_tokens: query.max_tokens,
        messages: [
          { role: "system", content: query.system },
          ...query.messages,
        ],
      },
    };
  }

  return JSON.stringify({ providers: [entry] });
}

/**
 * Normalize the response body from the CF AI Gateway Universal Endpoint.
 * Anthropic format: { content: [{ type: "text", text: "..." }], usage: { ... } }
 * Workers AI format: { result: { response: "..." }, success: true }
 * OpenAI format: { choices: [{ message: { content: "..." } }], usage: { ... } }
 * Returns a stable { text, usage } so callers don't need to know which provider fired.
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

    // OpenAI native format
    const choices = d["choices"] as Array<{ message?: { content?: string } }> | undefined;
    if (Array.isArray(choices) && choices.length > 0) {
      const text = choices[0]?.message?.content ?? "";
      const u = d["usage"] as { prompt_tokens?: number; completion_tokens?: number } | undefined;
      return {
        text,
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
