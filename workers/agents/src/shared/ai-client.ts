/**
 * Canonical AI client factory — spec §15.
 *
 * Every LLM call in Naelao routes through Cloudflare AI Gateway. As of the 2026-05-21 AI Gateway
 * migration that means the AI REST API:
 *   POST https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1/chat/completions
 *   Auth: a Cloudflare API token (AI Gateway permission), plus cf-aig-gateway-id to route
 *         through OUR named gateway rather than the account default.
 *   Body: a flat, OpenAI-shaped { model, messages, max_tokens, tools? }.
 *
 * ONE endpoint and ONE schema serve every model. The model string alone selects the provider:
 *   "@cf/..."      → Workers AI (free tier)
 *   "anthropic/..." / "openai/..." → third-party, billed through Unified Billing
 * so there is no per-provider request translation any more (the previous Universal Endpoint's
 * ordered `providers` array is gone — see universalGatewayUrl for the live evidence).
 *
 * For CF Workers AI (embeddings, free-tier sub-agent vision), use callWorkersAI() directly.
 */

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
  /** Cloudflare API token with the AI Gateway permission — the AI REST API's primary credential
   *  for EVERY model (Workers AI and third-party alike), supplied via the `CF_API_TOKEN` secret.
   *  Since the 2026-05-21 migration this is required for any LLM call, not just Workers AI. */
  cfApiToken?: string;
  /** Authenticated-Gateway token (the gateway's own auth, `cf-aig-authorization: Bearer …`,
   *  supplied via the `NAELAO_AIG_TOKEN` worker secret). When set, this is what lets the CF AI
   *  Gateway hold the PROVIDER keys itself (BYOK / stored keys): the worker authenticates to the
   *  gateway, and the gateway injects the real Anthropic/OpenAI key — so a deployment needs no
   *  `ANTHROPIC_API_KEY` of its own. Retained across the AI REST API migration so a deployment
   *  configured the old way keeps working. */
  aigToken?: string;
}

// ── CF AI Gateway Universal Endpoint ─────────────────────────────────────────

/**
 * The AI Gateway endpoint.
 *
 * MIGRATION (2026-05-21): Cloudflare moved AI Gateway onto the AI REST API at
 * api.cloudflare.com. The OLD `gateway.ai.cloudflare.com/v1/{account}/{gateway}` Universal
 * Endpoint — which took an ordered `providers: [{provider, endpoint, headers, query}]` array —
 * is gone. Confirmed live against this account: the old URL returns 401, and posting the old
 * providers-array body returns `{"code":2008,"message":"Invalid provider"}`. Every agent run in
 * production failed this way once the auth and D1-binding bugs stopped masking it.
 *
 * The new API is a flat, OpenAI-shaped body against one endpoint that serves BOTH Workers AI
 * (`@cf/...`) and third-party (`anthropic/...`, `openai/...`) models, so provider selection is
 * just the model string — no per-provider request translation at all.
 */
export function universalGatewayUrl(opts: GatewayOpts): string {
  return `https://api.cloudflare.com/client/v4/accounts/${opts.accountId}/ai/v1/chat/completions`;
}

/** Headers for an AI REST API request. Auth is a Cloudflare API token with the AI Gateway
 *  permission (`cfApiToken`); `cf-aig-gateway-id` routes the call through OUR named gateway so
 *  its logging/caching/rate-limiting still apply (without it, requests go to the account's
 *  default gateway). `aigToken` is accepted for the Authenticated-Gateway header the old flow
 *  used, so a deployment that still sets it isn't broken by this migration. */
export function universalGatewayHeaders(opts: GatewayOpts): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(opts.cfApiToken ? { authorization: `Bearer ${opts.cfApiToken}` } : {}),
    ...(opts.gatewayId ? { "cf-aig-gateway-id": opts.gatewayId } : {}),
    ...(opts.aigToken ? { "cf-aig-authorization": `Bearer ${opts.aigToken}` } : {}),
  };
}

/** Whether an LLM call can actually authenticate. The AI REST API authenticates with a Cloudflare
 *  API token, so that is now the primary credential; the older gateway token and a direct provider
 *  key still count so a deployment configured the previous way fails honestly rather than
 *  silently. None of them → give up at the call site instead of firing a doomed request. */
export function canAuthenticateLlm(opts: GatewayOpts, apiKey: string): boolean {
  return Boolean(opts.cfApiToken) || Boolean(opts.aigToken) || Boolean(apiKey);
}

// ── Structured tool calling ───────────────────────────────────────────────────
// Asking a model for JSON in prose and regex-extracting it is the least reliable way to get
// structured output (published production figures put prompted-JSON parsing around 70-85%
// action success vs 95-99% for native structured output/tool calling; weaker open models fare
// worse still). That gap matters most exactly where we want it least: on the cheap Workers AI
// models a free-tier business runs on. So the reasoner declares its action space as real tools
// and reads a real tool call back — falling back to the old text-JSON parse only when a provider
// returns prose anyway, so this is strictly additive robustness, never a new failure mode.

/** A provider-agnostic tool declaration, rendered to the wire shape by toolsWire. */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments (object type). */
  parameters: Record<string, unknown>;
}

/** A tool call parsed back out of any provider's own response shape. */
export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/** Translate a ToolSpec list into the AI REST API's tool wire shape (OpenAI-compatible — the
 *  single schema the new endpoint accepts for every model, Workers AI and third-party alike). */
function toolsWire(tools: ToolSpec[]): unknown[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/** One (model, apiKey) pair in a failover chain. */
export interface FailoverModel {
  model: string;
  apiKey: string;
  /** Retained for call-site compatibility; the AI REST API authenticates once at the request
   *  level, so a per-entry token is no longer meaningful. */
  cfApiToken?: string;
}

/**
 * Build the request body for the AI REST API's /ai/v1/chat/completions endpoint.
 *
 * This replaced the old Universal Endpoint's ordered `providers` array (see universalGatewayUrl's
 * migration note). Cross-provider failover moved OUT of the request body: the endpoint takes ONE
 * model, and retry/fallback is configured on the gateway itself (dashboard-level fallback rules,
 * plus cf-aig-max-attempts style headers). `fallbacks` is therefore accepted but no longer
 * encoded here — dropping the parameter would silently change every caller's meaning, so it stays
 * in the signature and this comment records why it has no effect.
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
  /** No longer encoded into the body — see the note above. */
  fallbacks?: FailoverModel[];
  /** Declared action space, sent as real tools so the model returns a schema-constrained call
   *  instead of prose we have to regex. */
  tools?: ToolSpec[];
}): string {
  const { query, tools } = opts;
  return JSON.stringify({
    model: query.model,
    max_tokens: query.max_tokens,
    messages: [{ role: "system", content: query.system }, ...query.messages],
    ...(tools && tools.length > 0 ? { tools: toolsWire(tools), tool_choice: "required" } : {}),
  });
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
  /** The first tool call the model made, when it made one. Callers that declared a tool set
   *  should prefer this over parsing `text` — see the ToolSpec block above for why. */
  toolCall?: ToolCall;
} {
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;

    // Anthropic native format
    if (Array.isArray(d["content"])) {
      const blocks = d["content"] as Array<{ type?: string; text?: string; name?: string; input?: unknown }>;
      const text = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
      const toolUse = blocks.find((b) => b.type === "tool_use");
      const u = d["usage"] as { input_tokens?: number; output_tokens?: number } | undefined;
      return {
        text,
        usage: u ? { input_tokens: u.input_tokens ?? 0, output_tokens: u.output_tokens ?? 0 } : undefined,
        ...(toolUse?.name
          ? { toolCall: { name: toolUse.name, arguments: (toolUse.input as Record<string, unknown>) ?? {} } }
          : {}),
      };
    }

    // Workers AI native format (via Universal Endpoint). Note tool_calls can be present with a
    // NULL `response` — so this branch must be reachable without a string response, which is why
    // the tool_calls check comes before the `typeof response === "string"` guard.
    const result = d["result"] as Record<string, unknown> | undefined;
    if (result && (typeof result["response"] === "string" || Array.isArray(result["tool_calls"]))) {
      const u = result["usage"] as { prompt_tokens?: number; completion_tokens?: number } | undefined;
      // Workers AI returns already-parsed objects in `arguments`, unlike OpenAI's JSON string.
      const wc = (result["tool_calls"] as Array<{ name?: string; arguments?: unknown }> | undefined)?.[0];
      return {
        text: typeof result["response"] === "string" ? result["response"] : "",
        usage: u
          ? { input_tokens: u.prompt_tokens ?? 0, output_tokens: u.completion_tokens ?? 0 }
          : undefined,
        ...(wc?.name ? { toolCall: { name: wc.name, arguments: coerceArgs(wc.arguments) } } : {}),
      };
    }

    // OpenAI native format
    const choices = d["choices"] as Array<{
      message?: { content?: string; tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }> };
    }> | undefined;
    if (Array.isArray(choices) && choices.length > 0) {
      const message = choices[0]?.message;
      const u = d["usage"] as { prompt_tokens?: number; completion_tokens?: number } | undefined;
      const fn = message?.tool_calls?.[0]?.function;
      return {
        text: message?.content ?? "",
        usage: u
          ? { input_tokens: u.prompt_tokens ?? 0, output_tokens: u.completion_tokens ?? 0 }
          : undefined,
        ...(fn?.name ? { toolCall: { name: fn.name, arguments: coerceArgs(fn.arguments) } } : {}),
      };
    }
  }
  return { text: "", usage: undefined };
}

/** Tool arguments arrive as an object (Anthropic, Workers AI) or a JSON string (OpenAI). Normalize
 *  both, and never throw on malformed JSON — an unparseable argument set is an empty one, which
 *  the caller's own validation then rejects with a real reason. */
function coerceArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch { /* fall through to {} */ }
  }
  return {};
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
