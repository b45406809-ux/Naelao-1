// ── NaelaoAgentDO — ReAct Agent Durable Object ───────────────────────────────
// Fulfills G-D01 through G-D20: Agent runtime with ReAct loop, tool dispatch,
// timeout watchdog, and SQLite-persisted run state.
//
// CRITICAL DO rules:
//   - this.ctx.storage.sql.exec(query, ...params) with ? placeholders ONLY
//   - All state persisted to SQLite (hibernation kills in-memory)
//   - Alarm used for 30s timeout watchdog

import { DurableObject } from "cloudflare:workers";
import type { LlmTool, LlmMessage, ContentBlock } from "@naelao/llm-gateway";
import { callLlm, moderateInput, moderateOutput } from "@naelao/llm-gateway";
import type { SystemBlock } from "@naelao/llm-gateway";
import { moderateText } from "@naelao/moderation";
import {
  ScriptToolSurface,
  runScriptLoop,
  loadAgentConfig,
  type ScriptEngineEnv,
} from "../script-engine/index.js";
import { GatewayReasoner, WorkersAIEmbedder } from "../script-engine/reasoner.js";

// ── G-AZ01: Agent FSM states and valid transitions ───────────────────────────

type AgentFsmState =
  | "IDLE"
  | "PLANNING"
  | "TOOL_CALL"
  | "AWAITING_TOOL"
  | "AWAITING_HUMAN"
  | "SUMMARIZING"
  | "DONE"
  | "ERROR";

const FSM_TRANSITIONS: Record<AgentFsmState, AgentFsmState[]> = {
  IDLE:           ["PLANNING", "ERROR"],
  PLANNING:       ["TOOL_CALL", "SUMMARIZING", "AWAITING_HUMAN", "ERROR"],
  TOOL_CALL:      ["AWAITING_TOOL", "ERROR"],
  AWAITING_TOOL:  ["PLANNING", "ERROR"],
  AWAITING_HUMAN: ["PLANNING", "DONE", "ERROR"],
  SUMMARIZING:    ["DONE", "ERROR"],
  DONE:           [],
  ERROR:          [],
};

function isFsmTransitionValid(from: AgentFsmState, to: AgentFsmState): boolean {
  return FSM_TRANSITIONS[from]?.includes(to) ?? false;
}

// ── SQLite row types ─────────────────────────────────────────────────────────

interface AgentRunRow {
  id: string;
  session_id: string;
  space_id: string;
  tenant_id: string;
  status: string;
  fsm_state: AgentFsmState;
  goal: string;
  react_steps: string;
  final_answer: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

// ── ReAct step types ─────────────────────────────────────────────────────────

interface ReactStep {
  iteration: number;
  thought?: string;
  action?: {
    toolName: string;
    toolInput: Record<string, unknown>;
    toolUseId: string;
  };
  observation?: string;
  finalAnswer?: string;
  timestamp: string;
}

// ── Tool dispatch result ─────────────────────────────────────────────────────

interface ToolResult {
  output: string;
  error?: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_ITERATIONS = 10;
const MAX_GOAL_LENGTH = 10_000;
// G-BB41: 64KB cap per tool response (down from 100KB) to limit context bloat
const MAX_TOOL_OUTPUT_BYTES = 64 * 1024;
const TIMEOUT_MS = 30_000; // 30 seconds
const TIMEOUT_QUERY_THRESHOLD_S = 25; // flag runs older than 25s
// G-X01: Per-tool call limit within a single run — prevents recursive tool loops
const MAX_CALLS_PER_TOOL = 5;
// G-BB41: Hard cap on total tool calls per turn (loop iteration) and per run
const MAX_TOOL_CALLS_PER_TURN = 20;
const MAX_TOOL_CALLS_PER_RUN = 100;
// G-N44: Max messages kept in context window (keeps first + most recent N-1)
const MAX_CONTEXT_MESSAGES = 40;

// G-BB03: Context window budget constants
// claude-sonnet-4-6 supports 200K tokens; we reserve 10K headroom for completion
const MODEL_CONTEXT_LIMIT_TOKENS = 190_000;
// Budget allocation per spec: system 20%, KB 40%, conversation 30%, remainder 10%
const SYSTEM_BUDGET_TOKENS   = Math.floor(MODEL_CONTEXT_LIMIT_TOKENS * 0.20); // 38K
const KB_BUDGET_TOKENS       = Math.floor(MODEL_CONTEXT_LIMIT_TOKENS * 0.40); // 76K
const CONVO_BUDGET_TOKENS    = Math.floor(MODEL_CONTEXT_LIMIT_TOKENS * 0.30); // 57K

// Rough token estimator: 1 token ≈ 4 chars (conservative for English text)
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimateMessageTokens(messages: LlmMessage[]): number {
  return messages.reduce((sum, m) => {
    const text = typeof m.content === "string"
      ? m.content
      : (Array.isArray(m.content) ? m.content.map(b => (b as {text?: string}).text ?? "").join("") : "");
    return sum + estimateTokens(text) + 4; // +4 for role/formatting overhead
  }, 0);
}

// G-BB03: Apply priority-based context budget truncation.
// Returns { messages, kbContext, truncated } — caller uses returned values for LLM call.
function applyContextBudget(
  systemText: string,
  messages: LlmMessage[],
  kbContext: string,
): { messages: LlmMessage[]; kbContext: string; truncated: boolean } {
  let truncated = false;
  let resultKbContext = kbContext;
  let resultMessages = messages;

  // 1. Check system prompt budget (non-truncatable — just log if over)
  const systemTokens = estimateTokens(systemText);
  if (systemTokens > SYSTEM_BUDGET_TOKENS) {
    console.warn(`[ContextBudget] System prompt ${systemTokens} tokens exceeds budget ${SYSTEM_BUDGET_TOKENS}`);
  }

  // 2. Truncate KB context to budget
  const kbTokens = estimateTokens(kbContext);
  if (kbTokens > KB_BUDGET_TOKENS) {
    // Truncate KB context to fit budget (rough char limit)
    const maxKbChars = KB_BUDGET_TOKENS * 4;
    resultKbContext = kbContext.slice(0, maxKbChars) + "\n[KB_CONTEXT_TRUNCATED]";
    truncated = true;
    console.warn(`[ContextBudget] G-BB03 KB context truncated: ${kbTokens} → ${KB_BUDGET_TOKENS} tokens`);
  }

  // 3. Truncate conversation to budget (keep first message + recent turns)
  const convoTokens = estimateMessageTokens(resultMessages);
  if (convoTokens > CONVO_BUDGET_TOKENS) {
    truncated = true;
    // Binary search for the right number of messages to keep
    let lo = 1, hi = resultMessages.length;
    while (lo < hi - 1) {
      const mid = Math.floor((lo + hi) / 2);
      const candidate = [resultMessages[0]!, ...resultMessages.slice(-mid)];
      if (estimateMessageTokens(candidate) <= CONVO_BUDGET_TOKENS) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    const keepCount = Math.max(lo, 1);
    resultMessages = [resultMessages[0]!, ...resultMessages.slice(-keepCount)];
    console.warn(`[ContextBudget] G-BB03 conversation truncated: kept ${resultMessages.length}/${messages.length} messages`);
  }

  return { messages: resultMessages, kbContext: resultKbContext, truncated };
}

// G-AZ09: LLM pricing constants (claude-sonnet-4-6, USD per million tokens)
const PRICING = {
  input_per_mtok: 3.00,
  output_per_mtok: 15.00,
  cache_read_per_mtok: 0.30,
  cache_write_per_mtok: 3.75,
} as const;

function computeLlmCostUsd(usage: {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}): number {
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
  const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;
  // Cached read tokens use different pricing — subtract from regular input
  const regularInputTokens = Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens);
  return (
    (regularInputTokens / 1_000_000) * PRICING.input_per_mtok +
    (outputTokens / 1_000_000) * PRICING.output_per_mtok +
    (cacheReadTokens / 1_000_000) * PRICING.cache_read_per_mtok +
    (cacheWriteTokens / 1_000_000) * PRICING.cache_write_per_mtok
  );
}

// G-N44: Correct context truncation — keep first message (user goal) and most
// recent (maxCount-1) messages in chronological order.
// NEVER use splice() in a reverse loop (inserts at index 1, reversing order).
function truncateMiddle<T>(messages: T[], maxCount: number): T[] {
  if (messages.length <= maxCount) return messages;
  return [messages[0]!, ...messages.slice(-(maxCount - 1))];
}

// Blocked SSRF domains (G-D15: prevent SSRF in tool execution)
const BLOCKED_DOMAIN_PATTERNS: RegExp[] = [
  /^localhost$/i,
  /^127\.\d+\.\d+\.\d+$/,
  /^0\.0\.0\.0$/,
  /^169\.254\.\d+\.\d+$/, // link-local
  /^10\.\d+\.\d+\.\d+$/,  // RFC1918
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/, // RFC1918
  /^192\.168\.\d+\.\d+$/, // RFC1918
  /^::1$/,                 // IPv6 loopback
  /^fc[0-9a-f]{2}:/i,     // IPv6 ULA
];

// ── Safe math expression parser ──────────────────────────────────────────────
// G-D16: No eval() — recursive descent parser for +-*/() and numbers only

class ExprParser {
  private pos = 0;

  constructor(private readonly expr: string) {}

  parse(): number {
    const result = this.parseAddSub();
    if (this.pos < this.expr.length) {
      throw new Error(`Unexpected character at position ${this.pos}`);
    }
    return result;
  }

  private parseAddSub(): number {
    let left = this.parseMulDiv();
    while (this.pos < this.expr.length) {
      const ch = this.expr[this.pos];
      if (ch === "+") {
        this.pos++;
        left += this.parseMulDiv();
      } else if (ch === "-") {
        this.pos++;
        left -= this.parseMulDiv();
      } else {
        break;
      }
    }
    return left;
  }

  private parseMulDiv(): number {
    let left = this.parseUnary();
    while (this.pos < this.expr.length) {
      const ch = this.expr[this.pos];
      if (ch === "*") {
        this.pos++;
        left *= this.parseUnary();
      } else if (ch === "/") {
        this.pos++;
        const divisor = this.parseUnary();
        if (divisor === 0) throw new Error("Division by zero");
        left /= divisor;
      } else {
        break;
      }
    }
    return left;
  }

  private parseUnary(): number {
    this.skipSpaces();
    if (this.expr[this.pos] === "-") {
      this.pos++;
      return -this.parsePrimary();
    }
    if (this.expr[this.pos] === "+") {
      this.pos++;
      return this.parsePrimary();
    }
    return this.parsePrimary();
  }

  private parsePrimary(): number {
    this.skipSpaces();
    if (this.expr[this.pos] === "(") {
      this.pos++; // consume (
      const val = this.parseAddSub();
      this.skipSpaces();
      if (this.expr[this.pos] !== ")") {
        throw new Error("Expected closing parenthesis");
      }
      this.pos++; // consume )
      return val;
    }

    // Parse number (integer or decimal)
    const start = this.pos;
    while (
      this.pos < this.expr.length &&
      /[\d.]/.test(this.expr[this.pos] ?? "")
    ) {
      this.pos++;
    }
    const numStr = this.expr.slice(start, this.pos);
    if (!numStr) {
      throw new Error(`Unexpected character '${this.expr[this.pos]}' at position ${this.pos}`);
    }
    const num = parseFloat(numStr);
    if (isNaN(num)) {
      throw new Error(`Invalid number: ${numStr}`);
    }
    return num;
  }

  private skipSpaces(): void {
    while (this.pos < this.expr.length && this.expr[this.pos] === " ") {
      this.pos++;
    }
  }
}

function safeCalculate(expression: string): number {
  // Validate: only allow digits, ., +, -, *, /, (, ), spaces
  if (!/^[\d\s+\-*/().]+$/.test(expression)) {
    throw new Error("Invalid characters in expression");
  }
  if (expression.length > 500) {
    throw new Error("Expression too long");
  }
  return new ExprParser(expression).parse();
}

// ── Tool services (injected from DO env) ─────────────────────────────────────

interface ToolServices {
  knowledgeWorker: Fetcher;
  spaceId: string;
  tenantId: string;
}

// ── beforeToolCall: policy interceptor (G-AB20) ──────────────────────────────
// Validates LLM-generated tool arguments before any execution occurs.

function beforeToolCall(
  toolName: string,
  toolInput: Record<string, unknown>
): { allow: boolean; reason?: string } {
  const ALLOWED_TOOLS = new Set(["http_get", "search_web", "calculate", "search_kb"]);

  if (!ALLOWED_TOOLS.has(toolName)) {
    return { allow: false, reason: `Tool '${toolName}' is not in the allowed tool list` };
  }

  if (toolName === "http_get") {
    const url = toolInput.url;
    if (typeof url !== "string" || !url) {
      return { allow: false, reason: "http_get requires a string url parameter" };
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { allow: false, reason: "http_get url is not a valid URL" };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { allow: false, reason: "http_get only allows http/https protocols" };
    }
    // Pre-flight SSRF check (mirrors the runtime blocklist in dispatchTool)
    for (const pattern of BLOCKED_DOMAIN_PATTERNS) {
      if (pattern.test(parsed.hostname)) {
        return { allow: false, reason: `http_get target '${parsed.hostname}' is in a blocked IP range` };
      }
    }
  }

  if (toolName === "calculate") {
    const expr = toolInput.expression;
    if (typeof expr !== "string" || !expr) {
      return { allow: false, reason: "calculate requires a string expression parameter" };
    }
    if (!/^[\d\s+\-*/().]+$/.test(expr)) {
      return { allow: false, reason: "calculate expression contains disallowed characters" };
    }
    if (expr.length > 500) {
      return { allow: false, reason: "calculate expression exceeds length limit" };
    }
  }

  if (toolName === "search_kb") {
    const query = toolInput.query;
    if (typeof query !== "string" || !query) {
      return { allow: false, reason: "search_kb requires a string query parameter" };
    }
  }

  return { allow: true };
}

// ── Tool dispatch ────────────────────────────────────────────────────────────

async function dispatchTool(
  toolName: string,
  toolInput: Record<string, unknown>,
  allowedDomains: string[],
  services: ToolServices
): Promise<ToolResult> {
  switch (toolName) {
    case "http_get": {
      const url = toolInput.url as string;
      if (!url || typeof url !== "string") {
        return { output: "", error: "Missing or invalid url parameter" };
      }

      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url);
      } catch {
        return { output: "", error: "Invalid URL format" };
      }

      // Only allow http/https
      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        return { output: "", error: "Only http/https protocols allowed" };
      }

      const hostname = parsedUrl.hostname;

      // Check SSRF blocklist
      for (const pattern of BLOCKED_DOMAIN_PATTERNS) {
        if (pattern.test(hostname)) {
          return {
            output: "",
            error: `Domain '${hostname}' is not allowed (blocked range)`,
          };
        }
      }

      // Check allowlist
      const isAllowed = allowedDomains.some((domain) => {
        if (domain.startsWith("*.")) {
          const suffix = domain.slice(2);
          return hostname === suffix || hostname.endsWith("." + suffix);
        }
        return hostname === domain;
      });

      if (!isAllowed) {
        return {
          output: "",
          error: `Domain '${hostname}' is not in the allowlist`,
        };
      }

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10_000);
        const resp = await fetch(url, {
          method: "GET",
          headers: { "User-Agent": "Naelao-Agent/1.0" },
          signal: controller.signal,
        });
        clearTimeout(timeout);

        const text = await resp.text();
        // Truncate to 100KB
        const truncated =
          text.length > MAX_TOOL_OUTPUT_BYTES
            ? text.slice(0, MAX_TOOL_OUTPUT_BYTES) +
              `\n[TRUNCATED: output exceeded ${MAX_TOOL_OUTPUT_BYTES} bytes]`
            : text;

        // G-AA25 / G-AH45: Scan web content for prompt injection before returning to LLM.
        // Check in 4KB windows across the full response to catch injections in long pages.
        const SCAN_WINDOW = 4000;
        let injectionDetected = false;
        for (let pos = 0; pos < truncated.length; pos += SCAN_WINDOW) {
          const windowText = truncated.slice(pos, pos + SCAN_WINDOW);
          const webMod = moderateInput(windowText);
          if (webMod.blocked) {
            injectionDetected = true;
            console.warn(`[agent][security] Prompt injection detected in http_get result url=${url} pos=${pos} reason=${webMod.reason}`);
            break;
          }
        }

        const safeOutput = injectionDetected
          ? `[Content partially redacted: potential prompt injection detected in response]`
          : truncated;

        // G-AH45: Wrap external content in <untrusted_tool_result> to signal to the
        // LLM that this content must not be interpreted as instructions.
        return { output: `<untrusted_tool_result>\nHTTP ${resp.status}\n${safeOutput}\n</untrusted_tool_result>` };
      } catch (err) {
        return { output: "", error: `Fetch failed: ${String(err)}` };
      }
    }

    case "search_web": {
      return {
        output: "Web search not available in this space",
      };
    }

    case "calculate": {
      const expression = toolInput.expression as string;
      if (!expression || typeof expression !== "string") {
        return { output: "", error: "Missing or invalid expression parameter" };
      }
      try {
        const result = safeCalculate(expression);
        return { output: String(result) };
      } catch (err) {
        return { output: "", error: `Calculation error: ${String(err)}` };
      }
    }

    // G-I04: KB retrieval via knowledge worker service binding
    case "search_kb": {
      const query = toolInput.query as string;
      if (!query || typeof query !== "string") {
        return { output: "", error: "Missing or invalid query parameter" };
      }

      try {
        const resp = await services.knowledgeWorker.fetch(
          `http://knowledge-worker/spaces/${services.spaceId}/kb/search?q=${encodeURIComponent(query)}&top_k=5`,
          {
            method: "GET",
            headers: { "x-naelao-tenant-id": services.tenantId },
          }
        );

        if (!resp.ok) {
          return { output: "", error: `KB search failed: HTTP ${resp.status}` };
        }

        const data = await resp.json<{
          data?: Array<{ content: string; score?: number }>;
        }>();

        if (!data.data || data.data.length === 0) {
          return { output: "No results found in knowledge base" };
        }

        // G-BD01: Scan each retrieved KB chunk for prompt injection before context insertion
        const safeChunks = data.data.map((r, i) => {
          const chunkMod = moderateInput(r.content.slice(0, 4000));
          const safeContent = chunkMod.blocked
            ? `[CONTENT_REDACTED: retrieved chunk ${i + 1} contained disallowed patterns]`
            : r.content;
          return `[${i + 1}] ${safeContent}`;
        });
        const results = safeChunks.join("\n\n---\n\n");

        return { output: `<kb_content>\n${results}\n</kb_content>` };
      } catch (err) {
        return { output: "", error: `KB search error: ${String(err)}` };
      }
    }

    default:
      return {
        output: "",
        error: `Unknown tool: ${toolName}. Available tools: http_get, search_web, calculate, search_kb`,
      };
  }
}

// ── §86 AgentPress Error Processor — 30+ typed error catalog ─────────────────

export interface ProcessedError {
  code: string;
  category: "tool" | "llm" | "system" | "security" | "network";
  agentMessage: string;
  shouldRetry: boolean;
  isFatal: boolean;
}

export function processAgentException(
  error: Error,
  context: { toolName?: string; stderr?: string } = {}
): ProcessedError {
  const msg = error.message;

  // Security
  if (msg.includes("path traversal") || msg.includes("..") && msg.includes("blocked")) {
    return { code: "ERR_PATH_TRAVERSAL", category: "security",
      agentMessage: "Security Error: Path traversal blocked. Only access files inside your permitted workspace.",
      shouldRetry: false, isFatal: false };
  }
  if (msg.includes("Wallet denied") || msg.includes("insufficient credits")) {
    return { code: "ERR_WALLET_EMPTY", category: "security",
      agentMessage: "Payment Error: Insufficient funds. Stop task and ask user to add funds.",
      shouldRetry: false, isFatal: true };
  }
  if (msg.includes("blocked range") || msg.includes("not in the allowlist")) {
    return { code: "ERR_SSRF_BLOCKED", category: "security",
      agentMessage: "Security Error: URL blocked (internal network or not allowlisted). Only access external public URLs.",
      shouldRetry: false, isFatal: false };
  }

  // Tool syntax
  if (msg.includes("JSON parse error") || msg.includes("malformed XML") || msg.includes("Unexpected token")) {
    return { code: "ERR_TOOL_SYNTAX", category: "llm",
      agentMessage: "Tool Error: Malformed JSON/XML in tool call. Match the exact schema. No markdown wrappers.",
      shouldRetry: true, isFatal: false };
  }
  if (msg.includes("missing required parameter") || msg.includes("is required")) {
    return { code: "ERR_MISSING_PARAM", category: "tool",
      agentMessage: `Tool Error: ${msg}. Review tool definition and retry.`,
      shouldRetry: false, isFatal: false };
  }
  if (msg.includes("Unknown tool")) {
    return { code: "ERR_UNKNOWN_TOOL", category: "tool",
      agentMessage: `Tool Error: ${msg}. Only use tools from the provided tool list.`,
      shouldRetry: false, isFatal: false };
  }

  // File system
  if (msg.includes("ENOENT") || msg.includes("File not found") || msg.includes("no such file")) {
    const hasAbsPath = /^\/[a-z]|\/workspace|\/home/.test(msg);
    return { code: "ERR_FILE_NOT_FOUND", category: "tool",
      agentMessage: hasAbsPath
        ? "Tool Error: File not found — absolute path used. Use paths relative to workspace root."
        : "Tool Error: File not found. List the directory first to verify the path.",
      shouldRetry: false, isFatal: false };
  }
  if (msg.includes("EACCES") || msg.includes("Permission denied")) {
    return { code: "ERR_FILE_PERMISSION", category: "security",
      agentMessage: "Tool Error: Permission denied. Cannot access outside workspace.",
      shouldRetry: false, isFatal: false };
  }
  if (msg.includes("EISDIR") || msg.includes("Is a directory")) {
    return { code: "ERR_IS_DIRECTORY", category: "tool",
      agentMessage: "Tool Error: Path is a directory not a file. Use list_directory or provide a specific file path.",
      shouldRetry: false, isFatal: false };
  }
  if (msg.includes("ENOSPC") || msg.includes("no space left")) {
    return { code: "ERR_DISK_FULL", category: "system",
      agentMessage: "System Error: Workspace storage full. Delete unused files before proceeding.",
      shouldRetry: false, isFatal: false };
  }

  // Code execution
  if (context.toolName === "execute_python" && (msg.includes("Exit code: 1") || msg.includes("SyntaxError"))) {
    if (msg.includes("SyntaxError")) {
      return { code: "ERR_PYTHON_SYNTAX", category: "tool",
        agentMessage: `Syntax Error: ${msg}\n\nRewrite with correct Python 3 syntax.`,
        shouldRetry: false, isFatal: false };
    }
    return { code: "ERR_PYTHON_CRASH", category: "tool",
      agentMessage: `Execution Error: Python crashed.\nStderr:\n${context.stderr ?? ""}\n\nFix and rewrite.`,
      shouldRetry: false, isFatal: false };
  }
  if (context.toolName === "execute_bash" && msg.includes("Exit code:")) {
    return { code: "ERR_BASH_NONZERO", category: "tool",
      agentMessage: `Execution Error: Bash command failed.\nStderr: ${context.stderr ?? ""}\n\nAnalyze and fix.`,
      shouldRetry: false, isFatal: false };
  }
  if (msg.includes("command not found")) {
    const cmd = msg.match(/'(.+?)': command not found/)?.[1] ?? "command";
    return { code: "ERR_COMMAND_NOT_FOUND", category: "tool",
      agentMessage: `Execution Error: '${cmd}' not installed. Install with apt-get or npm, then retry.`,
      shouldRetry: false, isFatal: false };
  }
  if (msg.includes("ModuleNotFoundError") || msg.includes("Cannot find module")) {
    const mod = msg.match(/No module named '(.+?)'|Cannot find module '(.+?)'/)?.[1] ?? "unknown";
    return { code: "ERR_MODULE_NOT_FOUND", category: "tool",
      agentMessage: `Module Error: '${mod}' not installed. Run: pip install ${mod} or npm install ${mod}.`,
      shouldRetry: false, isFatal: false };
  }
  if (msg.toLowerCase().includes("timeout")) {
    return { code: "ERR_EXEC_TIMEOUT", category: "system",
      agentMessage: "Timeout Error: Command timed out. Break into smaller steps or use background mode.",
      shouldRetry: false, isFatal: false };
  }

  // Network / API
  if (msg.includes("429") || msg.includes("Too Many Requests") || msg.includes("rate limit")) {
    return { code: "ERR_RATE_LIMIT", category: "network",
      agentMessage: "Network Error: Rate limited (429). Pause before retrying or reduce call frequency.",
      shouldRetry: true, isFatal: false };
  }
  if (msg.includes("401") || msg.includes("Unauthorized")) {
    return { code: "ERR_API_UNAUTHORIZED", category: "network",
      agentMessage: "Auth Error: 401 Unauthorized. Credential may be expired. Ask user to re-enter API key.",
      shouldRetry: false, isFatal: false };
  }
  if (msg.includes("403") || msg.includes("Forbidden")) {
    return { code: "ERR_API_FORBIDDEN", category: "network",
      agentMessage: "Auth Error: 403 Forbidden. Credential lacks required permissions. Inform user to grant access.",
      shouldRetry: false, isFatal: false };
  }
  if (msg.includes("404") || msg.includes("Not Found")) {
    return { code: "ERR_API_NOT_FOUND", category: "network",
      agentMessage: "Resource Error: 404 Not Found. Resource ID may be wrong or deleted. Verify before retry.",
      shouldRetry: false, isFatal: false };
  }
  if (msg.includes("500") || msg.includes("Internal Server Error")) {
    return { code: "ERR_API_SERVER_ERROR", category: "network",
      agentMessage: "External API Error: 500 server error (not your fault). Wait 30s and retry once.",
      shouldRetry: true, isFatal: false };
  }
  if (msg.includes("502") || msg.includes("503") || msg.includes("Bad Gateway") || msg.includes("Service Unavailable")) {
    return { code: "ERR_API_GATEWAY", category: "network",
      agentMessage: "Network Error: Service temporarily unavailable (502/503). Retry after a brief wait.",
      shouldRetry: true, isFatal: false };
  }
  if (msg.includes("ECONNREFUSED") || msg.includes("ECONNRESET") || msg.includes("network error")) {
    return { code: "ERR_NETWORK", category: "network",
      agentMessage: "Network Error: Connection failed. Check if the service is reachable and retry.",
      shouldRetry: true, isFatal: false };
  }
  if (msg.includes("SSL") || msg.includes("certificate")) {
    return { code: "ERR_TLS", category: "network",
      agentMessage: "TLS Error: SSL certificate issue. Do not disable verification — inform the user.",
      shouldRetry: false, isFatal: false };
  }

  // LLM errors
  if (msg.includes("context_length_exceeded") || msg.includes("maximum context")) {
    return { code: "ERR_CONTEXT_OVERFLOW", category: "llm",
      agentMessage: "Context Error: Message history too long. Summarize earlier context or start a new session.",
      shouldRetry: false, isFatal: false };
  }
  if (msg.includes("overloaded") || msg.includes("capacity")) {
    return { code: "ERR_LLM_OVERLOADED", category: "llm",
      agentMessage: "LLM Error: Model overloaded. Retry in a moment.",
      shouldRetry: true, isFatal: false };
  }

  return { code: "ERR_UNKNOWN", category: "system",
    agentMessage: `Unexpected error: ${msg}. If this persists, break the task into smaller steps.`,
    shouldRetry: false, isFatal: false };
}

// ── NaelaoAgentDO ────────────────────────────────────────────────────────────

export interface AgentDOEnv {
  PLATFORM_SECRET: string;
  KNOWLEDGE_WORKER: Fetcher;
  SPACES_WORKER: Fetcher;
  HITL_APPROVAL_DO?: DurableObjectNamespace; // G-AY01: optional — HITL support
  ANALYTICS?: AnalyticsEngineDataset;         // G-AZ09: unit economics tracking
  // ── Script-first engine bindings (authoritative agent model; spec appendix ~6672k) ──
  /** R2 bucket holding the skill library + agent config + workspace. */
  SCRIPTS_R2?: R2Bucket;
  /** Vectorize index for script.find (optional — engine degrades to text scan). */
  SCRIPTS_VECTORIZE?: VectorizeIndex;
  /** Workers AI — embeddings for script.find and free-tier reasoning. */
  AI?: Ai;
  /** Notifications worker — owner/customer notifications + HITL surface. */
  NOTIFICATIONS_WORKER?: Fetcher;
  /** AI Gateway identity (spec §15). */
  NAELAO_ACCOUNT_ID?: string;
  NAELAO_GATEWAY_ID?: string;
}

export class NaelaoAgentDO extends DurableObject<AgentDOEnv> {
  private initialized = false;

  private ensureInit(): void {
    if (this.initialized) return;

    this.ctx.storage.sql.exec("PRAGMA journal_mode=WAL");
    this.ctx.storage.sql.exec("PRAGMA synchronous=NORMAL");
    this.ctx.storage.sql.exec("PRAGMA cache_size=-16384");

    // Core agent runs
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS agent_runs (
        id           TEXT PRIMARY KEY,
        session_id   TEXT NOT NULL,
        space_id     TEXT NOT NULL,
        tenant_id    TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'running',
        fsm_state    TEXT NOT NULL DEFAULT 'IDLE',
        goal         TEXT NOT NULL,
        react_steps  TEXT NOT NULL DEFAULT '[]',
        final_answer TEXT,
        error        TEXT,
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS idx_runs_session ON agent_runs(session_id, created_at DESC)`);
    try { this.ctx.storage.sql.exec(`ALTER TABLE agent_runs ADD COLUMN fsm_state TEXT NOT NULL DEFAULT 'IDLE'`); } catch { /* exists */ }

    // WAL: write-before-execute for crash recovery
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS run_wal (
        id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        run_id      TEXT NOT NULL,
        tool_name   TEXT NOT NULL,
        tool_args   TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'pending',
        result      TEXT,
        started_at  INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
        finished_at INTEGER
      )
    `);
    this.ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS idx_wal_run ON run_wal(run_id, started_at)`);

    // Background fibers
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS fibers (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        status     TEXT NOT NULL DEFAULT 'running',
        snapshot   TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
      )
    `);

    // Sessions + message tree
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id         TEXT PRIMARY KEY,
        thread_id  TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        session_id  TEXT NOT NULL REFERENCES sessions(id),
        parent_id   TEXT REFERENCES messages(id),
        role        TEXT NOT NULL,
        content     TEXT NOT NULL,
        tool_name   TEXT,
        token_count INTEGER DEFAULT 0,
        created_at  INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
      )
    `);
    this.ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at)`);
    try {
      this.ctx.storage.sql.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
          content, session_id UNINDEXED, content=messages, content_rowid=rowid
        )
      `);
    } catch { /* FTS5 not available */ }

    // Token replay buffer for WS reconnection
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS token_buffer (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id     TEXT NOT NULL,
        delta      TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
      )
    `);
    this.ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS idx_token_run ON token_buffer(run_id, id)`);

    // Agent memory (typed JSON entries, never flat Markdown)
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS agent_memory (
        key        TEXT NOT NULL,
        category   TEXT NOT NULL,
        value      TEXT NOT NULL,
        confidence REAL DEFAULT 1.0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
        PRIMARY KEY (key, category)
      )
    `);

    // Plan steps
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS plan_steps (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id     TEXT NOT NULL,
        step_text  TEXT NOT NULL,
        status     TEXT DEFAULT 'pending',
        order_idx  INTEGER NOT NULL,
        updated_at INTEGER DEFAULT (unixepoch('now') * 1000)
      )
    `);
    this.ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS idx_plan_run ON plan_steps(run_id, order_idx)`);

    this.initialized = true;
  }

  override async fetch(request: Request): Promise<Response> {
    this.ensureInit();

    const url = new URL(request.url);
    const method = request.method;

    // WebSocket upgrade
    if (request.headers.get("Upgrade") === "websocket") {
      return this.handleWebSocket(request);
    }

    try {
      // POST /warm — pre-warm DO (creates tables, returns status)
      if (method === "POST" && url.pathname === "/warm") {
        return Response.json({ status: "warm", ts: Date.now() });
      }

      // POST /run
      if (method === "POST" && url.pathname === "/run") {
        return this.handleRun(request);
      }

      // POST /script/run — script-first loop (authoritative agent model)
      if (method === "POST" && url.pathname === "/script/run") {
        return this.handleScriptRun(request);
      }

      // POST /cancel — cancel all active runs for this DO
      if (method === "POST" && url.pathname === "/cancel") {
        return this.handleCancelAll();
      }

      // GET /status
      if (method === "GET" && url.pathname === "/status") {
        return this.handleStatus();
      }

      // GET /fiber-status?runId=
      if (method === "GET" && url.pathname === "/fiber-status") {
        return this.handleFiberStatus(url.searchParams.get("runId") ?? "");
      }

      // GET /replay?runId=&after=
      if (method === "GET" && url.pathname === "/replay") {
        return this.handleReplay(
          url.searchParams.get("runId") ?? "",
          parseInt(url.searchParams.get("after") ?? "0", 10)
        );
      }

      // POST /approval/:approvalId/decide
      const approvalMatch = url.pathname.match(/^\/approval\/([^/]+)\/decide$/);
      if (method === "POST" && approvalMatch?.[1]) {
        return this.handleApprovalDecide(approvalMatch[1], request);
      }

      // GET /memory
      if (method === "GET" && url.pathname === "/memory") {
        return this.handleGetMemory(url.searchParams.get("category"));
      }

      // POST /memory
      if (method === "POST" && url.pathname === "/memory") {
        return this.handlePostMemory(request);
      }

      // GET /session/:sessionId/search?q=
      const searchMatch = url.pathname.match(/^\/session\/([^/]+)\/search$/);
      if (method === "GET" && searchMatch?.[1]) {
        return this.handleSessionSearch(searchMatch[1], url.searchParams.get("q") ?? "");
      }

      // POST /heartbeat
      if (method === "POST" && url.pathname === "/heartbeat") {
        return Response.json({ status: "ok", ts: Date.now() });
      }

      // GET /runs/:runId
      const runMatch = url.pathname.match(/^\/runs\/([^/]+)$/);
      if (method === "GET" && runMatch?.[1]) {
        return this.handleGetRun(runMatch[1]);
      }

      // POST /runs/:runId/cancel
      const cancelMatch = url.pathname.match(/^\/runs\/([^/]+)\/cancel$/);
      if (method === "POST" && cancelMatch?.[1]) {
        return this.handleCancelRun(cancelMatch[1]);
      }

      return Response.json(
        { error_code: "not_found", message: "Unknown DO route" },
        { status: 404 }
      );
    } catch (err) {
      console.error("NaelaoAgentDO error:", err);
      return Response.json(
        { error_code: "internal_error", message: String(err) },
        { status: 500 }
      );
    }
  }

  // ── WebSocket ─────────────────────────────────────────────────────────────

  private handleWebSocket(_request: Request): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    try {
      const data = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
      if (data.type === "ping") {
        ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
      }
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
    }
  }

  override webSocketClose(ws: WebSocket, code: number, reason: string): void {
    console.log(`[AgentDO] WebSocket closed code=${code} reason=${reason}`);
    ws.close(code, reason);
  }

  private broadcastWs(event: Record<string, unknown>): void {
    const msg = JSON.stringify(event);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(msg); } catch { /* client disconnected */ }
    }
  }

  // ── Alarm handler: timeout watchdog ─────────────────────────────────────
  override async alarm(): Promise<void> {
    this.ensureInit();

    // Find all running runs that are older than TIMEOUT_QUERY_THRESHOLD_S
    const cutoff = new Date(
      Date.now() - TIMEOUT_QUERY_THRESHOLD_S * 1000
    ).toISOString();

    const rows = this.ctx.storage.sql
      .exec(
        `SELECT id FROM agent_runs WHERE status = ? AND created_at < ?`,
        "running",
        cutoff
      )
      .toArray() as { id: string }[];

    const now = new Date().toISOString();
    for (const row of rows) {
      this.ctx.storage.sql.exec(
        `UPDATE agent_runs SET status = ?, error = ?, updated_at = ? WHERE id = ?`,
        "failed",
        "Agent timeout",
        now,
        row.id
      );
    }
  }

  // ── POST /script/run ────────────────────────────────────────────────────────
  // The authoritative script-first agent model (spec appendix ~6672k). Loads the agent's
  // 4-file config from R2, then runs OBSERVE→FINGERPRINT→FIND→GATE→EXECUTE→VERIFY→DISTILL.

  private buildScriptEngineEnv(spaceId: string, agentId: string, tenantId: string): ScriptEngineEnv | null {
    if (!this.env.SCRIPTS_R2) return null;
    const env: ScriptEngineEnv = {
      scriptsBucket: this.env.SCRIPTS_R2,
      spaceId,
      agentId,
      tenantId,
    };
    if (this.env.SCRIPTS_VECTORIZE) {
      env.vectorIndex = this.env.SCRIPTS_VECTORIZE as unknown as NonNullable<ScriptEngineEnv["vectorIndex"]>;
    }
    if (this.env.AI) env.embedder = new WorkersAIEmbedder(this.env.AI);
    if (this.env.KNOWLEDGE_WORKER) env.knowledgeWorker = this.env.KNOWLEDGE_WORKER;
    if (this.env.SPACES_WORKER) env.spacesWorker = this.env.SPACES_WORKER;
    if (this.env.NOTIFICATIONS_WORKER) env.notificationsWorker = this.env.NOTIFICATIONS_WORKER;
    return env;
  }

  private async handleScriptRun(request: Request): Promise<Response> {
    const body = await request.json<{
      goal: string;
      spaceId: string;
      agentId: string;
      tenantId: string;
      apiKey: string;
      model?: string;
    }>();

    if (!body.goal || !body.spaceId || !body.agentId) {
      return Response.json({ error: "goal, spaceId, and agentId are required" }, { status: 400 });
    }

    const engineEnv = this.buildScriptEngineEnv(body.spaceId, body.agentId, body.tenantId ?? "");
    if (!engineEnv) {
      return Response.json({ error: "script engine unavailable: SCRIPTS_R2 not bound" }, { status: 503 });
    }

    // Load the agent's 4-file config; without it the agent is not provisioned.
    const config = await loadAgentConfig(engineEnv.scriptsBucket, body.spaceId, body.agentId);
    if (!config) {
      return Response.json({ error: `agent '${body.agentId}' is not provisioned in space '${body.spaceId}'` }, { status: 404 });
    }

    const tools = new ScriptToolSurface(engineEnv, config.scripts.prebuilt);
    const reasoner = new GatewayReasoner({
      apiKey: body.apiKey,
      gateway: {
        accountId: this.env.NAELAO_ACCOUNT_ID ?? "placeholder",
        gatewayId: this.env.NAELAO_GATEWAY_ID ?? "naelao-gateway",
      },
      ctx: { spaceId: body.spaceId, agentId: body.agentId, model: body.model ?? "claude-haiku-4-5-20251001" },
      ...(body.model ? { model: body.model } : {}),
    });

    try {
      const result = await runScriptLoop(engineEnv, tools, reasoner, config.scripts.prebuilt, {
        goal: body.goal,
        startupObserve: config.scripts.startup_observe,
      });
      return Response.json(result);
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 500 }
      );
    }
  }

  // ── POST /run ─────────────────────────────────────────────────────────────

  private async handleRun(request: Request): Promise<Response> {
    const body = await request.json<{
      goal: string;
      sessionId: string;
      spaceId: string;
      tenantId: string;
      systemPrompt: string;
      tools: LlmTool[];
      kbContext: string;
      apiKey: string;
      model?: string;
      allowedDomains?: string[];
    }>();

    // Validate goal length
    if (!body.goal || body.goal.length === 0) {
      return Response.json(
        { error_code: "bad_request", message: "goal is required" },
        { status: 400 }
      );
    }
    if (body.goal.length > MAX_GOAL_LENGTH) {
      return Response.json(
        { error_code: "bad_request", message: `goal exceeds ${MAX_GOAL_LENGTH} character limit` },
        { status: 400 }
      );
    }

    // Input moderation (G-C07)
    const modResult = moderateInput(body.goal);
    if (modResult.blocked) {
      return Response.json(
        {
          error_code: "moderation_blocked",
          message: "Goal was blocked by input moderation",
          reason: modResult.reason,
        },
        { status: 422 }
      );
    }

    const runId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Create run record with FSM in IDLE state (G-AZ01)
    this.ctx.storage.sql.exec(
      `INSERT INTO agent_runs (id, session_id, space_id, tenant_id, status, fsm_state, goal, react_steps, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'running', 'IDLE', ?, '[]', ?, ?)`,
      runId,
      body.sessionId,
      body.spaceId,
      body.tenantId,
      body.goal,
      now,
      now
    );

    // Set 30s timeout watchdog alarm (G-D14)
    await this.ctx.storage.setAlarm(Date.now() + TIMEOUT_MS);

    // Run the ReAct loop
    const model = body.model ?? "claude-sonnet-4-6";
    const allowedDomains = body.allowedDomains ?? [];

    const services: ToolServices = {
      knowledgeWorker: this.env.KNOWLEDGE_WORKER,
      spaceId: body.spaceId,
      tenantId: body.tenantId,
    };

    try {
      const finalAnswer = await this.runReActLoop(
        runId,
        body.goal,
        body.systemPrompt,
        body.tools,
        body.kbContext,
        body.apiKey,
        model,
        allowedDomains,
        services
      );

      // Cancel the alarm since we finished
      await this.ctx.storage.deleteAlarm();

      // Mark completed
      const doneNow = new Date().toISOString();
      this.ctx.storage.sql.exec(
        `UPDATE agent_runs SET status = 'completed', final_answer = ?, updated_at = ? WHERE id = ?`,
        finalAnswer,
        doneNow,
        runId
      );

      // Read the completed run to return
      const run = (this.ctx.storage.sql
        .exec(`SELECT * FROM agent_runs WHERE id = ?`, runId)
        .toArray() as unknown as AgentRunRow[])[0];

      if (!run) {
        return Response.json({ error_code: "not_found", message: "Run not found" }, { status: 404 });
      }

      // G-I11: Write conversation turns back to SpaceDO session messages
      await this.writeConversationToSession(
        body.sessionId,
        body.spaceId,
        body.tenantId,
        body.goal,
        finalAnswer
      );

      return Response.json(
        {
          runId,
          status: "completed",
          finalAnswer,
          reactSteps: JSON.parse(run.react_steps as string) as ReactStep[],
        },
        { status: 200 }
      );
    } catch (err) {
      // Cancel alarm
      await this.ctx.storage.deleteAlarm().catch(() => {});

      const errMsg = err instanceof Error ? err.message : String(err);
      const errNow = new Date().toISOString();

      // G-AZ01: Transition to ERROR state on failure
      this.ctx.storage.sql.exec(
        `UPDATE agent_runs SET status = 'failed', fsm_state = 'ERROR', error = ?, updated_at = ? WHERE id = ?`,
        errMsg,
        errNow,
        runId
      );

      console.error("Agent run failed:", err);
      return Response.json(
        { error_code: "agent_error", message: errMsg, runId },
        { status: 500 }
      );
    }
  }

  // ── ReAct loop ────────────────────────────────────────────────────────────

  private async runReActLoop(
    runId: string,
    goal: string,
    systemPrompt: string,
    tools: LlmTool[],
    kbContext: string,
    apiKey: string,
    model: string,
    allowedDomains: string[],
    services: ToolServices
  ): Promise<string> {
    // System prompt + KB context forms the system; goal is first user message
    const messages: LlmMessage[] = [
      { role: "user", content: goal },
    ];

    const reactSteps: ReactStep[] = [];
    // G-X01: Track per-tool call counts to prevent unbounded recursive loops
    const toolCallCounts = new Map<string, number>();
    // G-BB41: Track total tool calls across all iterations of this run
    let totalToolCallsThisRun = 0;
    // G-AZ09: Accumulate cost across all LLM calls in this run
    let totalCostUsd = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheReadTokens = 0;
    // G-BB03: Track context truncation events
    let contextTruncatedCount = 0;

    // G-AZ01: Transition from IDLE to PLANNING at the start of the loop
    this.transitionFsm(runId, "IDLE", "PLANNING");
    let currentFsmState: AgentFsmState = "PLANNING";

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      // Check if current run has been cancelled
      const runRow = (this.ctx.storage.sql
        .exec(`SELECT status, fsm_state FROM agent_runs WHERE id = ?`, runId)
        .toArray() as { status: string; fsm_state: AgentFsmState }[])[0];

      if (!runRow || runRow.status === "cancelled") {
        throw new Error("Agent run was cancelled");
      }
      currentFsmState = runRow.fsm_state;

      // G-N44: Trim context to prevent token overflow; keeps first message + recent history
      const prebudgetMessages = truncateMiddle(messages, MAX_CONTEXT_MESSAGES);

      // G-BB03: Apply priority-based context budget (system 20%, KB 40%, conversation 30%)
      // Build fullSystem for this iteration (KB context may be truncated per budget)
      const rawSystem = kbContext
        ? `${systemPrompt}\n\n<kb_content>\n${kbContext}\n</kb_content>`
        : systemPrompt;
      const budgeted = applyContextBudget(rawSystem, prebudgetMessages, kbContext);
      if (budgeted.truncated) {
        contextTruncatedCount++;
        console.warn(`[ContextBudget] G-BB03 iteration ${iteration} truncated context for run ${runId}`);
      }
      const fullSystem = budgeted.kbContext
        ? `${systemPrompt}\n\n<kb_content>\n${budgeted.kbContext}\n</kb_content>`
        : systemPrompt;
      const contextMessages = budgeted.messages;

      // G-AZ07: Structure system prompt with cache_control on stable prefix block
      // Anthropic caches the first ~2000 tokens of the system prompt for 5 minutes.
      // Splitting into stable prefix (SpaceType config / persona) + dynamic suffix
      // lets us mark the stable part as ephemeral-cacheable to save ~90% cost there.
      const systemBlocks: SystemBlock[] = [
        {
          type: "text",
          text: fullSystem,
          cache_control: { type: "ephemeral" },
        },
      ];

      // Call LLM
      const llmResponse = await callLlm(apiKey, {
        model,
        system: systemBlocks,
        messages: contextMessages,
        ...(tools.length > 0 ? { tools } : {}),
        max_tokens: 4096,
        temperature: 0,
      });

      // G-AZ09: Track per-call costs for unit economics model
      const usage = (llmResponse as { usage?: Record<string, number> }).usage ?? {};
      const callCostUsd = computeLlmCostUsd(usage);
      totalCostUsd += callCostUsd;
      totalInputTokens += usage["input_tokens"] ?? 0;
      totalOutputTokens += usage["output_tokens"] ?? 0;
      totalCacheReadTokens += usage["cache_read_input_tokens"] ?? 0;

      const step: ReactStep = {
        iteration,
        timestamp: new Date().toISOString(),
      };

      // Extract text thought from response
      const textBlock = llmResponse.content.find((b) => b.type === "text");
      if (textBlock?.text) {
        step.thought = textBlock.text;
      }

      // G-C08: Output moderation — check for system prompt leakage
      const outputText = llmResponse.content
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("\n");
      const systemFirstLine = fullSystem.split("\n")[0] ?? "";
      const outMod = moderateOutput(outputText, systemFirstLine);
      if (outMod.flagged) {
        console.warn(`[agent] Output moderation flagged: ${outMod.reason}`);
      }

      // Check if this is a final answer (no tool use)
      if (llmResponse.stop_reason === "end_turn") {
        // G-AZ01: PLANNING → SUMMARIZING → DONE
        this.transitionFsm(runId, currentFsmState, "SUMMARIZING");
        currentFsmState = "SUMMARIZING";
        const answerText = outputText.trim();

        // G-AB19: Post-generation content moderation — scan for policy violations
        // (CSAM text, extreme violence, targeted harassment, CBRN content)
        const contentMod = moderateText(answerText);
        if (!contentMod.allowed) {
          const flagTypes = contentMod.flags.map((f) => f.type).join(", ");
          console.error(`[agent] Output blocked by content policy: ${flagTypes}`);
          step.finalAnswer = "I'm unable to provide that response as it was flagged by content policy.";
          reactSteps.push(step);
          this.persistReactSteps(runId, reactSteps);
          return step.finalAnswer;
        }

        step.finalAnswer = answerText;
        reactSteps.push(step);

        // Persist steps
        this.persistReactSteps(runId, reactSteps);

        // G-AZ09: Emit unit economics event to Analytics Engine
        if (this.env.ANALYTICS) {
          try {
            this.env.ANALYTICS.writeDataPoint({
              blobs: [
                "agent.run.completed",       // b1: event_type
                services.tenantId,           // b2: tenant_id
                services.spaceId,            // b3: space_id
                "", "", "", "agents", "", "", // b4-b10
                JSON.stringify({
                  run_id: runId,
                  iterations: iteration + 1,
                  context_truncated: contextTruncatedCount > 0,
                  context_truncation_count: contextTruncatedCount,
                }),
                "", "", "", "", "", "", "", "", "",
              ],
              doubles: [
                0,                                         // d1: duration_ms (not tracked here)
                totalInputTokens + totalOutputTokens,      // d2: total token_count
                Math.round(totalCostUsd * 1_000_000),      // d3: cost_usd_micro
                totalOutputTokens,                         // d4: output token count
                totalInputTokens,                          // d5: input token count
                totalCacheReadTokens,                      // d6: cache read tokens
                0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              ],
              indexes: [services.tenantId],
            });
          } catch {
            // Analytics Engine is append-only best-effort — never block on failure
          }
        }

        console.log(
          `[AZ09] Run ${runId} cost: $${totalCostUsd.toFixed(6)} ` +
          `(in=${totalInputTokens} out=${totalOutputTokens} cacheRead=${totalCacheReadTokens})`
        );

        // G-AZ01: SUMMARIZING → DONE
        this.transitionFsm(runId, "SUMMARIZING", "DONE");
        return answerText;
      }

      // Handle tool use
      if (llmResponse.stop_reason === "tool_use") {
        // G-AZ01: PLANNING → TOOL_CALL
        this.transitionFsm(runId, currentFsmState, "TOOL_CALL");
        currentFsmState = "TOOL_CALL";
        const toolUseBlocks = llmResponse.content.filter(
          (b) => b.type === "tool_use"
        );

        // Append assistant message with all content
        messages.push({
          role: "assistant",
          content: llmResponse.content,
        });

        // G-AZ01: TOOL_CALL → AWAITING_TOOL while executing
        this.transitionFsm(runId, "TOOL_CALL", "AWAITING_TOOL");
        currentFsmState = "AWAITING_TOOL";

        // G-AZ08: Parallel tool dispatch — all independent tool calls run concurrently
        // Pre-filter valid blocks and apply limits synchronously before parallel dispatch
        const toolResults: ContentBlock[] = [];
        let toolCallsThisTurn = 0;

        // G-AY01: Build a fast-lookup map of require_approval per tool name
        const approvalRequiredTools = new Set(
          tools.filter((t) => t.require_approval).map((t) => t.name)
        );

        // Partition: pre-check limits and policy before dispatching in parallel
        const dispatchQueue: Array<{ block: ContentBlock; skip?: ContentBlock }> = [];
        for (const toolBlock of toolUseBlocks) {
          if (!toolBlock.id || !toolBlock.name || !toolBlock.input) continue;

          // G-AY01: HITL — if tool requires approval, pause and create approval request
          if (approvalRequiredTools.has(toolBlock.name) && this.env.HITL_APPROVAL_DO) {
            const hitlDoId = this.env.HITL_APPROVAL_DO.idFromName(`hitl:${services.spaceId}`);
            const hitlStub = this.env.HITL_APPROVAL_DO.get(hitlDoId);
            const approvalResp = await hitlStub.fetch("http://do/requests", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                run_id: runId,
                session_id: services.spaceId,
                tool_name: toolBlock.name,
                tool_input: toolBlock.input,
                action_description: `Tool '${toolBlock.name}' requested approval for run ${runId}`,
              }),
            });
            const approvalData = await approvalResp.json<{ approval_id: string; expires_at: string }>();
            this.transitionFsm(runId, currentFsmState, "AWAITING_HUMAN");
            currentFsmState = "AWAITING_HUMAN";
            toolResults.push({
              type: "tool_result",
              tool_use_id: toolBlock.id,
              content: `[AWAITING_HUMAN_APPROVAL] Approval requested (id: ${approvalData.approval_id}). The builder must approve or reject this action within 30 seconds. Please inform the user that this action requires human approval.`,
            });
            continue;
          }

          // G-AB20: policy check
          const policy = beforeToolCall(toolBlock.name, toolBlock.input);
          if (!policy.allow) {
            toolResults.push({ type: "tool_result", tool_use_id: toolBlock.id,
              content: `Error: Tool call blocked by policy: ${policy.reason ?? "not allowed"}` });
            continue;
          }
          // G-X01: per-tool call count
          const callsSoFar = toolCallCounts.get(toolBlock.name) ?? 0;
          if (callsSoFar >= MAX_CALLS_PER_TOOL) {
            toolResults.push({ type: "tool_result", tool_use_id: toolBlock.id,
              content: `Error: Tool '${toolBlock.name}' call limit (${MAX_CALLS_PER_TOOL}) reached.` });
            continue;
          }
          // G-BB41: per-turn and per-run caps
          if (toolCallsThisTurn >= MAX_TOOL_CALLS_PER_TURN || totalToolCallsThisRun >= MAX_TOOL_CALLS_PER_RUN) {
            toolResults.push({ type: "tool_result", tool_use_id: toolBlock.id,
              content: `Error: Tool call limit reached for this ${toolCallsThisTurn >= MAX_TOOL_CALLS_PER_TURN ? "turn" : "run"}.` });
            continue;
          }

          toolCallCounts.set(toolBlock.name, callsSoFar + 1);
          toolCallsThisTurn++;
          totalToolCallsThisRun++;
          console.log(`[agent][audit] tool_call run=${runId} iteration=${iteration} tool=${toolBlock.name} total_this_run=${totalToolCallsThisRun}`);
          dispatchQueue.push({ block: toolBlock });
        }

        // G-AZ08: Dispatch all queued tool calls in parallel (max 5 concurrent per spec)
        const MAX_PARALLEL_TOOLS = 5;
        const parallelResults = await Promise.all(
          dispatchQueue.slice(0, MAX_PARALLEL_TOOLS).map(async ({ block }) => {
            const result = await dispatchTool(block.name!, block.input!, allowedDomains, services);
            let observation = result.error ? `Error: ${result.error}` : result.output;
            const obsBytes = new TextEncoder().encode(observation).length;
            if (obsBytes > MAX_TOOL_OUTPUT_BYTES) {
              observation = observation.slice(0, MAX_TOOL_OUTPUT_BYTES) +
                `\n[TRUNCATED: output exceeded ${MAX_TOOL_OUTPUT_BYTES} bytes]`;
            }
            step.action = { toolName: block.name!, toolInput: block.input!, toolUseId: block.id! };
            step.observation = observation;
            return { type: "tool_result" as const, tool_use_id: block.id!, content: observation };
          })
        );
        toolResults.push(...parallelResults);

        reactSteps.push(step);
        this.persistReactSteps(runId, reactSteps);

        // Append tool results as a user message
        messages.push({
          role: "user",
          content: toolResults,
        });

        // G-AZ01: AWAITING_TOOL → PLANNING for next iteration
        this.transitionFsm(runId, "AWAITING_TOOL", "PLANNING");
        currentFsmState = "PLANNING";
        continue;
      }

      // max_tokens or stop_sequence — treat as final
      const partialAnswer = llmResponse.content
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("\n")
        .trim();

      step.finalAnswer = partialAnswer || "(no response)";
      reactSteps.push(step);
      this.persistReactSteps(runId, reactSteps);

      return step.finalAnswer;
    }

    // Exceeded max iterations
    const maxIterAnswer = "I was unable to complete the task within the allowed number of steps. Please try rephrasing your goal.";
    const lastStep: ReactStep = {
      iteration: MAX_ITERATIONS,
      thought: "Maximum iterations exceeded",
      finalAnswer: maxIterAnswer,
      timestamp: new Date().toISOString(),
    };
    reactSteps.push(lastStep);
    this.persistReactSteps(runId, reactSteps);

    return maxIterAnswer;
  }

  // G-I11: Write user goal and agent answer back to SpaceDO session messages
  private async writeConversationToSession(
    sessionId: string,
    spaceId: string,
    tenantId: string,
    goal: string,
    finalAnswer: string
  ): Promise<void> {
    const baseUrl = `http://spaces-worker/spaces/${spaceId}/sessions/${sessionId}/messages`;
    const headers = {
      "content-type": "application/json",
      "x-naelao-tenant-id": tenantId,
    };

    try {
      await this.env.SPACES_WORKER.fetch(new Request(baseUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ role: "user", content: goal }),
      }));

      await this.env.SPACES_WORKER.fetch(new Request(baseUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ role: "assistant", content: finalAnswer }),
      }));
    } catch {
      // Best-effort — do not fail the run if write-back fails
    }
  }

  private persistReactSteps(runId: string, steps: ReactStep[]): void {
    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `UPDATE agent_runs SET react_steps = ?, updated_at = ? WHERE id = ?`,
      JSON.stringify(steps),
      now,
      runId
    );
  }

  // G-AZ01: Transition FSM state — validates allowed transitions, persists to SQLite
  private transitionFsm(runId: string, from: AgentFsmState, to: AgentFsmState): void {
    if (!isFsmTransitionValid(from, to)) {
      console.warn(`[agent] Invalid FSM transition ${from} → ${to} for run ${runId}`);
    }
    this.ctx.storage.sql.exec(
      `UPDATE agent_runs SET fsm_state = ?, updated_at = ? WHERE id = ?`,
      to,
      new Date().toISOString(),
      runId
    );
  }

  // ── GET /runs/:runId ──────────────────────────────────────────────────────

  private handleGetRun(runId: string): Response {
    const run = (this.ctx.storage.sql
      .exec(`SELECT * FROM agent_runs WHERE id = ?`, runId)
      .toArray() as unknown as AgentRunRow[])[0];

    if (!run) {
      return Response.json(
        { error_code: "not_found", message: "Run not found" },
        { status: 404 }
      );
    }

    return Response.json({
      id: run.id,
      sessionId: run.session_id,
      spaceId: run.space_id,
      tenantId: run.tenant_id,
      status: run.status,
      fsmState: run.fsm_state,
      goal: run.goal,
      reactSteps: JSON.parse(run.react_steps as string) as ReactStep[],
      finalAnswer: run.final_answer,
      error: run.error,
      createdAt: run.created_at,
      updatedAt: run.updated_at,
    });
  }

  // ── POST /cancel (global — cancel all active runs) ───────────────────────

  private handleCancelAll(): Response {
    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `UPDATE agent_runs SET status = 'cancelled', error = 'Cancelled', updated_at = ? WHERE status = 'running'`,
      now
    );
    this.broadcastWs({ type: "run_cancelled", ts: Date.now() });
    return Response.json({ status: "ok", cancelled_at: now });
  }

  // ── GET /status ───────────────────────────────────────────────────────────

  private handleStatus(): Response {
    const fibers = this.ctx.storage.sql
      .exec(`SELECT id, name, status, created_at FROM fibers ORDER BY created_at DESC LIMIT 20`)
      .toArray() as { id: string; name: string; status: string; created_at: number }[];

    const walPending = (this.ctx.storage.sql
      .exec(`SELECT COUNT(*) as cnt FROM run_wal WHERE status = 'pending'`)
      .toArray() as { cnt: number }[])[0]?.cnt ?? 0;

    const activeRuns = (this.ctx.storage.sql
      .exec(`SELECT COUNT(*) as cnt FROM agent_runs WHERE status = 'running'`)
      .toArray() as { cnt: number }[])[0]?.cnt ?? 0;

    const bufferSize = (this.ctx.storage.sql
      .exec(`SELECT COUNT(*) as cnt FROM token_buffer`)
      .toArray() as { cnt: number }[])[0]?.cnt ?? 0;

    return Response.json({ fibers, wal_pending: walPending, active_runs: activeRuns, buffer_size: bufferSize, ts: Date.now() });
  }

  // ── GET /fiber-status?runId= ──────────────────────────────────────────────

  private handleFiberStatus(runId: string): Response {
    if (!runId) return Response.json({ error: "runId required" }, { status: 400 });
    const fiber = (this.ctx.storage.sql
      .exec(`SELECT * FROM fibers WHERE id = ?`, runId)
      .toArray() as { id: string; name: string; status: string; snapshot: string | null; created_at: number; updated_at: number }[])[0];
    if (!fiber) return Response.json({ error: "not_found" }, { status: 404 });
    return Response.json(fiber);
  }

  // ── GET /replay?runId=&after= ─────────────────────────────────────────────

  private handleReplay(runId: string, afterId: number): Response {
    if (!runId) return Response.json({ error: "runId required" }, { status: 400 });
    const tokens = this.ctx.storage.sql
      .exec(`SELECT id, delta, created_at FROM token_buffer WHERE run_id = ? AND id > ? ORDER BY id LIMIT 1000`, runId, afterId)
      .toArray() as { id: number; delta: string; created_at: number }[];
    return Response.json({ tokens, count: tokens.length });
  }

  // ── POST /approval/:approvalId/decide ────────────────────────────────────

  private async handleApprovalDecide(approvalId: string, request: Request): Promise<Response> {
    const body = await request.json<{ approved: boolean; reason?: string }>().catch(() => ({ approved: false }));
    if (this.env.HITL_APPROVAL_DO) {
      const doId = this.env.HITL_APPROVAL_DO.idFromName(`hitl:${approvalId}`);
      const stub = this.env.HITL_APPROVAL_DO.get(doId);
      await stub.fetch(`http://do/requests/${approvalId}/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).catch(() => {});
    }
    this.broadcastWs({ type: "approval_decided", approval_id: approvalId, approved: body.approved, ts: Date.now() });
    return Response.json({ approval_id: approvalId, approved: body.approved });
  }

  // ── GET /memory ───────────────────────────────────────────────────────────

  private handleGetMemory(category: string | null): Response {
    const rows = category
      ? this.ctx.storage.sql.exec(`SELECT * FROM agent_memory WHERE category = ? ORDER BY updated_at DESC`, category)
          .toArray() as { key: string; category: string; value: string; confidence: number }[]
      : this.ctx.storage.sql.exec(`SELECT * FROM agent_memory ORDER BY category, updated_at DESC`)
          .toArray() as { key: string; category: string; value: string; confidence: number }[];
    const entries = rows.map(r => ({ ...r, value: (() => { try { return JSON.parse(r.value); } catch { return r.value; } })() }));
    return Response.json({ entries, count: entries.length });
  }

  // ── POST /memory ──────────────────────────────────────────────────────────

  private async handlePostMemory(request: Request): Promise<Response> {
    const body = await request.json<{ key: string; category: string; value: unknown; confidence?: number }>();
    if (!body.key || !body.category || body.value === undefined) {
      return Response.json({ error: "key, category, value required" }, { status: 400 });
    }
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO agent_memory (key, category, value, confidence, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(key, category) DO UPDATE SET value = excluded.value, confidence = excluded.confidence, updated_at = excluded.updated_at`,
      body.key, body.category, JSON.stringify(body.value), body.confidence ?? 1.0, now, now
    );
    return Response.json({ key: body.key, category: body.category, saved: true });
  }

  // ── GET /session/:sessionId/search?q= ────────────────────────────────────

  private handleSessionSearch(sessionId: string, query: string): Response {
    if (!query) return Response.json({ results: [] });
    try {
      const rows = this.ctx.storage.sql
        .exec(
          `SELECT m.id, m.role, m.content, m.created_at FROM messages_fts f
           JOIN messages m ON m.rowid = f.rowid
           WHERE messages_fts MATCH ? AND f.session_id = ?
           ORDER BY rank LIMIT 20`,
          query, sessionId
        )
        .toArray() as { id: string; role: string; content: string; created_at: number }[];
      return Response.json({ results: rows, count: rows.length });
    } catch {
      // FTS5 not available — fallback to LIKE
      const rows = this.ctx.storage.sql
        .exec(
          `SELECT id, role, content, created_at FROM messages
           WHERE session_id = ? AND content LIKE ? ORDER BY created_at DESC LIMIT 20`,
          sessionId, `%${query}%`
        )
        .toArray() as { id: string; role: string; content: string; created_at: number }[];
      return Response.json({ results: rows, count: rows.length });
    }
  }

  // ── POST /runs/:runId/cancel ──────────────────────────────────────────────

  private handleCancelRun(runId: string): Response {
    const run = (this.ctx.storage.sql
      .exec(`SELECT id, status FROM agent_runs WHERE id = ?`, runId)
      .toArray() as { id: string; status: string }[])[0];

    if (!run) {
      return Response.json(
        { error_code: "not_found", message: "Run not found" },
        { status: 404 }
      );
    }

    if (run.status !== "running") {
      return Response.json(
        {
          error_code: "bad_request",
          message: `Run is in '${run.status}' state, can only cancel 'running' runs`,
        },
        { status: 400 }
      );
    }

    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `UPDATE agent_runs SET status = 'cancelled', error = 'Cancelled by user', updated_at = ? WHERE id = ?`,
      now,
      runId
    );

    return Response.json({ id: runId, status: "cancelled", updatedAt: now });
  }
}
