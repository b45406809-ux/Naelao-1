// ── LLM Gateway ───────────────────────────────────────────────────────────────
// Fulfills G-C01 through G-C12: Anthropic Messages API integration
// - Prompt caching (G-C05)
// - Retry with exponential backoff (G-C06)
// - Input/output moderation stubs (G-C07, G-C08)
// - Streaming SSE (G-C09)
// - Token budget calculation (G-C10)

import type {
  ContentBlock,
  LlmMessage,
  LlmRequest,
  LlmResponse,
  SystemBlock,
} from "./types.js";

export type { LlmMessage, LlmRequest, LlmResponse, ContentBlock, SystemBlock };
export type { LlmTool, TokenBudget } from "./types.js";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_API_VERSION = "2023-06-01";
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 8 * 1024;

/** CF AI Gateway config for routing Anthropic calls through the gateway (spec §15). When
 *  `aigToken` is set (an Authenticated Gateway), the gateway can hold the Anthropic key itself
 *  (BYOK / stored keys) so the worker needs no ANTHROPIC_API_KEY of its own. */
export interface AiGatewayConfig {
  accountId: string;
  gatewayId: string;
  /** `cf-aig-authorization: Bearer …` — authorizes the caller AND unlocks the gateway's stored
   *  provider key. Supplied via the `NAELAO_AIG_TOKEN` worker secret. */
  aigToken?: string;
}

/** Resolve the Anthropic Messages endpoint + any gateway auth headers. Routes through the CF AI
 *  Gateway's Anthropic provider endpoint when a real gateway is configured (accountId set and not
 *  the "placeholder" default); otherwise falls back to calling Anthropic directly. */
export function resolveAnthropicEndpoint(gateway?: AiGatewayConfig): {
  url: string;
  headers: Record<string, string>;
} {
  if (gateway?.accountId && gateway.accountId !== "placeholder") {
    if (!gateway.gatewayId) {
      throw new LlmGatewayError(
        500,
        "invalid_gateway_config",
        "AI Gateway ID is required"
      );
    }
    return {
      url: `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(gateway.accountId)}/${encodeURIComponent(gateway.gatewayId)}/anthropic/v1/messages`,
      headers: gateway.aigToken
        ? { "cf-aig-authorization": `Bearer ${gateway.aigToken}` }
        : {},
    };
  }
  return { url: ANTHROPIC_API_URL, headers: {} };
}
const RESPONSE_RESERVE_TOKENS = 4096;
const CHARS_PER_TOKEN = 4; // approximate

// ── Circuit breaker (G-AO11) ─────────────────────────────────────────────────
// In-memory per-isolate circuit breaker for LLM provider failures.
// Opens after CB_FAILURE_THRESHOLD consecutive 5xx/429 errors; probes after CB_RESET_MS.

const CB_FAILURE_THRESHOLD = 5;
const CB_RESET_MS = 60_000; // 60 seconds half-open probe

interface CircuitBreakerState {
  failures: number;
  openedAt: number | null; // epoch ms, null = closed
}

const circuitBreakers = new Map<string, CircuitBreakerState>();

function circuitState(key: string): CircuitBreakerState {
  let state = circuitBreakers.get(key);
  if (!state) {
    if (circuitBreakers.size >= 100) {
      const oldest = circuitBreakers.keys().next().value;
      if (oldest !== undefined) circuitBreakers.delete(oldest);
    }
    state = { failures: 0, openedAt: null };
    circuitBreakers.set(key, state);
  } else {
    circuitBreakers.delete(key);
    circuitBreakers.set(key, state);
  }
  return state;
}

function cbIsOpen(key: string): boolean {
  const state = circuitState(key);
  if (state.openedAt === null) return false;
  // Auto-reset after CB_RESET_MS (half-open probe)
  if (Date.now() - state.openedAt >= CB_RESET_MS) {
    state.openedAt = null;
    state.failures = 0;
    return false;
  }
  return true;
}

function cbRecordSuccess(key: string): void {
  const state = circuitState(key);
  state.failures = 0;
  state.openedAt = null;
}

function cbRecordFailure(key: string): void {
  const state = circuitState(key);
  state.failures++;
  if (state.failures >= CB_FAILURE_THRESHOLD) {
    state.openedAt = Date.now();
  }
}

// ── Retry helper ─────────────────────────────────────────────────────────────

async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 1000,
  abortSignal?: AbortSignal
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      if (abortSignal?.aborted) {
        throw new Error("Request aborted");
      }
      return await fn();
    } catch (err) {
      lastError = err;
      // Only retry on overload/service unavailable errors
      const isRetryable =
        err instanceof LlmGatewayError &&
        (err.status === 429 || err.status === 503 || err.status === 529);
      if (!isRetryable || attempt === maxAttempts - 1) {
        throw err;
      }
      const delayMs = baseDelayMs * 2 ** attempt; // 1s, 2s, 4s
      await sleep(delayMs, abortSignal);
    }
  }
  throw lastError;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Request aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

// ── LLM Gateway Error ────────────────────────────────────────────────────────

export class LlmGatewayError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "LlmGatewayError";
  }
}

// ── Build request body with prompt caching ───────────────────────────────────

function buildRequestBody(request: LlmRequest): Record<string, unknown> {
  if (
    typeof request.model !== "string" ||
    !request.model.trim() ||
    request.model.length > 256 ||
    !Number.isSafeInteger(request.max_tokens) ||
    request.max_tokens < 1 ||
    request.max_tokens > 200_000 ||
    !Array.isArray(request.messages) ||
    request.messages.length === 0 ||
    request.messages.length > 10_000 ||
    (request.temperature !== undefined &&
      (!Number.isFinite(request.temperature) ||
        request.temperature < 0 ||
        request.temperature > 1))
  ) {
    throw new LlmGatewayError(
      400,
      "invalid_llm_request",
      "LLM request is invalid"
    );
  }
  const body: Record<string, unknown> = {
    model: request.model,
    max_tokens: request.max_tokens,
    messages: request.messages,
  };

  if (request.stream) body.stream = true;

  if (request.temperature !== undefined) {
    body.temperature = request.temperature;
  }

  if (request.tools && request.tools.length > 0) {
    // Prompt caching (G-C05), extended to tool schemas: Anthropic caches everything BEFORE a
    // cache_control breakpoint as one unit, and the tool-definitions block is exactly as stable
    // across an agent run's turns as the system prompt already marked below — only the LAST
    // entry needs the marker; a call already carrying one on its last tool is left untouched
    // (never double-marked) rather than assuming this is the only writer of that field.
    const tools = [...request.tools];
    const lastIdx = tools.length - 1;
    const lastTool = tools[lastIdx];
    if (lastTool && !lastTool.cache_control) {
      tools[lastIdx] = { ...lastTool, cache_control: { type: "ephemeral" } };
    }
    body.tools = tools;
  }

  if (request.metadata) {
    body.metadata = request.metadata;
  }

  // Apply prompt caching to the system prompt (G-C05)
  // Mark the last system block with cache_control to cache stable prefix
  if (request.system) {
    if (typeof request.system === "string") {
      const systemBlocks: SystemBlock[] = [
        {
          type: "text",
          text: request.system,
          cache_control: { type: "ephemeral" },
        },
      ];
      body.system = systemBlocks;
    } else {
      // Already an array of system blocks — mark the last one
      const blocks = [...request.system];
      const lastBlock = blocks[blocks.length - 1];
      if (lastBlock) {
        blocks[blocks.length - 1] = {
          ...lastBlock,
          cache_control: { type: "ephemeral" },
        };
      }
      body.system = blocks;
    }
  }

  try {
    if (
      new TextEncoder().encode(JSON.stringify(body)).byteLength >
      MAX_REQUEST_BYTES
    ) {
      throw new LlmGatewayError(
        413,
        "request_too_large",
        "LLM request exceeded the size limit"
      );
    }
  } catch (error) {
    if (error instanceof LlmGatewayError) throw error;
    throw new LlmGatewayError(
      400,
      "invalid_llm_request",
      "LLM request could not be serialized"
    );
  }
  return body;
}

async function readResponseText(
  response: Response,
  maxBytes: number
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new LlmGatewayError(
          502,
          "response_too_large",
          "LLM provider response exceeded the size limit"
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

// ── callLlm: non-streaming request ──────────────────────────────────────────

export async function callLlm(
  apiKey: string,
  request: LlmRequest,
  abortSignal?: AbortSignal,
  gateway?: AiGatewayConfig
): Promise<LlmResponse> {
  const endpoint = resolveAnthropicEndpoint(gateway);
  const circuitKey = endpoint.url;
  // G-AO11: Fail fast if circuit breaker is open
  if (cbIsOpen(circuitKey)) {
    throw new LlmGatewayError(
      503,
      "circuit_open",
      "LLM provider circuit breaker is open — too many recent failures"
    );
  }
  if (!apiKey && !gateway?.aigToken) {
    throw new LlmGatewayError(
      500,
      "no_llm_credentials",
      "no LLM credentials: set NAELAO_AIG_TOKEN (CF AI Gateway stored key) or ANTHROPIC_API_KEY"
    );
  }
  return withRetry(
    async () => {
      const body = buildRequestBody({ ...request, stream: false });

      const response = await fetch(endpoint.url, {
        method: "POST",
        headers: {
          // Omit x-api-key when empty so the gateway's stored Anthropic key (BYOK) isn't
          // overridden by a blank one — the cf-aig-authorization header authorizes the call.
          ...(apiKey ? { "x-api-key": apiKey } : {}),
          ...endpoint.headers,
          "anthropic-version": ANTHROPIC_API_VERSION,
          "content-type": "application/json",
          "anthropic-beta": "prompt-caching-2024-07-31",
        },
        body: JSON.stringify(body),
        ...(abortSignal !== undefined ? { signal: abortSignal } : {}),
      });

      if (!response.ok) {
        const errText = await readResponseText(
          response,
          MAX_ERROR_BODY_BYTES
        ).catch(() => "");
        let errCode = "api_error";
        try {
          const errJson = JSON.parse(errText) as { error?: { type?: string } };
          errCode = errJson.error?.type ?? errCode;
        } catch {
          // ignore JSON parse failure
        }
        const err = new LlmGatewayError(
          response.status,
          errCode,
          `Anthropic API error ${response.status}: ${errText.slice(0, 200)}`
        );
        // Record 5xx and 429 as provider failures for the circuit breaker
        if (response.status >= 500 || response.status === 429) {
          cbRecordFailure(circuitKey);
        }
        throw err;
      }

      const responseText = await readResponseText(response, MAX_RESPONSE_BYTES);
      cbRecordSuccess(circuitKey);
      try {
        return JSON.parse(responseText) as LlmResponse;
      } catch {
        throw new LlmGatewayError(
          502,
          "invalid_provider_response",
          "LLM provider returned invalid JSON"
        );
      }
    },
    3,
    1000,
    abortSignal
  );
}

// ── streamLlm: SSE streaming request ────────────────────────────────────────

export async function streamLlm(
  apiKey: string,
  request: LlmRequest,
  onChunk: (delta: string) => void,
  abortSignal?: AbortSignal,
  gateway?: AiGatewayConfig
): Promise<LlmResponse> {
  const endpoint = resolveAnthropicEndpoint(gateway);
  const circuitKey = endpoint.url;
  // G-AO11: Fail fast if circuit breaker is open
  if (cbIsOpen(circuitKey)) {
    throw new LlmGatewayError(
      503,
      "circuit_open",
      "LLM provider circuit breaker is open — too many recent failures"
    );
  }
  if (!apiKey && !gateway?.aigToken) {
    throw new LlmGatewayError(
      500,
      "no_llm_credentials",
      "no LLM credentials: set NAELAO_AIG_TOKEN (CF AI Gateway stored key) or ANTHROPIC_API_KEY"
    );
  }
  return withRetry(
    async () => {
      const body = buildRequestBody({ ...request, stream: true });

      const response = await fetch(endpoint.url, {
        method: "POST",
        headers: {
          ...(apiKey ? { "x-api-key": apiKey } : {}),
          ...endpoint.headers,
          "anthropic-version": ANTHROPIC_API_VERSION,
          "content-type": "application/json",
          "anthropic-beta": "prompt-caching-2024-07-31",
          accept: "text/event-stream",
        },
        body: JSON.stringify(body),
        ...(abortSignal !== undefined ? { signal: abortSignal } : {}),
      });

      if (!response.ok) {
        const errText = await readResponseText(
          response,
          MAX_ERROR_BODY_BYTES
        ).catch(() => "");
        // Record 5xx and 429 as provider failures for the circuit breaker
        if (response.status >= 500 || response.status === 429) {
          cbRecordFailure(circuitKey);
        }
        throw new LlmGatewayError(
          response.status,
          "api_error",
          `Anthropic stream error ${response.status}: ${errText.slice(0, 200)}`
        );
      }

      if (!response.body) {
        throw new LlmGatewayError(
          0,
          "no_body",
          "No response body for streaming"
        );
      }

      // Parse SSE stream
      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      // Accumulate response state
      let responseId = "";
      let responseModel = "";
      let stopReason: LlmResponse["stop_reason"] = "end_turn";
      let usage: LlmResponse["usage"] = { input_tokens: 0, output_tokens: 0 };
      const contentBlocks: ContentBlock[] = [];
      const currentBlockText: Record<number, string> = {};
      const currentBlockMeta: Record<
        number,
        { type: string; id?: string; name?: string }
      > = {};
      // §A1.25: web_search_tool_result blocks arrive whole in content_block_start (see below),
      // not accumulated via content_block_delta like text/tool_use blocks are.
      const currentBlockResults: Record<
        number,
        NonNullable<ContentBlock["web_search_results"]>
      > = {};

      let buffer = "";
      let totalResponseBytes = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        totalResponseBytes += value.byteLength;
        if (totalResponseBytes > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new LlmGatewayError(
            502,
            "response_too_large",
            "LLM provider response exceeded the size limit"
          );
        }

        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > MAX_ERROR_BODY_BYTES && !buffer.includes("\n\n")) {
          await reader.cancel();
          throw new LlmGatewayError(
            502,
            "sse_event_too_large",
            "LLM provider sent an oversized SSE event"
          );
        }

        // Process complete SSE messages (split on double newline)
        const messages = buffer.replace(/\r\n/g, "\n").split("\n\n");
        buffer = messages.pop() ?? "";

        for (const message of messages) {
          if (!message.trim()) continue;

          let eventType = "";
          let eventData = "";

          for (const line of message.split(/\r?\n/)) {
            if (line.startsWith("event: ")) {
              eventType = line.slice(7).trim();
            } else if (line.startsWith("data: ")) {
              eventData = line.slice(6).trim();
            }
          }

          if (!eventData || eventData === "[DONE]") continue;

          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(eventData) as Record<string, unknown>;
          } catch {
            continue;
          }

          if (eventType === "error") {
            const providerError = parsed.error as
              | Record<string, unknown>
              | undefined;
            const errorType =
              typeof providerError?.type === "string"
                ? providerError.type
                : "provider_stream_error";
            const status =
              errorType === "overloaded_error"
                ? 529
                : errorType === "rate_limit_error"
                  ? 429
                  : 502;
            cbRecordFailure(circuitKey);
            await reader.cancel();
            throw new LlmGatewayError(
              status,
              errorType,
              typeof providerError?.message === "string"
                ? providerError.message.slice(0, 200)
                : "LLM provider stream failed"
            );
          }

          // Handle SSE event types
          if (eventType === "message_start") {
            const msg = parsed.message as Record<string, unknown>;
            responseId = (msg.id as string) ?? "";
            responseModel = (msg.model as string) ?? "";
            const msgUsage = msg.usage as Record<string, number> | undefined;
            if (msgUsage) {
              const crit = msgUsage.cache_read_input_tokens;
              const ccit = msgUsage.cache_creation_input_tokens;
              usage = {
                input_tokens: msgUsage.input_tokens ?? 0,
                output_tokens: msgUsage.output_tokens ?? 0,
                ...(crit !== undefined
                  ? { cache_read_input_tokens: crit }
                  : {}),
                ...(ccit !== undefined
                  ? { cache_creation_input_tokens: ccit }
                  : {}),
              };
            }
          } else if (eventType === "content_block_start") {
            const index = parsed.index as number;
            const block = parsed.content_block as Record<string, unknown>;
            // A "web_search_tool_result" block identifies itself via tool_use_id (linking back
            // to the server_tool_use call it answers), not `id` like tool_use/server_tool_use
            // blocks do — capture whichever the block actually carries.
            const blockId =
              (block.id as string | undefined) ??
              (block.tool_use_id as string | undefined);
            const blockName = block.name as string | undefined;
            currentBlockMeta[index] = {
              type: block.type as string,
              ...(blockId !== undefined ? { id: blockId } : {}),
              ...(blockName !== undefined ? { name: blockName } : {}),
            };
            currentBlockText[index] = "";
            // §A1.25: a "web_search_tool_result" block (Anthropic's native web-search tool)
            // arrives fully formed here — its results, not a text stream to accumulate via
            // content_block_delta — so capture them now for content_block_stop to emit.
            if (block.type === "web_search_tool_result") {
              currentBlockResults[index] =
                (block.content as ContentBlock["web_search_results"]) ?? [];
            }
          } else if (eventType === "content_block_delta") {
            const index = parsed.index as number;
            const delta = parsed.delta as Record<string, unknown>;
            if (delta.type === "text_delta") {
              const text = (delta.text as string) ?? "";
              currentBlockText[index] = (currentBlockText[index] ?? "") + text;
              onChunk(text);
            } else if (delta.type === "input_json_delta") {
              const partialJson = (delta.partial_json as string) ?? "";
              currentBlockText[index] =
                (currentBlockText[index] ?? "") + partialJson;
            } else if (delta.type === "thinking_delta") {
              const thinking = (delta.thinking as string) ?? "";
              currentBlockText[index] =
                (currentBlockText[index] ?? "") + thinking;
            }
          } else if (eventType === "content_block_stop") {
            const index = parsed.index as number;
            const meta = currentBlockMeta[index];
            const text = currentBlockText[index] ?? "";

            if (meta) {
              if (meta.type === "text") {
                contentBlocks.push({ type: "text", text });
              } else if (
                meta.type === "tool_use" ||
                meta.type === "server_tool_use"
              ) {
                // §A1.25: "server_tool_use" is Anthropic's native web-search tool calling itself
                // server-side — streamed the same way as a regular tool_use (input_json_delta),
                // just a distinct block type in the final response so callers can tell "the
                // caller must execute this" apart from "Anthropic already executed this".
                let input: Record<string, unknown> = {};
                try {
                  input = JSON.parse(text) as Record<string, unknown>;
                } catch {
                  // keep empty object
                }
                contentBlocks.push({
                  type: meta.type as "tool_use" | "server_tool_use",
                  ...(meta.id !== undefined ? { id: meta.id } : {}),
                  ...(meta.name !== undefined ? { name: meta.name } : {}),
                  input,
                });
              } else if (meta.type === "web_search_tool_result") {
                contentBlocks.push({
                  type: "web_search_tool_result",
                  ...(meta.id !== undefined ? { tool_use_id: meta.id } : {}),
                  web_search_results: currentBlockResults[index] ?? [],
                });
              } else if (meta.type === "thinking") {
                usage.thinking_tokens =
                  (usage.thinking_tokens ?? 0) +
                  Math.ceil(text.length / CHARS_PER_TOKEN);
              }
            }
          } else if (eventType === "message_delta") {
            const delta = parsed.delta as Record<string, unknown>;
            stopReason =
              (delta.stop_reason as LlmResponse["stop_reason"]) ?? "end_turn";
            const deltaUsage = parsed.usage as
              | Record<string, number>
              | undefined;
            if (deltaUsage) {
              usage.output_tokens =
                deltaUsage.output_tokens ?? usage.output_tokens;
            }
          }
        }
      }

      cbRecordSuccess(circuitKey);
      return {
        id: responseId,
        model: responseModel,
        role: "assistant",
        content: contentBlocks,
        stop_reason: stopReason,
        usage,
      };
    },
    3,
    1000,
    abortSignal
  );
}

// ── Token budget calculation ─────────────────────────────────────────────────
// G-C10: Token budget estimation (1 token ≈ 4 chars)

export function calculateTokenBudget(
  systemPrompt: string,
  history: LlmMessage[],
  kbContext: string,
  maxContextTokens = 100_000
): import("./types.js").TokenBudget {
  const contextLimit =
    Number.isSafeInteger(maxContextTokens) && maxContextTokens >= 0
      ? maxContextTokens
      : 0;
  const systemTokens = Math.ceil(
    (typeof systemPrompt === "string"
      ? systemPrompt.length
      : MAX_REQUEST_BYTES) / CHARS_PER_TOKEN
  );
  const kbTokens = Math.ceil(
    (typeof kbContext === "string" ? kbContext.length : MAX_REQUEST_BYTES) /
      CHARS_PER_TOKEN
  );

  let historyChars = 0;
  for (const msg of history) {
    if (!msg || typeof msg !== "object") {
      historyChars = Number.MAX_SAFE_INTEGER;
      break;
    }
    if (typeof msg.content === "string") {
      historyChars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (!block || typeof block !== "object") {
          historyChars = Number.MAX_SAFE_INTEGER;
          break;
        }
        historyChars += (block.text ?? "").length;
        try {
          historyChars += JSON.stringify(block.input ?? {}).length;
        } catch {
          historyChars = Number.MAX_SAFE_INTEGER;
          break;
        }
      }
    } else {
      historyChars = Number.MAX_SAFE_INTEGER;
    }
    if (historyChars >= Number.MAX_SAFE_INTEGER) break;
  }
  const historyTokens = Math.ceil(historyChars / CHARS_PER_TOKEN);

  const usedTokens = systemTokens + historyTokens + kbTokens;
  const remainingForResponse = Math.max(
    0,
    contextLimit - usedTokens - RESPONSE_RESERVE_TOKENS
  );

  return {
    maxContextTokens: contextLimit,
    systemTokens,
    historyTokens,
    kbTokens,
    remainingForResponse,
  };
}

// ── Input moderation ─────────────────────────────────────────────────────────
// G-C07: Detect obvious jailbreak patterns before sending to LLM

const JAILBREAK_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?previous\s+instructions?/i,
  /you\s+are\s+now\s+/i,
  /disregard\s+(your|all)\s+/i,
  /forget\s+(all\s+)?previous\s+/i,
  /system\s+prompt/i,
  /<\|im_start\|>/i,
  /<\|im_end\|>/i,
  /\[INST\]/i,
  /\[\/INST\]/i,
  /<<SYS>>/i,
  /<\/SYS>>/i,
  /do\s+anything\s+now/i,
  /dan\s+mode/i,
  /jailbreak/i,
  /pretend\s+(you\s+are|to\s+be)\s+(an?\s+)?ai\s+without/i,
  /act\s+as\s+if\s+you\s+have\s+no\s+(restrictions|limitations)/i,
  /bypass\s+(your\s+)?(safety|filter|restriction)/i,
  /override\s+(your\s+)?(instructions?|programming)/i,
];

export function moderateInput(userMessage: string): {
  blocked: boolean;
  reason?: string;
} {
  if (typeof userMessage !== "string") {
    return { blocked: true, reason: "Message must be text" };
  }
  if (userMessage.length > 1_000_000) {
    return { blocked: true, reason: "Message exceeds moderation size limit" };
  }
  for (const pattern of JAILBREAK_PATTERNS) {
    if (pattern.test(userMessage)) {
      return {
        blocked: true,
        reason: `Message matches disallowed pattern: ${pattern.source}`,
      };
    }
  }
  return { blocked: false };
}

// ── Output moderation ────────────────────────────────────────────────────────
// G-C08: Detect system prompt leakage in model response

export function moderateOutput(
  response: string,
  systemPromptFirstLine: string
): { flagged: boolean; reason?: string } {
  if (
    typeof response !== "string" ||
    typeof systemPromptFirstLine !== "string"
  ) {
    return { flagged: true, reason: "Response or system prompt is invalid" };
  }
  if (response.length > 1_000_000) {
    return { flagged: true, reason: "Response exceeds moderation size limit" };
  }
  if (!systemPromptFirstLine) return { flagged: false };

  // Check if the first 20 chars of the system prompt appear verbatim in the response
  const systemPrefix = systemPromptFirstLine.slice(0, 20);
  if (systemPrefix.length > 0 && response.includes(systemPrefix)) {
    return {
      flagged: true,
      reason: "Response may contain system prompt content",
    };
  }

  return { flagged: false };
}
