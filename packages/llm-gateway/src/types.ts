// ── LLM Gateway Types ─────────────────────────────────────────────────────────
// Fulfills G-C01 through G-C08: LLM Gateway type definitions

export interface LlmMessage {
  role: "user" | "assistant" | "tool_result";
  content: string | ContentBlock[];
}

export interface ContentBlock {
  // §A1.25: "server_tool_use"/"web_search_tool_result" are Anthropic's native web-search tool's
  // own block types (the model calls the tool server-side; Anthropic executes it and returns the
  // result inline) — distinct from "tool_use", which is Naelao's own custom function-calling
  // surface where the CALLER executes the tool and replies with a "tool_result" block.
  type: "text" | "tool_use" | "tool_result" | "server_tool_use" | "web_search_tool_result";
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  /** "web_search_tool_result" carries the search results Anthropic's server executed, not a
   *  string — one entry per result the model's native web_search tool call returned. */
  web_search_results?: Array<{ title?: string; url?: string; encrypted_content?: string; page_age?: string }>;
  // Prompt caching support (G-C05)
  cache_control?: { type: "ephemeral" };
}

/** Naelao's own custom function-calling tool — the CALLER executes it and replies with a
 *  "tool_result" block (the script-engine's whole tool surface uses this shape). */
export interface LlmFunctionTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>; // JSON Schema object
  require_approval?: boolean; // G-AY01: HITL — pause agent and wait for human approval before executing
  // Prompt caching (G-C05) — set on the LAST tool in the array by buildRequestBody, same "mark
  // the last block of a stable prefix" convention already used for the system prompt below.
  cache_control?: { type: "ephemeral" };
}

/** §A1.25: Anthropic's native, server-executed web search tool (CF AI Gateway proxies it
 *  transparently — same Unified Billing as the rest of the LLM call, no separate provider key on
 *  our side). Anthropic runs the search itself; the model's response carries
 *  "server_tool_use"/"web_search_tool_result" content blocks rather than a "tool_use" this caller
 *  must execute. See https://developers.cloudflare.com/ai-gateway/usage/web-search/. */
export interface LlmNativeWebSearchTool {
  type: "web_search_20250305";
  name: "web_search";
  max_uses?: number;
  allowed_domains?: string[];
  blocked_domains?: string[];
  user_location?: { type: "approximate"; city?: string; region?: string; country?: string; timezone?: string };
  cache_control?: { type: "ephemeral" };
}

export type LlmTool = LlmFunctionTool | LlmNativeWebSearchTool;

export interface LlmRequest {
  model: string;
  system?: string | SystemBlock[];
  messages: LlmMessage[];
  tools?: LlmTool[];
  max_tokens: number;
  temperature?: number;
  stream?: boolean;
  metadata?: { user_id?: string };
}

export interface SystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

export interface LlmResponse {
  id: string;
  model: string;
  role: "assistant";
  content: ContentBlock[];
  stop_reason: "end_turn" | "max_tokens" | "tool_use" | "stop_sequence";
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    // G-Z11: Extended thinking tokens (claude-opus-4-8) — billed at output token rate
    thinking_tokens?: number;
  };
}

export interface TokenBudget {
  maxContextTokens: number;
  systemTokens: number;
  historyTokens: number;
  kbTokens: number;
  remainingForResponse: number;
}
