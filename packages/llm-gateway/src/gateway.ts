// ── LLM Gateway ───────────────────────────────────────────────────────────────
// Fulfills G-C01 through G-C12: Anthropic Messages API integration
// - Prompt caching (G-C05)
// - Retry with exponential backoff (G-C06)
// - Input/output moderation stubs (G-C07, G-C08)
// - Streaming SSE (G-C09)
// - Token budget calculation (G-C10)

import type {
  LlmRequest,
  LlmResponse,
  LlmMessage,
  ContentBlock,
  SystemBlock,
} from "./types.js";

export type { LlmMessage, LlmRequest, LlmResponse, ContentBlock, SystemBlock };
export type { LlmTool, TokenBudget } from "./types.js";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_API_VERSION = "2023-06-01";

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
  if (gateway && gateway.accountId && gateway.accountId !== "placeholder") {
    return {
      url: `https://gateway.ai.cloudflare.com/v1/${gateway.accountId}/${gateway.gatewayId}/anthropic/v1/messages`,
      headers: gateway.aigToken ? { "cf-aig-authorization": `Bearer ${gateway.aigToken}` } : {},
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

const circuitBreaker: CircuitBreakerState = { failures: 0, openedAt: null };

function cbIsOpen(): boolean {
  if (circuitBreaker.openedAt === null) return false;
  // Auto-reset after CB_RESET_MS (half-open probe)
  if (Date.now() - circuitBreaker.openedAt >= CB_RESET_MS) {
    circuitBreaker.openedAt = null;
    circuitBreaker.failures = 0;
    return false;
  }
  return true;
}

function cbRecordSuccess(): void {
  circuitBreaker.failures = 0;
  circuitBreaker.openedAt = null;
}

function cbRecordFailure(): void {
  circuitBreaker.failures++;
  if (circuitBreaker.failures >= CB_FAILURE_THRESHOLD) {
    circuitBreaker.openedAt = Date.now();
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
        (err.status === 529 || err.status === 503 || err.status === 529);
      if (!isRetryable || attempt === maxAttempts - 1) {
        throw err;
      }
      const delayMs = baseDelayMs * Math.pow(2, attempt); // 1s, 2s, 4s
      await sleep(delayMs, abortSignal);
    }
  }
  throw lastError;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("Request aborted"));
      });
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
  const body: Record<string, unknown> = {
    model: request.model,
    max_tokens: request.max_tokens,
    messages: request.messages,
  };

  if (request.temperature !== undefined) {
    body.temperature = request.temperature;
  }

  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools;
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

  return body;
}

// ── callLlm: non-streaming request ──────────────────────────────────────────

export async function callLlm(
  apiKey: string,
  request: LlmRequest,
  abortSignal?: AbortSignal,
  gateway?: AiGatewayConfig
): Promise<LlmResponse> {
  // G-AO11: Fail fast if circuit breaker is open
  if (cbIsOpen()) {
    throw new LlmGatewayError(503, "circuit_open", "LLM provider circuit breaker is open — too many recent failures");
  }
  if (!apiKey && !gateway?.aigToken) {
    throw new LlmGatewayError(500, "no_llm_credentials", "no LLM credentials: set NAELAO_AIG_TOKEN (CF AI Gateway stored key) or ANTHROPIC_API_KEY");
  }
  const endpoint = resolveAnthropicEndpoint(gateway);

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
        const errText = await response.text().catch(() => "");
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
          cbRecordFailure();
        }
        throw err;
      }

      cbRecordSuccess();
      return response.json() as Promise<LlmResponse>;
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
  // G-AO11: Fail fast if circuit breaker is open
  if (cbIsOpen()) {
    throw new LlmGatewayError(503, "circuit_open", "LLM provider circuit breaker is open — too many recent failures");
  }
  if (!apiKey && !gateway?.aigToken) {
    throw new LlmGatewayError(500, "no_llm_credentials", "no LLM credentials: set NAELAO_AIG_TOKEN (CF AI Gateway stored key) or ANTHROPIC_API_KEY");
  }
  const endpoint = resolveAnthropicEndpoint(gateway);

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
        const errText = await response.text().catch(() => "");
        // Record 5xx and 429 as provider failures for the circuit breaker
        if (response.status >= 500 || response.status === 429) {
          cbRecordFailure();
        }
        throw new LlmGatewayError(
          response.status,
          "api_error",
          `Anthropic stream error ${response.status}: ${errText.slice(0, 200)}`
        );
      }

      if (!response.body) {
        throw new LlmGatewayError(0, "no_body", "No response body for streaming");
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

      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE messages (split on double newline)
        const messages = buffer.split("\n\n");
        buffer = messages.pop() ?? "";

        for (const message of messages) {
          if (!message.trim()) continue;

          let eventType = "";
          let eventData = "";

          for (const line of message.split("\n")) {
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
                ...(crit !== undefined ? { cache_read_input_tokens: crit } : {}),
                ...(ccit !== undefined ? { cache_creation_input_tokens: ccit } : {}),
              };
            }
          } else if (eventType === "content_block_start") {
            const index = parsed.index as number;
            const block = parsed.content_block as Record<string, unknown>;
            const blockId = block.id as string | undefined;
            const blockName = block.name as string | undefined;
            currentBlockMeta[index] = {
              type: block.type as string,
              ...(blockId !== undefined ? { id: blockId } : {}),
              ...(blockName !== undefined ? { name: blockName } : {}),
            };
            currentBlockText[index] = "";
          } else if (eventType === "content_block_delta") {
            const index = parsed.index as number;
            const delta = parsed.delta as Record<string, unknown>;
            if (delta.type === "text_delta") {
              const text = (delta.text as string) ?? "";
              currentBlockText[index] =
                (currentBlockText[index] ?? "") + text;
              onChunk(text);
            } else if (delta.type === "input_json_delta") {
              const partialJson = (delta.partial_json as string) ?? "";
              currentBlockText[index] =
                (currentBlockText[index] ?? "") + partialJson;
            }
          } else if (eventType === "content_block_stop") {
            const index = parsed.index as number;
            const meta = currentBlockMeta[index];
            const text = currentBlockText[index] ?? "";

            if (meta) {
              if (meta.type === "text") {
                contentBlocks.push({ type: "text", text });
              } else if (meta.type === "tool_use") {
                let input: Record<string, unknown> = {};
                try {
                  input = JSON.parse(text) as Record<string, unknown>;
                } catch {
                  // keep empty object
                }
                contentBlocks.push({
                  type: "tool_use",
                  ...(meta.id !== undefined ? { id: meta.id } : {}),
                  ...(meta.name !== undefined ? { name: meta.name } : {}),
                  input,
                });
              }
            }
          } else if (eventType === "message_delta") {
            const delta = parsed.delta as Record<string, unknown>;
            stopReason =
              (delta.stop_reason as LlmResponse["stop_reason"]) ?? "end_turn";
            const deltaUsage = parsed.usage as Record<string, number> | undefined;
            if (deltaUsage) {
              usage.output_tokens = deltaUsage.output_tokens ?? usage.output_tokens;
            }
          } else if (eventType === "content_block_stop") {
            // G-Z11: Capture thinking token count from reasoning blocks (extended thinking)
            const index = parsed.index as number | undefined;
            if (index !== undefined) {
              const meta = currentBlockMeta[index];
              if (meta?.type === "thinking") {
                // Approximate thinking token count: reasoning text / 4 chars per token
                const thinkingText = currentBlockText[index] ?? "";
                const approxThinkingTokens = Math.ceil(thinkingText.length / 4);
                usage.thinking_tokens = (usage.thinking_tokens ?? 0) + approxThinkingTokens;
              }
            }
          }
        }
      }

      cbRecordSuccess();
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
  const systemTokens = Math.ceil(systemPrompt.length / CHARS_PER_TOKEN);
  const kbTokens = Math.ceil(kbContext.length / CHARS_PER_TOKEN);

  let historyChars = 0;
  for (const msg of history) {
    if (typeof msg.content === "string") {
      historyChars += msg.content.length;
    } else {
      for (const block of msg.content) {
        historyChars += (block.text ?? "").length;
        historyChars += JSON.stringify(block.input ?? {}).length;
      }
    }
  }
  const historyTokens = Math.ceil(historyChars / CHARS_PER_TOKEN);

  const usedTokens = systemTokens + historyTokens + kbTokens;
  const remainingForResponse = Math.max(
    0,
    maxContextTokens - usedTokens - RESPONSE_RESERVE_TOKENS
  );

  return {
    maxContextTokens,
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
