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
  /** Authenticated-Gateway token (the gateway's own auth, `cf-aig-authorization: Bearer …`,
   *  supplied via the `NAELAO_AIG_TOKEN` worker secret). When set, this is what lets the CF AI
   *  Gateway hold the PROVIDER keys itself (BYOK / stored keys): the worker authenticates to the
   *  gateway, and the gateway injects the real Anthropic/OpenAI key — so a deployment needs no
   *  `ANTHROPIC_API_KEY` of its own. Per-provider `apiKey` becomes optional (see buildProviderEntry). */
  aigToken?: string;
}

// ── CF AI Gateway Universal Endpoint ─────────────────────────────────────────

/** The Universal Endpoint URL — provider and model are specified in the request BODY. */
export function universalGatewayUrl(opts: GatewayOpts): string {
  return `https://gateway.ai.cloudflare.com/v1/${opts.accountId}/${opts.gatewayId}`;
}

/** Fetch headers for a Universal Endpoint request. The `cf-aig-authorization` gateway token (when
 *  configured) travels as an HTTP header, NOT in the request body — this is the header the CF AI
 *  Gateway checks to authorize the caller and unlock its stored provider keys. */
export function universalGatewayHeaders(opts: GatewayOpts): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(opts.aigToken ? { "cf-aig-authorization": `Bearer ${opts.aigToken}` } : {}),
  };
}

/** Whether an LLM call can actually authenticate: either the gateway holds the provider key
 *  (aigToken set) or the caller supplied a real provider key. Neither → honest failure at the
 *  call site rather than a doomed request to the provider. */
export function canAuthenticateLlm(opts: GatewayOpts, apiKey: string): boolean {
  return Boolean(opts.aigToken) || Boolean(apiKey);
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
  // Zhipu/GLM via a Custom Provider added in the CF AI Gateway dashboard (BYOK — the key never
  // touches a worker secret). "zai" must match the slug you name that custom provider when
  // configuring it; rename this constant if you pick a different slug. Falls through to the
  // generic OpenAI-compatible branch in buildProviderEntry (Zhipu's API is OpenAI-shaped), so no
  // further code change is needed once the provider exists in the gateway.
  if (model.startsWith("glm-")) return "zai";
  return "anthropic";
}

/** One (model, apiKey) pair in a failover chain. */
export interface FailoverModel {
  model: string;
  apiKey: string;
  /** Only needed when this entry routes to the workers-ai provider. */
  cfApiToken?: string;
}

/** Build a single Universal-Endpoint provider entry for a (model, apiKey) — the provider is
 *  inferred from the model name, so a chain can mix Anthropic/OpenAI/Workers-AI freely. */
function buildProviderEntry(
  model: string,
  apiKey: string,
  cfApiToken: string | undefined,
  max_tokens: number,
  system: string,
  messages: Array<{ role: string; content: string }>,
  metadata: string,
  skipCache: boolean,
): UniversalProvider {
  const provider = inferProvider(model);
  // When apiKey is empty the CF AI Gateway is expected to inject its OWN stored provider key
  // (Authenticated Gateway / BYOK — gated by the top-level cf-aig-authorization header). In that
  // case we MUST NOT send an empty auth header, which would override the gateway's stored key with
  // a blank one; omit it entirely and let the gateway supply the credential.
  if (provider === "workers-ai") {
    return {
      provider: "workers-ai",
      endpoint: model,
      headers: { ...(cfApiToken ? { "Authorization": `Bearer ${cfApiToken}` } : {}), "cf-aig-metadata": metadata },
      query: { messages: [{ role: "system", content: system }, ...messages], max_tokens },
    };
  }
  if (provider === "anthropic") {
    return {
      provider: "anthropic",
      endpoint: "messages",
      headers: {
        ...(apiKey ? { "x-api-key": apiKey } : {}),
        "anthropic-version": ANTHROPIC_VERSION, "anthropic-beta": ANTHROPIC_BETA,
        "cf-aig-metadata": metadata, "cf-aig-cache-ttl": skipCache ? "0" : "0",
      },
      query: { model, max_tokens, system, messages },
    };
  }
  // OpenAI and OpenAI-compatible providers
  return {
    provider,
    endpoint: "chat/completions",
    headers: { ...(apiKey ? { "Authorization": `Bearer ${apiKey}` } : {}), "cf-aig-metadata": metadata, "cf-aig-cache-ttl": skipCache ? "0" : "0" },
    query: { model, max_tokens, messages: [{ role: "system", content: system }, ...messages] },
  };
}

/**
 * Build a Universal Endpoint request body. F-12: the CF AI Gateway Universal Endpoint takes an
 * ORDERED `providers` array and tries each in turn until one succeeds — real cross-provider
 * failover, not just cross-request retry. The primary is inferred from `query.model`; `fallbacks`
 * (a chain of {model, apiKey} the caller supplies only for configured providers) are appended in
 * order, so a primary Anthropic model can fall back to a cheaper Anthropic model AND/OR to OpenAI
 * when that key is set — no code change per new provider, just another chain entry.
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
  /** Ordered failover chain tried after the primary (each with its own provider-specific key). */
  fallbacks?: FailoverModel[];
}): string {
  const { apiKey, cfApiToken, ctx, query, fallbacks } = opts;
  const metadata = JSON.stringify({
    spaceId:  ctx.spaceId,
    userId:   ctx.userId  ?? "system",
    agentId:  ctx.agentId ?? "unknown",
    platform: "naelao",
    version:  "1.0",
  });
  const skipCache = ctx.skipCache ?? false;

  const entries: UniversalProvider[] = [
    buildProviderEntry(query.model, apiKey, cfApiToken, query.max_tokens, query.system, query.messages, metadata, skipCache),
  ];
  // De-dupe by model so a misconfigured chain repeating the primary doesn't waste a retry slot.
  const seen = new Set<string>([query.model]);
  for (const fb of fallbacks ?? []) {
    if (!fb.model || !fb.apiKey || seen.has(fb.model)) continue;
    seen.add(fb.model);
    entries.push(buildProviderEntry(fb.model, fb.apiKey, fb.cfApiToken ?? cfApiToken, query.max_tokens, query.system, query.messages, metadata, skipCache));
  }

  return JSON.stringify({ providers: entries });
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
