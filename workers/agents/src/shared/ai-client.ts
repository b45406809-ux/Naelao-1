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
  /** A real Google AI Studio (Gemini) API key, BYOK — see isGoogleAiStudioModel's own doc for why
   *  this is a genuinely separate routing path from every other model on this account. Supplied
   *  via the `GOOGLE_AI_STUDIO_API_KEY` worker secret. */
  googleAiStudioApiKey?: string;
  /** Additional space-owned keys for the same provider. The first entry is the preferred key;
   * the reasoner tries later entries only when the provider call fails. */
  googleAiStudioApiKeys?: string[];
  /** A real Groq API key, BYOK through the same compat route Gemini uses. Supplied via the
   *  `GROQ_API_KEY` worker secret. Groq's free tier is 14,400 requests/day against Gemini's 20,
   *  which is the difference between being able to test this platform properly and not. */
  groqApiKey?: string;
  /** Additional space-owned keys for the same provider. */
  groqApiKeys?: string[];
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

/**
 * Google AI Studio (Gemini) models are a genuinely separate routing path from everything else on
 * this account, confirmed live rather than assumed:
 *  - The new `/ai/v1/chat/completions` REST API above only accepts third-party (non-`@cf/...`)
 *    models under Unified Billing — a prepaid Cloudflare-credits arrangement this account does not
 *    have (see CLAUDE.md's Live Deployment Facts). A raw probe against it for a Gemini model with
 *    only a Cloudflare token returns Cloudflare's own error for exactly this case.
 *  - The OLDER `gateway.ai.cloudflare.com/v1/{account}/{gateway}` host is where the migration note
 *    above says the raw providers-array shape is gone — but that host's newer `/compat/chat/
 *    completions` suffix is a DIFFERENT, still-live route: a real BYOK path where the caller's own
 *    provider key travels in the plain `Authorization: Bearer` header (per Cloudflare's own BYOK
 *    docs) and `cf-aig-authorization` authenticates the gateway itself. This is what lets a real,
 *    free-tier Google AI Studio key (no Cloudflare credits, no per-token billing to us) actually
 *    work.
 * `google-ai-studio/{model}` (Cloudflare's own provider-prefix convention) is the trigger for this
 * whole alternate path — see googleAiStudioGatewayUrl/Headers below.
 */
export function isGoogleAiStudioModel(model: string): boolean {
  return model.startsWith("google-ai-studio/");
}

/**
 * Providers reached BYOK through the gateway's compat endpoint, keyed by the model-id prefix the
 * endpoint uses to route, mapped to which `GatewayOpts` field holds that provider's own key.
 *
 * The compat route is generic — it infers the provider from the prefix — so adding one is a map
 * entry and a secret, not a new code path. Every model on this account whose id carries one of
 * these prefixes goes here instead of the AI REST API, because a BYOK provider cannot be reached
 * with a Cloudflare token alone.
 */
const BYOK_COMPAT_PROVIDERS: Record<string, keyof Pick<GatewayOpts, "googleAiStudioApiKey" | "groqApiKey">> = {
  "google-ai-studio/": "googleAiStudioApiKey",
  "groq/": "groqApiKey",
};

/** Which BYOK key this model needs, or null when it is an ordinary AI-REST-API model. */
export function byokKeyFieldForModel(model: string): keyof GatewayOpts | null {
  for (const [prefix, field] of Object.entries(BYOK_COMPAT_PROVIDERS)) {
    if (model.startsWith(prefix)) return field;
  }
  return null;
}

/**
 * Step 28 (business-wide BYOK): the canonical provider slug for a model — the value stored in a
 * business's `productConfig.byok.providers` list and used in its credential name
 * (`llm-byok:{slug}`). Returns null for a model that isn't a BYOK-compat provider (an ordinary
 * AI-REST-API/Cloudflare model — those aren't a simple single-key override; see NaelaoAgentDO's
 * resolveBusinessLlmOverride for why CF Workers AI BYOK is a separate, larger piece).
 */
export const BYOK_PROVIDER_KEY_FIELD: Record<string, keyof Pick<GatewayOpts, "googleAiStudioApiKey" | "groqApiKey">> = {
  "google-ai-studio": "googleAiStudioApiKey",
  "groq": "groqApiKey",
};

export function byokProviderForModel(model: string): string | null {
  for (const prefix of Object.keys(BYOK_COMPAT_PROVIDERS)) {
    if (model.startsWith(prefix)) return prefix.replace(/\/$/, "");
  }
  return null;
}

/** Does this model route through the compat endpoint rather than the AI REST API? */
export function isCompatProviderModel(model: string): boolean {
  return byokKeyFieldForModel(model) !== null;
}

/**
 * Translate the UI's friendly Gemini aliases to model ids accepted by Google's OpenAI
 * compatibility endpoint. The aliases are useful in persisted space configuration, but the
 * compatibility endpoint expects a concrete model code; forwarding `gemini-flash-latest` can
 * otherwise return Google's generic 400 INVALID_ARGUMENT response.
 */
export function compatProviderModelId(model: string): string {
  const prefix = model.startsWith("google-ai-studio/") ? "google-ai-studio/" : model.startsWith("groq/") ? "groq/" : "";
  const bare = prefix ? model.slice(prefix.length) : model;
  const geminiAliases: Record<string, string> = {
    "gemini-flash-lite-latest": "gemini-3.1-flash-lite",
    "gemini-flash-latest": "gemini-3.8-flash",
    "gemini-pro-latest": "gemini-3.1-pro-preview",
  };
  return `${prefix}${geminiAliases[bare] ?? bare}`;
}

/** The compat-endpoint URL for a BYOK provider call. */
export function compatGatewayUrl(opts: GatewayOpts): string {
  return `https://gateway.ai.cloudflare.com/v1/${opts.accountId}/${opts.gatewayId}/compat/chat/completions`;
}

/** Headers for a BYOK compat-endpoint call — the provider's OWN key in `authorization`, and the
 *  separate gateway-authenticating header when this gateway requires one. */
export function compatGatewayHeaders(opts: GatewayOpts, model: string): Record<string, string> {
  const field = byokKeyFieldForModel(model);
  const key = field ? (opts[field] as string | undefined) : undefined;
  return {
    "content-type": "application/json",
    ...(key ? { authorization: `Bearer ${key}` } : {}),
    ...(opts.aigToken ? { "cf-aig-authorization": `Bearer ${opts.aigToken}` } : {}),
    // This request has an explicit tenant-owned provider key. Prevent AI Gateway Unified Billing
    // from substituting Cloudflare-managed credentials if the tenant key is invalid or revoked.
    // Cloudflare documents cf-aig-no-wholesale=true for per-request BYOK-only behavior.
    "cf-aig-no-wholesale": "true",
  };
}

/** Retained name for the Gemini-specific call sites and their tests; the route is the same. */
export function googleAiStudioGatewayUrl(opts: GatewayOpts): string {
  return compatGatewayUrl(opts);
}

/** Headers for a Google AI Studio (Gemini) compat-endpoint call. The real Google key rides in the
 *  plain `Authorization` header (BYOK, per Cloudflare's own docs for this route — NOT the same
 *  meaning `authorization` carries on universalGatewayHeaders, where it's a Cloudflare token);
 *  `cf-aig-authorization` is the separate header that authenticates the gateway itself and is
 *  required whenever the gateway is configured as an Authenticated Gateway (this account's gateway
 *  already requires it — confirmed live: an unauthenticated call to this route 401s). */
export function googleAiStudioGatewayHeaders(opts: GatewayOpts): Record<string, string> {
  return compatGatewayHeaders(opts, "google-ai-studio/");
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
 *  silently. None of them → give up at the call site instead of firing a doomed request.
 *
 *  A Google AI Studio model is checked separately: it never authenticates with the Cloudflare
 *  token/aigToken alone (see isGoogleAiStudioModel's doc) — it needs a real `googleAiStudioApiKey`,
 *  full stop, or the request is a guaranteed 401. `model` is optional so every pre-existing call
 *  site (which doesn't know or care about a specific model) keeps its old behavior unchanged. */
export function canAuthenticateLlm(opts: GatewayOpts, apiKey: string, model?: string): boolean {
  // A BYOK provider needs its OWN key, full stop — a Cloudflare token cannot stand in, so the
  // request would be a guaranteed 401 and is better refused here with a message naming the secret.
  const field = model ? byokKeyFieldForModel(model) : null;
  if (field) return Boolean(opts[field]);
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
/** A chosen reasoning-effort level, ready to wire into the request body per the model's own
 *  ReasoningParamShape (packages/billing-core's MODEL_CAPABILITIES — see that file's header for
 *  what's actually confirmed vs. inferred per model). */
export interface ReasoningRequest {
  param: "reasoning_effort" | "kimi_thinking";
  level: string;
}

export function buildUniversalBody(opts: {
  apiKey: string;
  cfApiToken?: string;
  gatewayOpts: GatewayOpts;
  ctx: AIClientContext;
  query: {
    model: string;
    max_tokens: number;
    system: string;
    messages: Array<{ role: string; content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> }>;
  };
  /** No longer encoded into the body — see the note above. */
  fallbacks?: FailoverModel[];
  /** Declared action space, sent as real tools so the model returns a schema-constrained call
   *  instead of prose we have to regex. */
  tools?: ToolSpec[];
  /** `auto` lets the model answer normally when no terminal action is required. */
  toolChoice?: "required" | "auto";
  /** Set only for a model whose MODEL_CAPABILITIES entry supports it; absent means "send nothing
   *  reasoning-related" (the model either doesn't support it or the caller didn't choose a level). */
  reasoning?: ReasoningRequest;
  /**
   * Retry mode for providers whose OpenAI compatibility layer rejects an optional field. The
   * required chat payload remains intact, while tools/reasoning/stream usage hints are omitted so
   * a provider can still answer in the JSON protocol carried by the system prompt.
   */
  compatibilityMode?: "minimal";
  /**
   * Ask the provider to stream the reply back as Server-Sent Events instead of returning it whole.
   *
   * This is what makes the agent's own text arrive AS it is generated rather than only once the
   * whole reasoning call has finished — the difference between a chat that sits silent for eight
   * seconds and one you can watch think. `stream_options.include_usage` is set alongside it
   * because a streamed OpenAI-compatible response otherwise omits token usage entirely, and the
   * loop's budget accounting (and per-run billing) depends on real numbers, not estimates.
   */
  stream?: boolean;
}): string {
  const { query, tools, reasoning } = opts;
  const minimal = opts.compatibilityMode === "minimal";
  return JSON.stringify({
    model: query.model,
    max_tokens: query.max_tokens,
    messages: [{ role: "system", content: query.system }, ...query.messages],
    // Keep the declared action tools on compatibility retries. Removing them leaves the model
    // with prompt prose only, which makes native actions such as AskUser impossible even though
    // the planner was instructed to use them. The retry drops optional reasoning/stream metadata
    // below; the action schema is part of the required planner protocol.
    ...(tools && tools.length > 0 ? { tools: toolsWire(tools), tool_choice: opts.toolChoice ?? "required" } : {}),
    ...(!minimal && reasoning?.param === "reasoning_effort" ? { reasoning_effort: reasoning.level } : {}),
    ...(!minimal && reasoning?.param === "kimi_thinking" ? { chat_template_kwargs: { thinking: reasoning.level === "on" } } : {}),
    ...(opts.stream ? { stream: true, ...(!minimal ? { stream_options: { include_usage: true } } : {}) } : {}),
  });
}

/**
 * Read a JSON string value out of a buffer that may be TRUNCATED partway through it.
 *
 * A streamed tool call arrives as JSON fragments — `{"say":"Let me ch` — so `JSON.parse` cannot be
 * used until the very last chunk, which would defeat the entire point of streaming. This walks the
 * buffer by hand and returns whatever of `key`'s value has arrived so far, unescaped, whether or
 * not the closing quote has been seen yet. Returns undefined when the key hasn't appeared yet (as
 * opposed to "" — the key present with an empty value so far), so a caller can tell "not started"
 * from "started, still empty".
 */
export function partialJsonString(buffer: string, key: string): string | undefined {
  const needle = `"${key}"`;
  const k = buffer.indexOf(needle);
  if (k === -1) return undefined;
  let i = k + needle.length;
  while (i < buffer.length && /\s/.test(buffer[i]!)) i++;
  if (buffer[i] !== ":") return undefined;
  i++;
  while (i < buffer.length && /\s/.test(buffer[i]!)) i++;
  // The value hasn't started arriving yet, or isn't a string at all.
  if (i >= buffer.length) return undefined;
  if (buffer[i] !== '"') return undefined;
  i++;
  let out = "";
  while (i < buffer.length) {
    const ch = buffer[i]!;
    if (ch === "\\") {
      const nxt = buffer[i + 1];
      // A backslash as the very last character means the escape itself is mid-flight: stop here
      // rather than emitting a lone backslash that will be replaced a chunk later.
      if (nxt === undefined) return out;
      switch (nxt) {
        case "n": out += "\n"; break;
        case "t": out += "\t"; break;
        case "r": out += "\r"; break;
        case "b": out += "\b"; break;
        case "f": out += "\f"; break;
        case '"': out += '"'; break;
        case "\\": out += "\\"; break;
        case "/": out += "/"; break;
        case "u": {
          const hex = buffer.slice(i + 2, i + 6);
          if (hex.length < 4) return out; // \uXXXX still arriving
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
          break;
        }
        default: out += nxt;
      }
      i += 2;
      continue;
    }
    if (ch === '"') return out; // closing quote — the value is complete
    out += ch;
    i++;
  }
  return out; // still open: this is the growing partial
}

/** What one streamed chunk has accumulated SO FAR — handed to the caller's onChunk on every
 *  update, so a UI can render text as it is generated rather than after the fact. */
export interface StreamProgress {
  /** Plain assistant text accumulated so far (prose outside any tool call). */
  text: string;
  /** The tool the model is calling, once its name has arrived. */
  toolName?: string;
  /** That tool's arguments as raw, possibly-incomplete JSON — read with partialJsonString. */
  toolArguments: string;
}

/**
 * Consume an OpenAI-compatible SSE stream and return the SAME normalized shape
 * `normalizeUniversalResponse` produces for a non-streamed reply, calling `onChunk` as content
 * arrives.
 *
 * Deliberately reconstructs a whole response rather than exposing the raw stream: every caller
 * still wants one decision at the end, and keeping the streamed and non-streamed paths converging
 * on one shape is what stops them drifting apart. A stream that dies mid-flight yields whatever
 * arrived (the caller's own error handling then treats an empty result as a failed turn), which is
 * strictly better than throwing away a nearly-complete reply.
 */
export async function parseUniversalStream(
  resp: Response,
  onChunk?: (progress: StreamProgress) => void
): Promise<{
  text: string;
  usage: { input_tokens: number; output_tokens: number } | undefined;
  toolCall?: ToolCall;
  thinking?: string;
  /**
   * A provider error delivered PART WAY THROUGH an otherwise-200 stream.
   *
   * This is not a theoretical case. A run in production replied to a person with the literal text
   * `{"` — the model had emitted one token, the provider then sent an error frame, and because
   * nothing looked for it the truncated fragment was returned as though the call had succeeded.
   * An error arriving mid-stream has to be louder than the partial output it interrupts, or a
   * failure is silently rendered as an answer.
   */
  error?: string;
}> {
  const body = resp.body;
  const progress: StreamProgress = { text: "", toolArguments: "" };
  let thinking = "";
  let streamError: string | undefined;
  let usage: { input_tokens: number; output_tokens: number } | undefined;
  if (!body) return { text: "", usage: undefined };

  // Asking for a stream is a request, not a guarantee. A provider (or a gateway in front of it)
  // may answer a `stream:true` request with an ordinary JSON body, and reading that as SSE finds
  // no `data:` frames at all — yielding an empty reply, which the loop can only report as a failed
  // turn. That would silently break every interactive run against any provider that behaves this
  // way, so honour what actually came back rather than what was asked for.
  if (!(resp.headers.get("content-type") ?? "").includes("text/event-stream")) {
    try {
      return normalizeUniversalResponse(await resp.json());
    } catch {
      return { text: "", usage: undefined };
    }
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  /** Everything read, kept for the salvage path below — a stream LABELLED as SSE that turns out to
   *  carry a plain JSON body would otherwise be indistinguishable from an empty reply. */
  let raw = "";

  const handleEvent = (raw: string): void => {
    const line = raw.trim();
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return; // a malformed frame must never abort a stream that is otherwise fine
    }
    // Every provider signals a mid-stream failure differently in the detail, but all of them put
    // it under `error` — as an object with a message, or as a bare string.
    const errField = evt["error"];
    if (errField) {
      const msg = typeof errField === "string"
        ? errField
        : (errField as { message?: string })?.message ?? JSON.stringify(errField);
      streamError = String(msg).slice(0, 300);
    }
    const u = evt["usage"] as { prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number } | undefined;
    if (u) {
      usage = {
        input_tokens: u.prompt_tokens ?? u.input_tokens ?? 0,
        output_tokens: u.completion_tokens ?? u.output_tokens ?? 0,
      };
    }
    const choice = (evt["choices"] as Array<Record<string, unknown>> | undefined)?.[0];
    const delta = choice?.["delta"] as Record<string, unknown> | undefined;
    if (!delta) return;

    let changed = false;
    if (typeof delta["content"] === "string" && delta["content"]) {
      progress.text += delta["content"] as string;
      changed = true;
    }
    // Reasoning models stream chain-of-thought on a separate field, and the two names in the wild
    // are `reasoning` and `reasoning_content` (see normalizeUniversalResponse's own note — a real
    // captured payload carried BOTH, with `reasoning` the fuller of the two).
    for (const key of ["reasoning", "reasoning_content"]) {
      if (typeof delta[key] === "string" && delta[key]) thinking += delta[key] as string;
    }
    const calls = delta["tool_calls"] as Array<Record<string, unknown>> | undefined;
    const fn = calls?.[0]?.["function"] as Record<string, unknown> | undefined;
    if (fn) {
      if (typeof fn["name"] === "string" && fn["name"]) {
        progress.toolName = fn["name"] as string;
        changed = true;
      }
      if (typeof fn["arguments"] === "string" && fn["arguments"]) {
        progress.toolArguments += fn["arguments"] as string;
        changed = true;
      }
    }
    if (changed && onChunk) {
      try { onChunk({ ...progress }); } catch { /* a throwing consumer never breaks the stream */ }
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      raw += chunk;
      buffered += chunk;
      // SSE frames are separated by a blank line; a frame may span several network chunks.
      let sep = buffered.indexOf("\n\n");
      while (sep !== -1) {
        const frame = buffered.slice(0, sep);
        buffered = buffered.slice(sep + 2);
        for (const l of frame.split("\n")) handleEvent(l);
        sep = buffered.indexOf("\n\n");
      }
    }
  } catch {
    // A dropped stream keeps whatever arrived — see this function's own doc.
  } finally {
    // Flush the tail in `finally`, not on the success path only: a stream that dies can leave a
    // complete `data:` line in the buffer that simply never got its terminating blank line, and
    // discarding it would throw away a frame that actually arrived. A genuinely truncated frame
    // is malformed JSON and handleEvent ignores it, so this can only ever recover, never corrupt.
    try {
      for (const l of buffered.split("\n")) handleEvent(l);
    } catch { /* a tail that can't be parsed is simply not there */ }
    try { reader.releaseLock(); } catch { /* already released */ }
  }

  // Salvage: SSE content-type, but not a single frame parsed out of a non-empty body. The most
  // likely explanation by far is a whole JSON response mislabelled as a stream, and reporting an
  // empty turn when a perfectly good reply is sitting in the buffer would be the worse mistake.
  if (!progress.toolName && !progress.text && raw.trim().startsWith("{")) {
    try {
      return normalizeUniversalResponse(JSON.parse(raw));
    } catch {
      /* genuinely unusable — fall through to the empty result below */
    }
  }

  let toolCall: ToolCall | undefined;
  if (progress.toolName) {
    let args: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(progress.toolArguments || "{}");
      if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>;
    } catch {
      // Truncated arguments: salvage the string fields we can still read, so a stream that died
      // one byte short of valid JSON still yields a usable decision instead of none at all.
      for (const key of ["name", "text", "reason", "say", "code"]) {
        const v = partialJsonString(progress.toolArguments, key);
        if (v !== undefined) args[key] = v;
      }
    }
    toolCall = { name: progress.toolName, arguments: args };
  }

  return {
    text: progress.text,
    usage,
    ...(toolCall ? { toolCall } : {}),
    ...(thinking ? { thinking } : {}),
    ...(streamError ? { error: streamError } : {}),
  };
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
  /** A reasoning-capable model's chain-of-thought, when it returned one (see MODEL_CAPABILITIES'
   *  own doc header for which models this applies to and the field-name caveat for Kimi). Absent
   *  for every model that doesn't report one — never fabricated from `text`. */
  thinking?: string;
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
      // A real captured payload (reasoner-tool-calling.test.ts's gpt-oss-120b fixture) shows a
      // model can send BOTH fields at once — `reasoning` the fuller chain-of-thought,
      // `reasoning_content` a shorter one — so `reasoning` is checked first; Kimi K2.6 only ever
      // sets `reasoning` (its own documented deviation, no `reasoning_content` at all), so this
      // order serves both cases.
      const thinking = firstNonEmptyString(result["reasoning"], result["reasoning_content"]);
      return {
        text: typeof result["response"] === "string" ? result["response"] : "",
        usage: u
          ? { input_tokens: u.prompt_tokens ?? 0, output_tokens: u.completion_tokens ?? 0 }
          : undefined,
        ...(wc?.name ? { toolCall: { name: wc.name, arguments: coerceArgs(wc.arguments) } } : {}),
        ...(thinking ? { thinking } : {}),
      };
    }

    // OpenAI native format
    const choices = d["choices"] as Array<{
      message?: {
        content?: string;
        reasoning_content?: string;
        reasoning?: string;
        tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }>;
      };
    }> | undefined;
    if (Array.isArray(choices) && choices.length > 0) {
      const message = choices[0]?.message;
      const u = d["usage"] as { prompt_tokens?: number; completion_tokens?: number } | undefined;
      const fn = message?.tool_calls?.[0]?.function;
      // Same field-preference order as the Workers AI branch above — see that comment.
      const thinking = firstNonEmptyString(message?.reasoning, message?.reasoning_content);
      return {
        text: message?.content ?? "",
        usage: u
          ? { input_tokens: u.prompt_tokens ?? 0, output_tokens: u.completion_tokens ?? 0 }
          : undefined,
        ...(fn?.name ? { toolCall: { name: fn.name, arguments: coerceArgs(fn.arguments) } } : {}),
        ...(thinking ? { thinking } : {}),
      };
    }
  }
  return { text: "", usage: undefined };
}

/** The first argument that is a non-empty string, or undefined. Small helper for the
 *  reasoning_content/reasoning field-name ambiguity above — never fabricates a value. */
function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
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
