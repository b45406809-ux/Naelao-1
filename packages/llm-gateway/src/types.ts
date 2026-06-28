// ── LLM Gateway Types ─────────────────────────────────────────────────────────
// Fulfills G-C01 through G-C08: LLM Gateway type definitions

export interface LlmMessage {
  role: "user" | "assistant" | "tool_result";
  content: string | ContentBlock[];
}

export interface ContentBlock {
  type: "text" | "tool_use" | "tool_result";
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  // Prompt caching support (G-C05)
  cache_control?: { type: "ephemeral" };
}

export interface LlmTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>; // JSON Schema object
  require_approval?: boolean; // G-AY01: HITL — pause agent and wait for human approval before executing
}

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
