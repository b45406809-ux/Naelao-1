// ── NaelaoAgentDO — ReAct Agent Durable Object ───────────────────────────────
// Fulfills G-D01 through G-D20: Agent runtime with ReAct loop, tool dispatch,
// timeout watchdog, and SQLite-persisted run state.
//
// CRITICAL DO rules:
//   - this.ctx.storage.sql.exec(query, ...params) with ? placeholders ONLY
//   - All state persisted to SQLite (hibernation kills in-memory)
//   - Alarm used for 30s timeout watchdog

import { DurableObject } from "cloudflare:workers";
import { mintInternalToken, broadcastSpaceEvent } from "@naelao/http";
import type { LlmTool, LlmMessage, ContentBlock } from "@naelao/llm-gateway";
import { callLlm, moderateInput, moderateOutput } from "@naelao/llm-gateway";
import type { SystemBlock } from "@naelao/llm-gateway";
import { moderateText } from "@naelao/moderation";
import { tokensToCredits } from "@naelao/billing-core";
import {
  ScriptToolSurface,
  runScriptLoop,
  parseRequiresApprovalFor,
  loadAgentConfig,
  type ScriptEngineEnv,
  type ExecutionTier,
} from "../script-engine/index.js";
import { GatewayReasoner, WorkersAIEmbedder } from "../script-engine/reasoner.js";
import { buildCodeRunner, type WorkerLoaderBinding } from "../script-engine/code-runner.js";
import { initMemorySchema, buildMemoryStore, runMemoryMaintenance } from "../script-engine/memory-os.js";
import { buildProjectMemoryStore, buildHybridMemoryStore } from "../script-engine/project-memory-client.js";
import { isChannelType, getAdapter, type NormalizedInbound } from "../launchpad/channels.js";
import {
  sanitizeSubAgentOutput,
  safeJsonParse,
  budgetToMaxSteps,
  MAX_SUB_AGENTS_PER_SPAWN,
  DEFAULT_SUB_AGENT_BUDGET_TOKENS,
  MAX_CONCURRENT_SUB_AGENT_TREES,
} from "../script-engine/sub-agent-output.js";

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

// A customer-bot project's no-code "after the customer says X, this happens" rule
// (SpaceDO's project_rules table, fetched over SPACES_WORKER).
interface ProjectRule {
  id: string;
  trigger_pattern: string;
  action: "reply" | "run_script" | "human_takeover";
  reply_text: string | null;
  script_name: string | null;
  enabled: number;
  priority: number;
}

// F17 / A1.13: fetchProjectConfig's result, distinguishing a clean 404 ("no project config row
// — permissive by design") from a genuine fetch/5xx/network error ("we could not verify the
// project's restrictions"). Collapsing both into `null` (the previous behavior) meant a
// transient SpaceDO error silently disabled BOTH structural customer-bot controls (execution
// ceiling and daily spend cap), which A1.13 requires to be un-bypassable. Callers must fail
// CLOSED on "error" (clamp to the most restrictive tier, treat as spend-capped) and only stay
// permissive on "not_found".
type ProjectConfigResult =
  | { status: "found"; execution_ceiling: number; daily_spend_cap_credits: number }
  | { status: "not_found" }
  | { status: "error" };

// S0.4: same fail-closed discipline as ProjectConfigResult — fetchProjectRules used to collapse
// "found, zero rules configured" and "SpaceDO error, rules unknown" into the same `[]`, so a
// rules-endpoint-only outage (config still loads fine) silently disabled the STOP/UNSUBSCRIBE/
// human-takeover baseline every no-code project template seeds (A1.13) — the loop would just
// reply to a customer who texted "STOP". Callers must fail CLOSED (escalate, never run
// unrestricted) on "error", and only treat an empty list as "no rules configured" on "found".
type ProjectRulesResult =
  | { status: "found"; rules: ProjectRule[] }
  | { status: "error" };

// ── Tool services (injected from DO env) ─────────────────────────────────────

interface ToolServices {
  knowledgeWorker: Fetcher;
  spaceId: string;
  tenantId: string;
  /** For minting the internal HMAC token this direct (non-router) service-binding call needs. */
  platformSecret: string;
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
            headers: {
              "x-naelao-tenant-id": services.tenantId,
              "x-naelao-internal-token": await mintInternalToken(services.platformSecret, services.tenantId),
            },
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
  /** §A1.17 Phase V — naelao-ws-gateway, for live-syncing approval.requested to any connected
   *  dashboard/shell client. Optional: broadcastSpaceEvent degrades to a silent no-op when unbound. */
  WS_GATEWAY?: Fetcher;
  // ── Script-first engine bindings (authoritative agent model; spec appendix ~6672k) ──
  /** R2 bucket holding the skill library + agent config + workspace. */
  SCRIPTS_R2?: R2Bucket;
  /** Vectorize index for script.find (optional — engine degrades to text scan). */
  SCRIPTS_VECTORIZE?: VectorizeIndex;
  /** Workers AI — embeddings for script.find and free-tier reasoning. */
  AI?: Ai;
  /** Notifications worker — owner/customer notifications + HITL surface. */
  NOTIFICATIONS_WORKER?: Fetcher;
  /** Billing worker — holds Lemon Squeezy creds; the only money-in path (commerce script). */
  BILLING_WORKER?: Fetcher;
  /** MCP hub worker — external-platform connector registry + tool proxy (mcp-connector). */
  MCP_HUB?: Fetcher;
  /** AI Gateway identity (spec §15). */
  NAELAO_ACCOUNT_ID?: string;
  NAELAO_GATEWAY_ID?: string;
  // ── Execution ladder Tiers 2-5 (spec bottom appendix §8 / code-runner.ts) ──
  /** CF Worker Loader (beta) — backs Tiers 2-4 (V8 isolate, npm-best-effort, browser). */
  LOADER?: WorkerLoaderBinding;
  /** naelao-browser service binding — Tier 4 (CF Browser Rendering proxy). */
  BROWSER_WORKER?: Fetcher;
  /** ToolSandboxDO namespace — Tier 5 (CF Container, full Linux). */
  TOOL_SANDBOX?: DurableObjectNamespace;
  /** §A1.17 Phase M — local-machine-as-container. One DO per (spaceId, userId); the
   *  `local-machine` prebuilt reports itself unavailable when absent. */
  LOCAL_TUNNEL?: DurableObjectNamespace;
  /** Vectorize index for the Memory OS semantic layer (episodic→semantic promotion). */
  MEMORY_VECTORIZE?: VectorizeIndex;
  /** Self-binding — lets a running agent spawn sibling/child NaelaoAgentDO instances as
   *  sub-agents (script-engine/prebuilt/sub-agent.ts's agent.spawn/receive/terminate ops). */
  NAELAO_AGENT_DO?: DurableObjectNamespace<NaelaoAgentDO>;
  /** Account-level concurrency ceiling (spec §28 ConcurrencyDO) — caps how many sub-agent
   *  spawn trees can be running at once per space, on top of the existing per-spawn 16 cap. */
  CONCURRENCY_DO?: DurableObjectNamespace;
  /** §A1.17 Phase J — durable dispatch for runtime:"workflow" scripts (ScriptRunWorkflow). */
  AGENT_SCRIPT_WORKFLOW?: {
    create(opts: { id?: string; params?: unknown }): Promise<{ id: string; status(): Promise<{ status: string; output?: unknown; error?: unknown }> }>;
    get(id: string): Promise<{ id: string; status(): Promise<{ status: string; output?: unknown; error?: unknown }> }>;
  };
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

    // Memory OS — Layer 3 (structured facts) + the episodic feeder for Layer 5 (semantic).
    initMemorySchema(this.ctx.storage.sql);

    // Multi-channel gateway (spec @4211129/@3190360/@3245389) — per-(channel,channel_user_id)
    // sessions so two Slack/Discord/email users on the same space never bleed into one thread.
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS channel_sessions (
        id              TEXT PRIMARY KEY,
        channel         TEXT NOT NULL,
        channel_user_id TEXT NOT NULL,
        project_id      TEXT, -- customer-bot project this channel is bound to (NULL = space default agent)
        human_takeover  INTEGER NOT NULL DEFAULT 0, -- admin/rule silenced the bot for this thread
        created_at      INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
        last_seen       INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
      )
    `);
    this.ctx.storage.sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_session_user ON channel_sessions(channel, channel_user_id)`);
    this.ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS idx_channel_session_project ON channel_sessions(project_id) WHERE project_id IS NOT NULL`);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS channel_messages (
        id          TEXT PRIMARY KEY,
        session_id  TEXT NOT NULL REFERENCES channel_sessions(id),
        direction   TEXT NOT NULL, -- 'inbound' | 'outbound'
        text        TEXT NOT NULL,
        external_id TEXT,
        answered    INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
      )
    `);
    this.ctx.storage.sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_msg_dedupe ON channel_messages(session_id, direction, external_id)`);
    this.ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS idx_channel_msg_unanswered ON channel_messages(direction, answered, created_at)`);

    // Per-project daily spend tracking (customer-bot spend caps — G-3664680-style plan
    // gating, applied here at the project level). "Credits" is a coarse tokens_used proxy,
    // not a real billing conversion (that lives in the billing worker) — documented as such.
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS project_spend (
        project_id TEXT NOT NULL,
        day        TEXT NOT NULL, -- YYYY-MM-DD (UTC)
        credits    INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (project_id, day)
      )
    `);

    // Sub-agents (spec §12.1 / Pattern 3 "Sub-Agent Coordination") — fan-out tracking +
    // parent-liveness so a spawned child's result is never orphaned (fixes "Sub-agents have
    // no parent-liveness link" — spawning is synchronous/awaited from the parent's own
    // request, so there is no window where the parent can disappear out from under a child).
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS sub_agents (
        id            TEXT PRIMARY KEY,
        parent_run_id TEXT NOT NULL,
        goal          TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'running', -- running|done|failed|terminated
        budget_tokens INTEGER NOT NULL DEFAULT 20000,
        tokens_used   INTEGER NOT NULL DEFAULT 0,
        result        TEXT,
        error         TEXT,
        created_at    INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
        updated_at    INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
      )
    `);
    this.ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS idx_sub_agents_parent ON sub_agents(parent_run_id)`);
    // Incremental progress (spec: a parent shouldn't have to wait for a whole child run to
    // finish to see it's alive). Written by the CHILD via a cross-DO callback while `status`
    // is still 'running' — pollable by an admin/dashboard via GET /sub-agents?parent_run_id=
    // WHILE the parent's own spawning request is still in flight (DOs serve concurrent fetch()
    // calls), without needing a WebSocket/SSE channel.
    try { this.ctx.storage.sql.exec(`ALTER TABLE sub_agents ADD COLUMN progress_note TEXT`); } catch { /* exists */ }

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

      // POST /memory/maintenance { spaceId } — decay structured facts, promote episodic →
      // semantic, prune the unbounded log. Called from the assistant heartbeat / a daily
      // cron, not inline with a request (spec gaps: decay never applied, no promotion trigger).
      if (method === "POST" && url.pathname === "/memory/maintenance") {
        return this.handleMemoryMaintenance(request);
      }

      // Multi-channel gateway — already signature-verified by the worker boundary
      // (POST /v1/channels/:channel/inbound/:spaceId in index.ts) before reaching here.
      const channelInboundMatch = url.pathname.match(/^\/channels\/([^/]+)\/inbound$/);
      if (method === "POST" && channelInboundMatch?.[1]) {
        return this.handleChannelInbound(channelInboundMatch[1], request);
      }
      if (method === "GET" && url.pathname === "/channels/sessions") {
        return this.handleListChannelSessions();
      }
      if (method === "GET" && url.pathname === "/channels/unanswered") {
        return this.handleChannelUnanswered();
      }
      if (method === "POST" && url.pathname === "/channels/heartbeat") {
        return this.handleChannelHeartbeat(request);
      }

      // POST /channels/sessions/:sessionId/resume — admin hands a human-takeover thread
      // back to the bot. Also usable proactively (admin decides to take over a thread
      // themselves) by setting human_takeover=1 directly — exposed here as the inverse.
      const resumeMatch = url.pathname.match(/^\/channels\/sessions\/([^/]+)\/resume$/);
      if (method === "POST" && resumeMatch?.[1]) {
        this.ctx.storage.sql.exec(`UPDATE channel_sessions SET human_takeover = 0 WHERE id = ?`, resumeMatch[1]);
        return Response.json({ resumed: true });
      }
      const takeoverMatch = url.pathname.match(/^\/channels\/sessions\/([^/]+)\/takeover$/);
      if (method === "POST" && takeoverMatch?.[1]) {
        this.ctx.storage.sql.exec(`UPDATE channel_sessions SET human_takeover = 1 WHERE id = ?`, takeoverMatch[1]);
        return Response.json({ human_takeover: true });
      }

      // POST /sub-agents/:id/progress — cross-DO callback a child uses to report incremental
      // progress back to its parent (spec: sub-agent progress streaming). GET lists a parent
      // run's children with their live status/progress_note — the poll-based "stream".
      const subAgentProgressMatch = url.pathname.match(/^\/sub-agents\/([^/]+)\/progress$/);
      if (method === "POST" && subAgentProgressMatch?.[1]) {
        const body = await request.json<{ note?: string }>().catch(() => ({}) as { note?: string });
        return this.handleSubAgentProgress(subAgentProgressMatch[1], body.note ?? "");
      }
      if (method === "GET" && url.pathname === "/sub-agents") {
        return this.handleListSubAgents(url.searchParams.get("parent_run_id") ?? "");
      }

      // POST /triggers/fire — @naelao/events dispatch target (called via the agents worker's
      // internal /internal/triggers/fire route, which resolves this DO). Runs the named
      // script directly — no reasoning loop, no LLM call.
      if (method === "POST" && url.pathname === "/triggers/fire") {
        return this.handleTriggerFire(request);
      }

      // POST /approvals/create-external — §A1.17 Phase O: naelao-router's agent-key HTTP gate
      // (a Bearer nak_... agent calling the platform API directly, not through the reasoning
      // loop) opens a HITL approval the exact same way the in-loop hitlGateway does, including
      // the notify-the-owner side effect — see notifyApprovalRequested.
      if (method === "POST" && url.pathname === "/approvals/create-external") {
        return this.handleCreateExternalApproval(request);
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

  private buildScriptEngineEnv(spaceId: string, agentId: string, tenantId: string, userId?: string, projectId?: string): ScriptEngineEnv | null {
    if (!this.env.SCRIPTS_R2) return null;
    const env: ScriptEngineEnv = {
      scriptsBucket: this.env.SCRIPTS_R2,
      spaceId,
      agentId,
      tenantId,
      platformSecret: this.env.PLATFORM_SECRET,
      ...(userId ? { userId } : {}),
      // Project-scoped workspace (every thread's agent in a project shares one R2 filesystem)
      // vs. the Space Assistant's space-wide workspace — see workspacePrefix() in types.ts.
      ...(projectId ? { projectId } : {}),
    };
    if (this.env.SCRIPTS_VECTORIZE) {
      env.vectorIndex = this.env.SCRIPTS_VECTORIZE as unknown as NonNullable<ScriptEngineEnv["vectorIndex"]>;
    }
    if (this.env.AI) env.embedder = new WorkersAIEmbedder(this.env.AI);
    {
      // Memory OS — backed by this DO's own SQLite + (optionally) MEMORY_VECTORIZE for the
      // semantic layer. Always available (Layer 3 works with no Vectorize binding at all).
      const memoryEmbedder = this.env.AI ? new WorkersAIEmbedder(this.env.AI) : undefined;
      const localMemoryStore = buildMemoryStore({
        sql: this.ctx.storage.sql,
        spaceId,
        ...(this.env.MEMORY_VECTORIZE
          ? { vectorIndex: this.env.MEMORY_VECTORIZE as unknown as NonNullable<ScriptEngineEnv["vectorIndex"]> }
          : {}),
        ...(memoryEmbedder ? { embedder: memoryEmbedder } : {}),
      });
      // §A1.17 Phase U: a project-bound run (this DO instance addressed per (thread, agentId) —
      // see T2) composes the local store with SpaceDO's project-scoped Layers 3/4/6, so agents
      // sharing a project share facts/fabric/wiki even though each has its own local
      // episodic/semantic memory. The Space Assistant's own `_assistant` slot (no projectId)
      // keeps using localMemoryStore directly, unwrapped — unaffected by this migration.
      env.memoryStore = (projectId && this.env.SPACES_WORKER)
        ? buildHybridMemoryStore(localMemoryStore, buildProjectMemoryStore({
            spacesWorker: this.env.SPACES_WORKER,
            platformSecret: this.env.PLATFORM_SECRET,
            spaceId,
            tenantId,
            projectId,
            mintInternalToken,
          }))
        : localMemoryStore;
    }
    if (this.env.KNOWLEDGE_WORKER) env.knowledgeWorker = this.env.KNOWLEDGE_WORKER;
    if (this.env.SPACES_WORKER) env.spacesWorker = this.env.SPACES_WORKER;
    if (this.env.NOTIFICATIONS_WORKER) env.notificationsWorker = this.env.NOTIFICATIONS_WORKER;
    if (this.env.BILLING_WORKER) env.billingWorker = this.env.BILLING_WORKER;
    if (this.env.MCP_HUB) env.mcpHubWorker = this.env.MCP_HUB;

    // Execution ladder Tiers 2-5 (code-runner.ts) — degrades tier-by-tier when a binding
    // (LOADER / BROWSER_WORKER / TOOL_SANDBOX) is absent; Tier 1 (R2) never needs this.
    env.codeRunner = buildCodeRunner({
      ...(this.env.LOADER ? { loader: this.env.LOADER } : {}),
      ...(this.env.BROWSER_WORKER ? { browserWorker: this.env.BROWSER_WORKER } : {}),
      ...(this.env.MCP_HUB ? { mcpHubWorker: this.env.MCP_HUB } : {}),
      ...(this.env.PLATFORM_SECRET ? { platformSecret: this.env.PLATFORM_SECRET } : {}),
      ...(this.env.TOOL_SANDBOX ? { toolSandbox: this.env.TOOL_SANDBOX } : {}),
    });

    // §A1.17 Phase R: the container half of the explicit multi-workspace model — same
    // per-project addressing as code-runner.ts's runContainer (a project's threads share one
    // container, so workspace.copy and code.execute_* operate on the SAME /workspace).
    if (this.env.TOOL_SANDBOX) {
      const toolSandbox = this.env.TOOL_SANDBOX;
      const sandboxStub = () => toolSandbox.get(toolSandbox.idFromName(`sandbox:${spaceId}:${projectId ?? "_assistant"}`));
      env.containerWorkspace = {
        list: async () => {
          const resp = await sandboxStub().fetch(new Request("http://sandbox/workspace/list", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
          return resp.json();
        },
        read: async (paths) => {
          const resp = await sandboxStub().fetch(new Request("http://sandbox/workspace/read", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paths }) }));
          return resp.json();
        },
        write: async (files) => {
          const resp = await sandboxStub().fetch(new Request("http://sandbox/workspace/write", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ files }) }));
          return resp.json();
        },
        remove: async (paths) => {
          const resp = await sandboxStub().fetch(new Request("http://sandbox/workspace/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paths }) }));
          return resp.json();
        },
      };
    }

    // §A1.17 Phase J: runtime:"workflow" scripts dispatch here instead of codeRunner —
    // degrades to an honest "unavailable" (execution-ladder.ts) when AGENT_SCRIPT_WORKFLOW
    // isn't wired, same precedent as every other optional binding above.
    if (this.env.AGENT_SCRIPT_WORKFLOW) {
      const workflowBinding = this.env.AGENT_SCRIPT_WORKFLOW;
      env.workflowRunner = {
        start: async (params) => {
          const instance = await workflowBinding.create({
            params: {
              spaceId: params.spaceId,
              tenantId: params.tenantId,
              agentId: params.agentId,
              ...(params.projectId ? { projectId: params.projectId } : {}),
              scriptName: params.name,
              params: params.args,
            },
          });
          return { id: instance.id };
        },
        status: async (id) => {
          const instance = await workflowBinding.get(id);
          const s = await instance.status();
          return { status: s.status, output: s.output, ...(s.error !== undefined ? { error: String(s.error) } : {}) };
        },
      };
    }

    // Wire HITL gateway (spec §10 / CLAUDE.md task #10): polls HITLApprovalDO per space.
    if (this.env.HITL_APPROVAL_DO) {
      const hitlDO = this.env.HITL_APPROVAL_DO;
      env.hitlGateway = {
        requestApproval: async (params) => {
          const doId = hitlDO.idFromName(`hitl:${spaceId}`);
          const stub = hitlDO.get(doId);

          // Create approval request
          const createResp = await stub.fetch(new Request("http://hitl/requests", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              run_id: params.runId,
              session_id: params.sessionId,
              tool_name: params.actionName,
              tool_input: params.actionInput,
              action_description: params.description,
            }),
          }));
          const { approval_id } = await createResp.json<{ approval_id: string }>();

          // §A1.17 Phase O: "if the agent wants human approval, the assistant is triggered so it
          // always knows what's going on, and uses a channel script to tell the user." Fire this
          // concurrently with the poll below (never awaited) — a slow/failed notification must
          // never delay or fail the approval flow itself.
          void this.notifyApprovalRequested(spaceId, tenantId, agentId, approval_id, params.actionName, params.description);

          // Poll for resolution (28s — HITLApprovalDO auto-rejects at 30s)
          const deadline = Date.now() + 28_000;
          while (Date.now() < deadline) {
            await new Promise<void>((r) => setTimeout(r, 2_000));
            const pollResp = await stub.fetch(new Request(`http://hitl/requests/${approval_id}`));
            const row = await pollResp.json<{ status: string; reject_reason?: string | null }>();
            if (row.status !== "pending") {
              return {
                approvalId: approval_id,
                approved: row.status === "approved",
                ...(row.reject_reason ? { reason: row.reject_reason } : {}),
              };
            }
          }
          return { approvalId: approval_id, approved: false, reason: "HITL polling timeout" };
        },
      };
    }

    // Generic named-lock primitive (the `lock` prebuilt) — an assistant/agent composes its
    // OWN concurrency strategy on top of this (e.g. "lock this CSV row before writing"; see
    // A1.15). Keys are always prefixed by space (+ project, when scoped) HERE, server-side —
    // structural isolation, not something a script has to remember: two different
    // spaces/projects can never collide on the same literal lock name a script picks.
    {
      const lockNamespace = `lock:${spaceId}:${projectId ?? "_"}:`;
      env.lockGateway = {
        // S0.4: failClosed=true — a lock must DENY when ConcurrencyDO is unreachable, never
        // grant every acquirer (that would silently defeat the whole point of taking a lock).
        acquire: (params) =>
          this.acquireConcurrencySlot(lockNamespace + params.key, params.holderId, params.limit ?? 1, params.ttlMs, true),
        release: (params) => this.releaseConcurrencySlot(lockNamespace + params.key, params.holderId),
        status: (key) => this.concurrencyStatus(lockNamespace + key),
      };
    }

    // Local-machine-as-container (§A1.17 Phase M) — one DO per (spaceId, userId); the
    // local-machine prebuilt resolves WHICH userId to target from a matching grant, not from
    // this wiring, so the gateway itself stays a thin per-call address resolver.
    if (this.env.LOCAL_TUNNEL) {
      const localTunnelDO = this.env.LOCAL_TUNNEL;
      env.localTunnel = {
        exec: async ({ userId, op, params }) => {
          const stub = localTunnelDO.get(localTunnelDO.idFromName(`local-tunnel:${spaceId}:${userId}`));
          const resp = await stub.fetch(new Request("http://local-tunnel/exec", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ op, params }),
          }));
          return resp.json<{ ok: boolean; result?: unknown; error?: string }>();
        },
        status: async (userId) => {
          const stub = localTunnelDO.get(localTunnelDO.idFromName(`local-tunnel:${spaceId}:${userId}`));
          const resp = await stub.fetch(new Request("http://local-tunnel/status"));
          return resp.json<{ connected: boolean }>();
        },
      };
    }

    return env;
  }

  // ── Sub-agents (spec "Advanced Agent SDK Patterns" §3 Sub-Agent Coordination) ───────────
  // A running agent can fan out to N child NaelaoAgentDO instances in one agent.spawn call —
  // the script loop's GATE→EXECUTE step issues ONE tool call per turn, so concurrency comes
  // from spawning a *batch* of tasks together (mirrors "send one message with several Task
  // calls" in Claude Code's subagent pattern) rather than from N separate spawn calls.
  //
  // Each child gets ITS OWN budget (never inherited from the parent — fixes "Sub-Agent Token
  // Budget Not Isolated From Parent"), and spawning is `await`ed synchronously inside the
  // parent's own request, so there is no window where the parent's response completes while a
  // child is still in flight — fixes "Sub-agents have no parent-liveness link" structurally,
  // not by polling. A hard cap on batch size (MAX_SUB_AGENTS_PER_SPAWN, deliberately the same
  // order of magnitude as Claude Code's own ~16-subagent fan-out) bounds the blast radius
  // (fixes "Sub-Agent Fan-Out Has No Account-Level Parallelism Ceiling").

  private buildOrchestrationHooks(
    spaceId: string,
    agentId: string,
    tenantId: string,
    apiKey: string,
    parentRunId: string,
    parentThreadId?: string,
    projectId?: string,
    tools?: ScriptToolSurface
  ): import("../script-engine/types.js").OrchestrationHooks {
    const hooks: import("../script-engine/types.js").OrchestrationHooks = {};

    if (this.env.NAELAO_AGENT_DO) {
      const agentDO = this.env.NAELAO_AGENT_DO;
      hooks.spawnSubAgent = async (config) => {
        const rawTasks = Array.isArray((config as { tasks?: unknown[] }).tasks)
          ? ((config as { tasks: Array<Record<string, unknown>> }).tasks)
          : [config];
        const tasks = rawTasks.slice(0, MAX_SUB_AGENTS_PER_SPAWN);

        // Account-level concurrency ceiling (spec §28 ConcurrencyDO) — one slot per SPAWN
        // TREE (this whole batched agent.spawn call), not per child; MAX_SUB_AGENTS_PER_SPAWN
        // already bounds fan-out within a tree. Absent CONCURRENCY_DO = ungated (honest
        // degradation, matches every other optional binding in this build).
        const concurrencyKey = `sub-agent-tree:${spaceId}`;
        const acquired = await this.acquireConcurrencySlot(concurrencyKey, parentRunId, MAX_CONCURRENT_SUB_AGENT_TREES);
        if (!acquired.granted) {
          return {
            id: "",
            results: [{ ok: false, error: `concurrency limit reached: ${acquired.active}/${acquired.limit ?? MAX_CONCURRENT_SUB_AGENT_TREES} sub-agent trees already running for this space` }],
          } as unknown as { id: string };
        }

        try {
          return await this.spawnSubAgentBatch(tasks, spaceId, agentId, tenantId, apiKey, parentRunId, parentThreadId, projectId, agentDO);
        } finally {
          await this.releaseConcurrencySlot(concurrencyKey, parentRunId);
        }
      };
      hooks.receiveFromSubAgent = this.receiveFromSubAgentImpl.bind(this);
      hooks.terminateSubAgent = this.terminateSubAgentImpl.bind(this);
      hooks.sendToSubAgent = async (_id, _task) => {
        // Sub-agents in this build run to completion synchronously within agent.spawn — there
        // is no still-running child to message. Fan out additional work via another
        // agent.spawn({ tasks: [...] }) call instead.
        return { ok: false, reason: "sub-agents run synchronously; spawn another batch instead of sending to a running one" };
      };
    }

    // §A1.17 Phase J: the dynamic-workflow prebuilt's ops. A "workflow" here is not a second
    // parallel store — it's an ordinary stored script (script.create's own skill library)
    // tagged metadata.runtime:"workflow", so execution-ladder.ts routes script.run for it to
    // env.workflowRunner (a durable CF Workflow instance) instead of an isolate. That reuse is
    // why workflow.create/run just delegate to `tools` rather than a bespoke workflow store.
    if (tools) {
      hooks.workflowCreate = async (name, code) => {
        await tools.create({
          name,
          code,
          metadata: {
            description: `Durable workflow authored via dynamic-workflow.workflow.create`,
            domain: "orchestration",
            requires_tier: 2,
            runtime: "workflow",
            origin: "distilled",
          },
        });
        return { id: name };
      };
      hooks.workflowRun = async (name, params) => tools.run(name, params);
      hooks.workflowSchedule = async (name, cron) => {
        // Reuses the existing scheduled_jobs cron dispatcher (runScheduledJobs /
        // fireScriptDirectly) rather than a second scheduler — a due fire calls
        // script.run(name) exactly as any other scheduled script would, and the script's own
        // runtime:"workflow" tag is what routes that particular fire to a Workflow instance
        // instead of holding an isolate open for however long it runs.
        if (!this.env.SPACES_WORKER) return { id: "" };
        try {
          const resp = await this.env.SPACES_WORKER.fetch(new Request(
            `http://spaces-worker/spaces/${spaceId}/scheduled-jobs`,
            {
              method: "POST",
              headers: await this.internalHeaders(tenantId, { "content-type": "application/json" }),
              body: JSON.stringify({
                name: `workflow:${name}`,
                cron_expression: cron,
                script_name: name,
                agent_id: agentId,
                ...(projectId ? { project_id: projectId } : {}),
              }),
            }
          ));
          if (!resp.ok) return { id: "" };
          const created = await resp.json<{ id: string }>();
          return { id: created.id };
        } catch {
          return { id: "" };
        }
      };
      hooks.workflowStatus = async (id) => {
        if (!this.env.AGENT_SCRIPT_WORKFLOW) return { ok: false, reason: "workflow runtime not available" };
        try {
          const instance = await this.env.AGENT_SCRIPT_WORKFLOW.get(id);
          return await instance.status();
        } catch (err) {
          return { ok: false, reason: err instanceof Error ? err.message : String(err) };
        }
      };
    }

    return hooks;
  }

  // S0.4: `failClosed` defaults to false (sub-agent spawn's existing fail-open behavior — a
  // down ConcurrencyDO must not wedge every agent run, a documented product choice). The
  // `lock` prebuilt (below) passes failClosed:true — a lock that grants every acquirer under an
  // outage isn't a lock at all (two customer threads writing a shared ledger.csv would both
  // "win"), so THAT caller must deny rather than silently degrade. Splitting via a parameter
  // (not a second copy of this method) keeps the two callers' behavior independently correct
  // without coupling lock safety to spawn availability.
  private async acquireConcurrencySlot(key: string, holderId: string, limit: number, ttlMs?: number, failClosed = false): Promise<{ granted: boolean; active: number; limit?: number; degraded?: boolean }> {
    if (!this.env.CONCURRENCY_DO) return { granted: !failClosed, active: 0, degraded: true }; // ungated when unbound — flagged, not silent
    try {
      const stub = this.env.CONCURRENCY_DO.get(this.env.CONCURRENCY_DO.idFromName(key));
      const resp = await stub.fetch(new Request("http://concurrency-do/acquire", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, holder_id: holderId, limit, ...(typeof ttlMs === "number" ? { ttl_ms: ttlMs } : {}) }),
      }));
      return await resp.json<{ granted: boolean; active: number; limit?: number }>();
    } catch {
      // failClosed=true (lock path): deny — an unreachable ConcurrencyDO must not grant a lock.
      // failClosed=false (sub-agent spawn, default): fail open, unchanged from before this pass.
      return { granted: !failClosed, active: 0, degraded: true };
    }
  }

  private async releaseConcurrencySlot(key: string, holderId: string): Promise<void> {
    if (!this.env.CONCURRENCY_DO) return;
    try {
      const stub = this.env.CONCURRENCY_DO.get(this.env.CONCURRENCY_DO.idFromName(key));
      await stub.fetch(new Request("http://concurrency-do/release", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, holder_id: holderId }),
      }));
    } catch {
      /* best-effort — the slot's own TTL reclaims it if release never lands */
    }
  }

  private async concurrencyStatus(key: string): Promise<{ active: number }> {
    if (!this.env.CONCURRENCY_DO) return { active: 0 };
    try {
      const stub = this.env.CONCURRENCY_DO.get(this.env.CONCURRENCY_DO.idFromName(key));
      const resp = await stub.fetch(new Request(`http://concurrency-do/status?key=${encodeURIComponent(key)}`));
      const body = await resp.json<{ active: number }>();
      return { active: body.active };
    } catch {
      return { active: 0 };
    }
  }

  private async spawnSubAgentBatch(
    tasks: Array<Record<string, unknown>>,
    spaceId: string,
    agentId: string,
    tenantId: string,
    apiKey: string,
    parentRunId: string,
    parentThreadId: string | undefined,
    projectId: string | undefined,
    agentDO: DurableObjectNamespace<NaelaoAgentDO>
  ): Promise<{ id: string }> {
    const spawned = await Promise.all(
      tasks.map(async (t) => {
        const subId = crypto.randomUUID();
        const goal = String(t["goal"] ?? "");
        const budgetTokens = typeof t["budget_tokens"] === "number" ? (t["budget_tokens"] as number) : DEFAULT_SUB_AGENT_BUDGET_TOKENS;
        const maxSteps = budgetToMaxSteps(budgetTokens);
        const now = Date.now();
        this.ctx.storage.sql.exec(
          `INSERT INTO sub_agents (id, parent_run_id, goal, status, budget_tokens, tokens_used, created_at, updated_at) VALUES (?, ?, ?, 'running', ?, 0, ?, ?)`,
          subId, parentRunId, goal, budgetTokens, now, now
        );
        // Best-effort subthread mirror (spec: a sub-agent run is just a thread, linked to
        // its parent — hidden from the default list unless the project opts in). Awaited
        // (not fire-and-forget) so it can't be abandoned mid-flight once this task's own
        // promise resolves and the DO's request context is free to tear down.
        await this.mirrorThread(spaceId, tenantId, {
          id: subId,
          thread_kind: "sub_agent",
          ...(parentThreadId ? { parent_thread_id: parentThreadId } : {}),
          ...(projectId ? { project_id: projectId } : {}),
          title: goal.slice(0, 120),
        });
        if (!goal) {
          this.ctx.storage.sql.exec(`UPDATE sub_agents SET status='failed', error=?, updated_at=? WHERE id=?`, "missing goal", Date.now(), subId);
          return { id: subId, ok: false, error: "missing goal" };
        }
        try {
          const doId = agentDO.idFromName(`sub:${spaceId}:${subId}`);
          const stub = agentDO.get(doId);
          const resp = await stub.fetch(new Request("http://agent-do/script/run", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              goal,
              spaceId,
              agentId,
              tenantId,
              sessionId: `subagent-${subId}`,
              apiKey,
              // A child shares its parent's project workspace — it's a subthread of the same
              // project, not a different filesystem (spec: threads in a project share one R2
              // workspace).
              ...(projectId ? { projectId } : {}),
              ...(typeof t["model"] === "string" ? { model: t["model"] } : {}),
              context: {
                parent_run_id: parentRunId,
                sub_agent_id: subId,
                max_steps: maxSteps,
                max_tokens: budgetTokens,
                // Lets the child report incremental progress back to THIS DO instance
                // mid-run — see buildSubAgentProgressReporter / handleScriptRun's onProgress wiring.
                parent_do_id: this.ctx.id.toString(),
              },
            }),
          }));
          const body = await resp.json<{ result?: { ok: boolean; output?: unknown; tokens_used?: number; error?: string } }>().catch(() => ({}) as Record<string, never>);
          const tokensUsed = body.result?.tokens_used ?? 0;
          const ok = resp.ok && !!body.result?.ok;
          const output = ok ? sanitizeSubAgentOutput(body.result?.output) : undefined;
          this.ctx.storage.sql.exec(
            `UPDATE sub_agents SET status = ?, tokens_used = ?, result = ?, error = ?, updated_at = ? WHERE id = ?`,
            ok ? "done" : "failed", tokensUsed, ok ? JSON.stringify(output) : null, ok ? null : (body.result?.error ?? `HTTP ${resp.status}`), Date.now(), subId
          );
          return { id: subId, ok, ...(ok ? { output } : { error: body.result?.error ?? `HTTP ${resp.status}` }) };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.ctx.storage.sql.exec(`UPDATE sub_agents SET status='failed', error=?, updated_at=? WHERE id=?`, msg, Date.now(), subId);
          return { id: subId, ok: false, error: msg };
        }
      })
    );
    return { id: spawned.map((s) => s.id).join(","), results: spawned } as unknown as { id: string };
  }

  private receiveFromSubAgentImpl(id: string): Promise<unknown> {
    const rows = this.ctx.storage.sql.exec(`SELECT * FROM sub_agents WHERE id = ?`, id).toArray() as Array<{
      id: string; status: string; result: string | null; error: string | null; tokens_used: number; progress_note: string | null;
    }>;
    const row = rows[0];
    if (!row) return Promise.resolve({ ok: false, error: "unknown sub-agent id" });
    return Promise.resolve({
      ok: row.status === "done",
      status: row.status,
      output: row.result ? safeJsonParse(row.result) : undefined,
      error: row.error ?? undefined,
      tokens_used: row.tokens_used,
      progress_note: row.progress_note ?? undefined,
    });
  }

  private terminateSubAgentImpl(id: string): Promise<void> {
    this.ctx.storage.sql.exec(`UPDATE sub_agents SET status = 'terminated', updated_at = ? WHERE id = ? AND status = 'running'`, Date.now(), id);
    return Promise.resolve();
  }

  /**
   * When this run is a sub-agent (its context carries parent_do_id + sub_agent_id — set by
   * the parent's spawnSubAgent hook), builds an onProgress callback that calls back to the
   * PARENT DO instance so its sub_agents row is updated live, mid-run — see loop.ts's
   * onProgress checkpoints and handleSubAgentProgress below.
   */
  private buildSubAgentProgressReporter(context: Record<string, unknown> | undefined): ((checkpoint: { phase: string; detail?: string }) => Promise<void>) | undefined {
    const parentDoId = context?.["parent_do_id"];
    const subAgentId = context?.["sub_agent_id"];
    if (typeof parentDoId !== "string" || typeof subAgentId !== "string" || !this.env.NAELAO_AGENT_DO) return undefined;
    const agentDO = this.env.NAELAO_AGENT_DO;
    return async (checkpoint) => {
      try {
        const parentStub = agentDO.get(agentDO.idFromString(parentDoId));
        await parentStub.fetch(new Request(`http://agent-do/sub-agents/${encodeURIComponent(subAgentId)}/progress`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ note: checkpoint.detail ? `${checkpoint.phase}: ${checkpoint.detail}` : checkpoint.phase }),
        }));
      } catch {
        /* best-effort — progress reporting never blocks the child's own run */
      }
    };
  }

  private handleSubAgentProgress(id: string, note: string): Response {
    this.ctx.storage.sql.exec(
      `UPDATE sub_agents SET progress_note = ?, updated_at = ? WHERE id = ? AND status = 'running'`,
      note, Date.now(), id
    );
    return Response.json({ ok: true });
  }

  private handleListSubAgents(parentRunId: string): Response {
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT id, parent_run_id, goal, status, budget_tokens, tokens_used, progress_note, created_at, updated_at
         FROM sub_agents WHERE parent_run_id = ? ORDER BY created_at ASC`,
        parentRunId
      )
      .toArray();
    return Response.json({ data: rows, count: rows.length });
  }

  /**
   * Fires an @naelao/events trigger action — runs the named script DIRECTLY via
   * ScriptToolSurface, bypassing the OBSERVE/FIND/GATE loop and the reasoner entirely. A
   * trigger firing is meant to be cheap and deterministic (the builder's own example: a
   * compact script that runs on thread creation "so next time a user comes to that thread
   * the conversation won't eat too much tokens" — the trigger mechanism itself shouldn't
   * cost tokens either). Not gated by the assistant approval policy or requires_approval_for:
   * an admin/assistant already authored this exact (event, script) pairing when they created
   * the trigger — the same trust level as a customer-bot project_rule's run_script action.
   */
  private async handleTriggerFire(request: Request): Promise<Response> {
    const body = await request.json<{
      spaceId: string;
      agentId: string;
      tenantId?: string;
      projectId?: string;
      scriptName: string;
      params?: Record<string, unknown>;
    }>().catch(() => null);
    if (!body?.spaceId || !body.scriptName) {
      return Response.json({ error: "spaceId and scriptName are required" }, { status: 400 });
    }

    const engineEnv = this.buildScriptEngineEnv(body.spaceId, body.agentId, body.tenantId ?? "", undefined, body.projectId);
    if (!engineEnv) {
      return Response.json({ error: "script engine unavailable: SCRIPTS_R2 not bound" }, { status: 503 });
    }
    const config = await loadAgentConfig(engineEnv.scriptsBucket, body.spaceId, body.agentId);
    if (!config) {
      return Response.json({ error: `agent '${body.agentId}' is not provisioned in space '${body.spaceId}'` }, { status: 404 });
    }

    const tools = new ScriptToolSurface(engineEnv, config.scripts.prebuilt);
    const result = await tools.run(body.scriptName, body.params ?? {});
    return Response.json({ result });
  }

  /** POST /approvals/create-external — see the dispatcher comment above. run_id is namespaced
   *  `agent-api:{spaceId}:{agentId}` (distinct from the in-loop gateway's `params.runId`, which
   *  is an actual reasoning-run id) so HITLApprovalDO.consume's run_id check can never confuse
   *  the two approval sources. */
  private async handleCreateExternalApproval(request: Request): Promise<Response> {
    const body = await request.json<{
      spaceId: string; tenantId: string; agentId: string; actionKey: string; description: string;
    }>().catch(() => null);
    if (!body?.spaceId || !body.tenantId || !body.agentId || !body.actionKey) {
      return Response.json({ error: "spaceId, tenantId, agentId, and actionKey are required" }, { status: 400 });
    }
    if (!this.env.HITL_APPROVAL_DO) {
      return Response.json({ error: "HITL_APPROVAL_DO not configured" }, { status: 503 });
    }
    const runId = `agent-api:${body.spaceId}:${body.agentId}`;
    const stub = this.env.HITL_APPROVAL_DO.get(this.env.HITL_APPROVAL_DO.idFromName(`hitl:${body.spaceId}`));
    const createResp = await stub.fetch(new Request("http://hitl/requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        run_id: runId,
        session_id: body.spaceId,
        tool_name: body.actionKey,
        tool_input: {},
        action_description: body.description,
        ttl_ms: 24 * 60 * 60 * 1000, // 24h — a human reviewing an HTTP API call, not the in-loop 30s poll
      }),
    }));
    if (!createResp.ok) return Response.json({ error: "failed to create approval" }, { status: 502 });
    const { approval_id } = await createResp.json<{ approval_id: string }>();

    void this.notifyApprovalRequested(body.spaceId, body.tenantId, body.agentId, approval_id, body.actionKey, body.description);

    return Response.json({
      approval_id,
      poll_url: `/spaces/${body.spaceId}/sessions/agent-api/approvals/${approval_id}`,
    }, { status: 201 });
  }

  private async handleScriptRun(request: Request): Promise<Response> {
    const body = await request.json<{
      goal: string;
      spaceId: string;
      agentId: string;
      tenantId?: string;
      sessionId?: string;
      userId?: string;
      projectId?: string;
      context?: Record<string, unknown>;
      apiKey?: string;
      model?: string;
    }>();

    // Also accept spaceId / agentId / tenantId from internal request headers (set by billing/triggers)
    const spaceId = body.spaceId ?? request.headers.get("x-naelao-space-id") ?? "";
    const tenantId = body.tenantId ?? request.headers.get("x-naelao-tenant-id") ?? "";
    const agentIdFromPath = new URL(request.url).pathname.match(/\/agents\/([^/]+)\//)?.[1];
    const agentId = body.agentId ?? agentIdFromPath ?? "naelao-agent";
    const sessionId = body.sessionId ?? `script-run-${Date.now()}`;
    const userId = body.userId ?? request.headers.get("x-naelao-user-id") ?? undefined;
    // Project-scoped workspace (spec: "a project is workspace-scoped, every thread's agent in
    // it shares one filesystem") — absent means this run is the Space Assistant, operating
    // space-wide. Never inferred; a caller that wants project scoping must say so explicitly.
    const projectId = body.projectId ?? request.headers.get("x-naelao-project-id") ?? undefined;
    // §A1.17 Phase I: which credit balance a non-project (Space Assistant) run's real LLM usage
    // debits from — a signed-in product end user's OWN balance, never inferred from anything the
    // caller could spoof at the script-args level (this is a header the router sets from verified
    // claims for every proxied request, same trust boundary as x-naelao-tenant-id above).
    const callerRole = request.headers.get("x-naelao-role") ?? undefined;
    const runId = crypto.randomUUID();

    if (!body.goal || !spaceId) {
      return Response.json({ error: "goal and spaceId are required" }, { status: 400 });
    }

    const engineEnv = this.buildScriptEngineEnv(spaceId, agentId, tenantId, userId, projectId);
    if (!engineEnv) {
      return Response.json({ error: "script engine unavailable: SCRIPTS_R2 not bound" }, { status: 503 });
    }
    // F14: customer-bot daily spend cap was only enforced in the channel-heartbeat drain path
    // (handleChannelHeartbeat) — a direct /script/run call with the same projectId bypassed it
    // entirely. Apply the identical cap-then-execution-ceiling gate here.
    // F9: the gate itself now checks through SpaceDO (single writer for the whole project),
    // not this DO's own local tally — see checkAndDebitProjectSpend.
    let hasSpendCap = false;
    if (projectId) {
      const projectCfg = await this.fetchProjectConfig(spaceId, tenantId, projectId);
      if (projectCfg.status === "error") {
        // F17 / A1.13: a transient SpaceDO error must fail CLOSED, never read as "unrestricted"
        // — that would silently disable BOTH structural customer-bot controls (execution
        // ceiling and daily spend cap) this project depends on being un-bypassable. Clamp to
        // the most restrictive tier and treat the run exactly like a real spend-cap hit.
        engineEnv.maxTier = 1 as ExecutionTier;
        return Response.json(
          { error: "unable to verify project restrictions — try again shortly", error_code: "spend_capped" },
          { status: 429 }
        );
      }
      if (projectCfg.status === "found") {
        if (projectCfg.daily_spend_cap_credits > 0) {
          hasSpendCap = true;
          const spend = await this.checkAndDebitProjectSpend(spaceId, tenantId, projectId, 0);
          if (spend.capped) {
            return Response.json(
              { error: "daily spend cap reached for this project", error_code: "spend_capped" },
              { status: 429 }
            );
          }
        }
        engineEnv.maxTier = projectCfg.execution_ceiling as ExecutionTier;
      }
      // status === "not_found": no project config row — permissive by design, unchanged.
    }

    // Load the agent's 4-file config; without it the agent is not provisioned.
    const config = await loadAgentConfig(engineEnv.scriptsBucket, spaceId, agentId);
    if (!config) {
      return Response.json({ error: `agent '${agentId}' is not provisioned in space '${spaceId}'` }, { status: 404 });
    }

    // Approval policy. A project-bound Naelao Agent keeps the ordinary allowlist-of-gated
    // actions (spec §11, appendix A1.16.1). The Space Assistant (no projectId) is different:
    // "same access as the owning user, but ask first unless the user has explicitly trusted
    // this action" — always_ask (default) gates everything except auto_approved_actions;
    // yolo skips asking entirely. See loop.ts's ApprovalMode.
    let requiresApprovalFor: string[];
    let approvalMode: "gate_listed" | "gate_unless_listed" = "gate_listed";
    if (projectId) {
      // Structural config.requiresApprovalFor (agent-config.ts, written by
      // launchpadAgentToProfile from def.requires_approval_for) is the enforced source of
      // truth. parseRequiresApprovalFor(agentsMd) only matched a `## requires_approval_for`
      // markdown heading no profile actually writes — agentsMd carries the gates as prose under
      // "# Approval Gates (HITL)" instead — so relying on it alone silently gated nothing.
      // Fall back to the markdown parse only for agents provisioned before this field existed.
      requiresApprovalFor = config.requiresApprovalFor ?? [...parseRequiresApprovalFor(config.agentsMd)];
    } else {
      const policy = await this.fetchAssistantPolicy(spaceId, tenantId);
      if (policy?.approval_mode === "yolo") {
        requiresApprovalFor = [];
      } else {
        requiresApprovalFor = policy?.auto_approved_actions ?? [];
        approvalMode = "gate_unless_listed";
      }
    }

    const tools = new ScriptToolSurface(engineEnv, config.scripts.prebuilt);
    // A sub-agent spawned mid-task inherits the SAME project scoping as its parent — it's
    // conceptually a subthread of the same project, not a different workspace. Built after
    // `tools` (§A1.17 Phase J's workflow.create/run ops need it to author/re-run stored
    // scripts) — read lazily at call time, so ordering relative to runScriptLoop is safe.
    engineEnv.orchestration = this.buildOrchestrationHooks(spaceId, agentId, tenantId, body.apiKey ?? "", runId, sessionId, projectId, tools);
    const reasoner = new GatewayReasoner({
      apiKey: body.apiKey ?? "",
      gateway: {
        accountId: this.env.NAELAO_ACCOUNT_ID ?? "placeholder",
        gatewayId: this.env.NAELAO_GATEWAY_ID ?? "naelao-gateway",
      },
      ctx: { spaceId, agentId, model: body.model ?? "claude-haiku-4-5-20251001" },
      ...(body.model ? { model: body.model } : {}),
    });

    try {
      const maxStepsFromContext = body.context?.["max_steps"];
      const maxTokensFromContext = body.context?.["max_tokens"];
      const onProgress = this.buildSubAgentProgressReporter(body.context);
      const result = await runScriptLoop(engineEnv, tools, reasoner, config.scripts.prebuilt, {
        goal: body.goal,
        startupObserve: config.scripts.startup_observe,
        requiresApprovalFor,
        approvalMode,
        runId,
        sessionId,
        ...(typeof maxStepsFromContext === "number" ? { maxSteps: maxStepsFromContext } : {}),
        ...(typeof maxTokensFromContext === "number" ? { maxTokens: maxTokensFromContext } : {}),
        ...(onProgress ? { onProgress } : {}),
      });

      if (projectId && result.result?.tokens_used) {
        const credits =
          result.result.input_tokens || result.result.output_tokens
            ? tokensToCredits(result.result.input_tokens ?? 0, result.result.output_tokens ?? 0, body.model ?? "claude-haiku-4-5-20251001")
            : result.result.tokens_used;
        // F9: SpaceDO is now the authoritative tally (single writer across every thread on
        // this project); the local table is kept only as this DO's own telemetry/cache.
        this.addProjectSpend(projectId, credits);
        if (hasSpendCap) await this.checkAndDebitProjectSpend(spaceId, tenantId, projectId, credits);
      } else if (!projectId && callerRole === "product_end_user" && userId && result.result?.tokens_used) {
        // §A1.17 Phase I: a non-project run (Space Assistant / Home chat) by a signed-in product
        // end user debits THEIR OWN ProductUserDO balance, not a project cap — mutually exclusive
        // with the branch above (a project-scoped run never reaches here). Post-hoc, best-effort,
        // same posture as the project-spend accounting above: never fails an already-completed
        // run's response over a billing-side hiccup, but insufficient balance is still surfaced
        // in the result notes so it's visible, not silently swallowed.
        const credits =
          result.result.input_tokens || result.result.output_tokens
            ? tokensToCredits(result.result.input_tokens ?? 0, result.result.output_tokens ?? 0, body.model ?? "claude-haiku-4-5-20251001")
            : result.result.tokens_used;
        await this.debitEndUserCredits(spaceId, tenantId, userId, credits, body.model, result.notes, runId);
      }

      // Layer 4 (Fabric) auto-consolidation (spec: "runs LLM-driven session extraction
      // post-run"). Reuses the trace this run already produced instead of a second LLM call —
      // an honest, cost-conscious approximation of the spec's Icarus-framework extraction.
      // Best-effort: never fails the run itself.
      if (engineEnv.memoryStore && result.result?.ok && typeof result.result.output === "string" && result.result.output.trim()) {
        try {
          await engineEnv.memoryStore.recordFabric({
            ...(userId ? { userId } : {}),
            sessionId,
            summary: `Goal: ${body.goal.slice(0, 300)}\nOutcome: ${result.result.output.slice(0, 500)}`,
            keyInsights: result.notes.slice(-5),
          });
        } catch {
          /* best-effort — Fabric is a memory convenience, not run-critical */
        }
      }

      return Response.json(result);
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 500 }
      );
    }
  }

  private async handleMemoryMaintenance(request: Request): Promise<Response> {
    this.ensureInit();
    const body = await request.json<{ spaceId?: string }>().catch(() => ({}) as { spaceId?: string });
    const spaceId = body.spaceId ?? request.headers.get("x-naelao-space-id") ?? "";
    if (!spaceId) return Response.json({ error: "spaceId is required" }, { status: 400 });
    const result = await runMemoryMaintenance({
      sql: this.ctx.storage.sql,
      spaceId,
      ...(this.env.MEMORY_VECTORIZE
        ? { vectorIndex: this.env.MEMORY_VECTORIZE as unknown as NonNullable<ScriptEngineEnv["vectorIndex"]> }
        : {}),
      ...(this.env.AI ? { embedder: new WorkersAIEmbedder(this.env.AI) } : {}),
    });
    return Response.json(result);
  }

  // ── Multi-channel gateway (spec @4211129/@3190360/@3245389) ─────────────────────────────
  // Same one-shared-contract pattern as the connector layer: a ChannelAdapter normalizes
  // any platform's payload, sessions are keyed per (channel, channel_user_id) so two Slack
  // users never bleed into one thread, and the heartbeat drains the unanswered queue through
  // the SAME script-first loop /script/run uses — channels are an ingress, not a parallel
  // reply mechanism (CLAUDE.md: "channels, heartbeats are scripts").

  private async handleChannelInbound(type: string, request: Request): Promise<Response> {
    if (!isChannelType(type)) return Response.json({ error: "unknown_channel" }, { status: 400 });
    const adapter = getAdapter(type);
    if (!adapter) return Response.json({ error: "unknown_channel" }, { status: 400 });

    type InboundBody = { raw?: Record<string, unknown>; projectId?: string; spaceId?: string; tenantId?: string };
    const body = await request.json<InboundBody>().catch(() => ({}) as InboundBody);
    const norm: NormalizedInbound | null = adapter.normalizeInbound(body.raw ?? {});
    if (!norm) return Response.json({ ignored: true }); // bot echo / not actionable

    const rows = this.ctx.storage.sql
      .exec(`SELECT id FROM channel_sessions WHERE channel = ? AND channel_user_id = ?`, norm.channel, norm.channel_user_id)
      .toArray() as Array<{ id: string }>;
    let sessionId: string;
    const isNewSession = !rows[0];
    if (rows[0]) {
      sessionId = rows[0].id;
      this.ctx.storage.sql.exec(
        `UPDATE channel_sessions SET last_seen = ?, project_id = ? WHERE id = ?`,
        Date.now(), body.projectId ?? null, sessionId
      );
    } else {
      sessionId = crypto.randomUUID();
      this.ctx.storage.sql.exec(
        `INSERT INTO channel_sessions (id, channel, channel_user_id, project_id, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)`,
        sessionId, norm.channel, norm.channel_user_id, body.projectId ?? null, Date.now(), Date.now()
      );
    }

    // Mirror as a subthread (spec: a channel conversation is just a thread, not a new
    // addressing concept) — only on first sight of this (channel, channel_user_id) pair;
    // createThread is idempotent on channel_session_id anyway, but this avoids a SpaceDO
    // round trip on every single inbound message from an already-known customer.
    if (isNewSession && body.spaceId && body.tenantId) {
      await this.mirrorThread(body.spaceId, body.tenantId, {
        id: crypto.randomUUID(),
        thread_kind: "channel",
        channel: norm.channel,
        channel_session_id: sessionId,
        title: `${norm.channel}: ${norm.channel_user_id}`,
        ...(body.projectId ? { project_id: body.projectId } : {}),
      });
    }

    // Dedupe on (session, direction, external_id) — re-delivered webhook events no-op.
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO channel_messages (id, session_id, direction, text, external_id, answered, created_at)
       VALUES (?, ?, 'inbound', ?, ?, 0, ?)`,
      crypto.randomUUID(), sessionId, norm.text, norm.external_id, norm.timestamp
    );
    return Response.json({ session_id: sessionId, queued: true });
  }

  // Observability surface for customer-bot projects ("all you do is see what the customers
  // are doing" — this is that view): project_id + human_takeover so the admin/dashboard can
  // tell which project a thread belongs to and whether a human has taken it over.
  private handleListChannelSessions(): Response {
    const rows = this.ctx.storage.sql
      .exec(`SELECT id, channel, channel_user_id, project_id, human_takeover, created_at, last_seen FROM channel_sessions ORDER BY last_seen DESC LIMIT 200`)
      .toArray();
    return Response.json({ sessions: rows, count: rows.length });
  }

  private handleChannelUnanswered(): Response {
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT m.id, m.session_id, s.channel, s.channel_user_id, s.project_id, s.human_takeover, m.text, m.created_at
         FROM channel_messages m JOIN channel_sessions s ON s.id = m.session_id
         WHERE m.direction = 'inbound' AND m.answered = 0 ORDER BY m.created_at ASC LIMIT 100`
      )
      .toArray();
    return Response.json({ pending: rows, count: rows.length });
  }

  /** Maps a channel + the matched channel_user_id to the notify.* op's expected params. */
  private notifyParamsFor(channel: string, channelUserId: string, text: string): Record<string, unknown> {
    if (channel === "email") return { to: channelUserId, subject: "Re: your message", body: text };
    if (channel === "whatsapp") return { to: channelUserId, message: text };
    return { channel: channelUserId, message: text }; // slack / discord
  }

  // Drain the unanswered queue through the script-first loop: the goal asks for a grounded
  // reply; if the model isn't confident it returns "ESCALATE" and the message stays queued
  // for a human (honest escalation beats a confident wrong answer, per A1.3).

  // A1.16.9 (layer-3 backstop): every SPACES_WORKER/KNOWLEDGE_WORKER call below is a direct
  // service-binding call, bypassing naelao-router — workers_dev=false (layer 1) already blocks
  // outside traffic, but these calls must ALSO present a verified internal token so the target
  // worker's requireInternalHmac middleware (layer 3) accepts them.
  private async internalHeaders(tenantId: string, extra?: Record<string, string>): Promise<Record<string, string>> {
    return {
      "x-naelao-tenant-id": tenantId,
      "x-naelao-internal-token": await mintInternalToken(this.env.PLATFORM_SECRET, tenantId),
      ...extra,
    };
  }

  /**
   * §A1.17 Phase O: "the assistant is triggered via events this way it always knows what's
   * going on, and uses a channel script to tell the user an agent needs approval." Best-effort
   * and never awaited by its caller — a slow/failed notification must never delay or fail the
   * approval flow itself (matches the fetchAssistantPolicy/checkAndDebitProjectSpend precedent
   * of failing closed on the SECURITY decision while never blocking on the SIDE EFFECT). Calls
   * the notifications worker directly (not via ScriptToolSurface) specifically to avoid running
   * a script under a DIFFERENT agentId than the DO instance actually addresses — this DO's own
   * SQLite is whichever agent's memory it was constructed for, and notify.email touches no
   * memory anyway, so there is nothing to gain from routing through the script engine here.
   */
  private async notifyApprovalRequested(
    spaceId: string,
    tenantId: string,
    agentId: string,
    approvalId: string,
    actionName: string,
    description: string
  ): Promise<void> {
    // §A1.17 Phase V: live-sync this the moment it happens, independent of whether email
    // notification is configured below — a connected dashboard/shell client sees the pending
    // approval immediately rather than only via the owner's inbox.
    await broadcastSpaceEvent(this.env, tenantId, spaceId, "approval.requested", { approval_id: approvalId, agent_id: agentId, action: actionName });

    if (!this.env.NOTIFICATIONS_WORKER || !this.env.SPACES_WORKER || !tenantId) return;
    try {
      const contactRes = await this.env.SPACES_WORKER.fetch(new Request(
        `http://spaces-worker/internal/spaces/${spaceId}/owner-contact`,
        { headers: await this.internalHeaders(tenantId) }
      ));
      if (!contactRes.ok) return;
      const contact = await contactRes.json<{ found: boolean; email?: string }>();
      if (!contact.found || !contact.email) return;
      await this.env.NOTIFICATIONS_WORKER.fetch(new Request("http://notifications-worker/internal/notify", {
        method: "POST",
        headers: { "content-type": "application/json", "x-naelao-tenant-id": tenantId },
        body: JSON.stringify({
          channel: "email",
          space_id: spaceId,
          to: contact.email,
          subject: `Approval needed: agent '${agentId}' wants to ${actionName}`,
          body: `${description}\n\nApproval id: ${approvalId}. Review and approve or reject it from your Naelao dashboard.`,
        }),
      }));
    } catch {
      // best-effort — never block or fail the approval flow over a notification hiccup
    }
  }

  /** Fetch a customer-bot project's config (execution ceiling, spend cap) from SpaceDO. */
  /**
   * Fetch the Space Assistant's approval policy from SpaceDO. Null on any failure (unreachable
   * SPACES_WORKER, not yet configured) — the caller treats null the same as the safe default
   * (always_ask, nothing pre-approved), never as "assume yolo." This is a security-relevant
   * control: failures fail CLOSED (ask more), not open.
   */
  private async fetchAssistantPolicy(spaceId: string, tenantId: string): Promise<{ approval_mode: "always_ask" | "yolo"; auto_approved_actions: string[] } | null> {
    if (!this.env.SPACES_WORKER || !tenantId) return null;
    try {
      const resp = await this.env.SPACES_WORKER.fetch(new Request(`http://spaces-worker/spaces/${spaceId}/assistant-policy`, {
        headers: await this.internalHeaders(tenantId),
      }));
      if (!resp.ok) return null;
      return await resp.json<{ approval_mode: "always_ask" | "yolo"; auto_approved_actions: string[] }>();
    } catch {
      return null;
    }
  }

  /**
   * F9: authoritative spend check+debit, single-writer via SpaceDO — agent DOs are addressed
   * space:project:thread (their own SQLite each), so a purely local tally undercounts spend by
   * however many concurrent threads/channels a customer-bot project has. Pass credits=0 for a
   * pure pre-run gate check; pass the actual post-run token cost to record it. Fails CLOSED:
   * any error (network, non-2xx, missing SPACES_WORKER) is treated as capped, matching the
   * fetchAssistantPolicy precedent — a spend limiter that fails open isn't one.
   */
  private async checkAndDebitProjectSpend(
    spaceId: string, tenantId: string, projectId: string, credits: number
  ): Promise<{ capped: boolean; spent_today: number }> {
    try {
      const resp = await this.env.SPACES_WORKER.fetch(new Request(
        `http://spaces-worker/spaces/${spaceId}/projects/${projectId}/spend`,
        {
          method: "POST",
          headers: await this.internalHeaders(tenantId, { "content-type": "application/json" }),
          body: JSON.stringify({ credits }),
        }
      ));
      if (!resp.ok) return { capped: true, spent_today: Number.POSITIVE_INFINITY };
      const data = await resp.json<{ capped: boolean; spent_today: number }>();
      return data;
    } catch {
      return { capped: true, spent_today: Number.POSITIVE_INFINITY };
    }
  }

  /** §A1.17 Phase I: debit a signed-in product end user's OWN ProductUserDO balance for a
   *  non-project run's real LLM usage. Best-effort — a billing-side failure never crashes an
   *  already-completed run, but is surfaced in `notes` so it isn't silently swallowed (same
   *  "fail closed on the money, fail open on the response" posture as project-spend above). */
  private async debitEndUserCredits(
    spaceId: string, tenantId: string, endUserId: string, credits: number, model: string | undefined, notes: string[], runId?: string
  ): Promise<void> {
    try {
      // S0.6: idempotency_key namespaced "run:" so a retried debit for the same run is a no-op
      // (reuses the original ledger entry) rather than double-charging; never collides with
      // grantCreditPackPurchase's "credit_pack:..." keys on the same shared unique index.
      const resp = await this.env.SPACES_WORKER.fetch(new Request(
        `http://spaces-worker/internal/product-users/${spaceId}/${endUserId}/credits/deduct`,
        {
          method: "POST",
          headers: await this.internalHeaders(tenantId, { "content-type": "application/json" }),
          body: JSON.stringify({ credits, reason: "agent_run", ...(model ? { model } : {}), ...(runId ? { idempotency_key: `run:${runId}` } : {}) }),
        }
      ));
      if (resp.status === 402) {
        notes.push(`Billing: insufficient credits to cover this run's ${credits} credit(s) — balance was not debited.`);
      } else if (!resp.ok) {
        notes.push(`Billing: failed to debit ${credits} credit(s) for this run (${resp.status}) — see logs.`);
      }
    } catch (err) {
      notes.push(`Billing: failed to debit ${credits} credit(s) for this run (${(err as Error).message}).`);
    }
  }

  private async fetchProjectConfig(spaceId: string, tenantId: string, projectId: string): Promise<ProjectConfigResult> {
    try {
      const resp = await this.env.SPACES_WORKER.fetch(new Request(`http://spaces-worker/spaces/${spaceId}/projects/${projectId}`, {
        headers: await this.internalHeaders(tenantId),
      }));
      if (resp.status === 404) return { status: "not_found" };
      if (!resp.ok) return { status: "error" };
      const data = await resp.json<{ execution_ceiling: number; daily_spend_cap_credits: number }>();
      return { status: "found", execution_ceiling: data.execution_ceiling, daily_spend_cap_credits: data.daily_spend_cap_credits };
    } catch {
      return { status: "error" };
    }
  }

  /** Fetch a customer-bot project's no-code rules (highest priority first) from SpaceDO.
   *  S0.4: distinguishes "found, possibly zero rules" from "error, rules unknown" — callers
   *  must fail CLOSED on the latter (see ProjectRulesResult). */
  private async fetchProjectRules(spaceId: string, tenantId: string, projectId: string): Promise<ProjectRulesResult> {
    try {
      const resp = await this.env.SPACES_WORKER.fetch(new Request(`http://spaces-worker/spaces/${spaceId}/projects/${projectId}/rules`, {
        headers: await this.internalHeaders(tenantId),
      }));
      if (!resp.ok) return { status: "error" };
      const { data } = await resp.json<{ data: ProjectRule[] }>();
      return { status: "found", rules: data.filter((r) => r.enabled !== 0) };
    } catch {
      return { status: "error" };
    }
  }

  /**
   * Mirror a sub-agent spawn or a channel session into SpaceDO's threads table as an ordinary
   * subthread (thread_kind + parent_thread_id) — best-effort: the DO's own sub_agents /
   * channel_sessions tables remain the source of truth for actual bot logic, this is purely
   * so an admin can browse the tree from the normal thread list (opt-in via
   * projects.show_sub_threads or include_sub_threads=true).
   */
  private async mirrorThread(
    spaceId: string,
    tenantId: string,
    thread: {
      id: string;
      project_id?: string;
      parent_thread_id?: string;
      thread_kind: "sub_agent" | "channel";
      title?: string;
      channel?: string;
      channel_session_id?: string;
    }
  ): Promise<void> {
    if (!this.env.SPACES_WORKER || !tenantId) return;
    try {
      await this.env.SPACES_WORKER.fetch(new Request(`http://spaces-worker/spaces/${spaceId}/threads`, {
        method: "POST",
        headers: await this.internalHeaders(tenantId, { "content-type": "application/json" }),
        body: JSON.stringify(thread),
      }));
    } catch {
      /* best-effort mirror — sub_agents/channel_sessions remain the source of truth */
    }
  }

  /** Whitespace-delimited word tokens, each stripped of leading/trailing punctuation and
   *  lowercased — "non-stop" is ONE token ("non-stop"), never split into "non"+"stop", so it
   *  never collides with a standalone "stop" token. Used by matchProjectRule below. */
  private static tokenize(text: string): string[] {
    return text.split(/\s+/).map((t) => t.replace(/^[^\p{L}\p{N}-]+|[^\p{L}\p{N}-]+$/gu, "").toLowerCase()).filter(Boolean);
  }

  /** First enabled rule (priority order — already sorted by the API) whose trigger_pattern
   *  matches the inbound text as whole word tokens, case-insensitive. S0.4: previously a naive
   *  substring `includes`, so a trigger_pattern of "STOP" fired inside "doorstop" (one token,
   *  no internal boundary) AND "non-stop" (a hyphenated compound — a plain \b-boundary regex
   *  still matches "stop" inside it, since a hyphen breaks \w). Tokenizing on WHITESPACE only
   *  (not punctuation) keeps "non-stop" as a single token distinct from "stop", while multi-word
   *  patterns match as a contiguous token subsequence. A false-positive opt-out trigger is a
   *  nuisance; a false NEGATIVE (missing a real "STOP") is the actual compliance risk this
   *  guards against by matching precisely rather than loosely. */
  private matchProjectRule(rules: ProjectRule[], text: string): ProjectRule | null {
    const textTokens = NaelaoAgentDO.tokenize(text);
    for (const r of rules) {
      const patternTokens = NaelaoAgentDO.tokenize(r.trigger_pattern);
      if (patternTokens.length === 0) continue;
      for (let i = 0; i <= textTokens.length - patternTokens.length; i++) {
        if (patternTokens.every((tok, j) => textTokens[i + j] === tok)) return r;
      }
    }
    return null;
  }

  private todaySpendKey(): string {
    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  }

  private getProjectSpendToday(projectId: string): number {
    const row = this.ctx.storage.sql
      .exec(`SELECT credits FROM project_spend WHERE project_id = ? AND day = ?`, projectId, this.todaySpendKey())
      .toArray() as Array<{ credits: number }>;
    return row[0]?.credits ?? 0;
  }

  private addProjectSpend(projectId: string, credits: number): void {
    const day = this.todaySpendKey();
    this.ctx.storage.sql.exec(
      `INSERT INTO project_spend (project_id, day, credits) VALUES (?, ?, ?)
       ON CONFLICT (project_id, day) DO UPDATE SET credits = credits + excluded.credits`,
      projectId, day, credits
    );
  }

  private markOutbound(sessionId: string, messageId: string, text: string): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO channel_messages (id, session_id, direction, text, external_id, answered, created_at) VALUES (?, ?, 'outbound', ?, NULL, 1, ?)`,
      crypto.randomUUID(), sessionId, text, Date.now()
    );
    this.ctx.storage.sql.exec(`UPDATE channel_messages SET answered = 1 WHERE id = ?`, messageId);
  }

  private async handleChannelHeartbeat(request: Request): Promise<Response> {
    this.ensureInit();
    type HeartbeatBody = { spaceId?: string; agentId?: string; tenantId?: string; apiKey?: string; model?: string; max?: number };
    const body = await request.json<HeartbeatBody>().catch(() => ({}) as HeartbeatBody);
    const spaceId = body.spaceId ?? request.headers.get("x-naelao-space-id") ?? "";
    if (!spaceId) return Response.json({ error: "spaceId is required" }, { status: 400 });
    const agentId = body.agentId ?? "naelao-agent";
    const tenantId = body.tenantId ?? "";
    const limit = Math.min(body.max ?? 5, 20);

    // human_takeover sessions are correctly left alone — a human is already handling them,
    // this is not an escalation/failure, so it's tracked separately from `escalated`.
    const pending = this.ctx.storage.sql
      .exec(
        `SELECT m.id, m.session_id, s.channel, s.channel_user_id, s.project_id, m.text
         FROM channel_messages m JOIN channel_sessions s ON s.id = m.session_id
         WHERE m.direction = 'inbound' AND m.answered = 0 AND s.human_takeover = 0
         ORDER BY m.created_at ASC LIMIT ?`,
        limit
      )
      .toArray() as Array<{ id: string; session_id: string; channel: string; channel_user_id: string; project_id: string | null; text: string }>;

    if (pending.length === 0) return Response.json({ drained: 0, answered: 0, escalated: 0, rule_handled: 0, spend_capped: 0 });

    const engineEnv = this.buildScriptEngineEnv(spaceId, agentId, tenantId);
    if (!engineEnv) return Response.json({ error: "script engine unavailable: SCRIPTS_R2 not bound" }, { status: 503 });
    const config = await loadAgentConfig(engineEnv.scriptsBucket, spaceId, agentId);
    if (!config) return Response.json({ error: `agent '${agentId}' is not provisioned in space '${spaceId}'` }, { status: 404 });
    // Same structural-config-first, agents.md-parse-fallback precedence as handleScriptRun above.
    const requiresApprovalFor = config.requiresApprovalFor ?? [...parseRequiresApprovalFor(config.agentsMd)];
    const tools = new ScriptToolSurface(engineEnv, config.scripts.prebuilt);
    const model = body.model ?? "claude-haiku-4-5-20251001";
    const reasoner = new GatewayReasoner({
      apiKey: body.apiKey ?? "",
      gateway: { accountId: this.env.NAELAO_ACCOUNT_ID ?? "placeholder", gatewayId: this.env.NAELAO_GATEWAY_ID ?? "naelao-gateway" },
      ctx: { spaceId, agentId, model },
      model,
    });

    // Resolve config + rules once per distinct project among this batch (not per message).
    // F17 / A1.13: store the FULL ProjectConfigResult (found/not_found/error), not just
    // successful fetches — a SpaceDO error must be distinguishable from "no config row" so the
    // per-message loop below can fail closed instead of silently running unrestricted.
    const projectIds = [...new Set(pending.map((m) => m.project_id).filter((id): id is string => !!id))];
    const projectConfigs = new Map<string, ProjectConfigResult>();
    // S0.4: store the FULL ProjectRulesResult (found/error) — same fail-closed discipline as
    // projectConfigs above. Collapsing to a bare array would silently disable the STOP/opt-out/
    // human-takeover baseline on a rules-endpoint-only outage.
    const projectRules = new Map<string, ProjectRulesResult>();
    for (const pid of projectIds) {
      const [cfg, rules] = await Promise.all([this.fetchProjectConfig(spaceId, tenantId, pid), this.fetchProjectRules(spaceId, tenantId, pid)]);
      projectConfigs.set(pid, cfg);
      projectRules.set(pid, rules);
    }

    let answered = 0;
    let escalated = 0;
    let ruleHandled = 0;
    let spendCapped = 0;

    for (const msg of pending) {
      // Untrusted inbound text — moderate before it ever reaches the reasoning prompt or a rule match.
      if (moderateInput(msg.text).blocked) { escalated++; continue; }

      const projectCfgResult = msg.project_id ? projectConfigs.get(msg.project_id) : undefined;
      const projectCfg = projectCfgResult?.status === "found" ? projectCfgResult : undefined;
      const rulesResult = msg.project_id ? projectRules.get(msg.project_id) : undefined;
      // S0.4: a rules-fetch error for a customer-bot project must escalate, never silently run
      // with an empty ruleset — that would bypass the STOP/UNSUBSCRIBE/human-takeover baseline
      // exactly when we can least verify it's safe not to. Only a genuinely empty (found) list
      // means "this project has no rules configured."
      if (msg.project_id && rulesResult?.status === "error") {
        this.ctx.storage.sql.exec(`UPDATE channel_sessions SET human_takeover = 1 WHERE id = ?`, msg.session_id);
        escalated++;
        continue;
      }
      const rules = rulesResult?.status === "found" ? rulesResult.rules : [];

      // Identity linking (spec: returning customers should be recognized) — a deterministic,
      // per-space-scoped user id derived from (channel, channel_user_id). Set on the shared
      // engineEnv before every path that can touch Memory OS for this message, the same way
      // maxTier is mutated per message below — memory.remember/recall and the surgical-recall
      // pre-flight then scope to THIS customer, not the space at large, across visits.
      engineEnv.userId = `channel:${msg.channel}:${msg.channel_user_id}`;
      // Project-scoped workspace — every customer thread in this customer-bot project shares
      // the SAME R2 filesystem (e.g. a project-wide ledger.csv a no-code rule's run_script
      // writes a row into per customer). Mutated per message like maxTier, since one heartbeat
      // sweep can touch several projects.
      if (msg.project_id) engineEnv.projectId = msg.project_id;
      else delete engineEnv.projectId;

      // 1. No-code rules (spec: "after the customer says X, this happens") — checked before
      //    any reasoning at all. Zero token cost, deterministic, admin-authored.
      const matchedRule = this.matchProjectRule(rules, msg.text);
      if (matchedRule) {
        if (matchedRule.action === "human_takeover") {
          this.ctx.storage.sql.exec(`UPDATE channel_sessions SET human_takeover = 1 WHERE id = ?`, msg.session_id);
          ruleHandled++;
          continue; // message stays unanswered for a human — that's the point
        }
        const replyText = matchedRule.action === "reply"
          ? (matchedRule.reply_text ?? "")
          : null;
        if (replyText) {
          const deliver = await tools.run(`notify.${msg.channel}`, this.notifyParamsFor(msg.channel, msg.channel_user_id, replyText));
          if (deliver.ok) {
            this.markOutbound(msg.session_id, msg.id, replyText);
            ruleHandled++;
            continue;
          }
        } else if (matchedRule.action === "run_script" && matchedRule.script_name) {
          if (projectCfgResult?.status === "error") {
            // F17 / A1.13: fail closed — never run a rule-triggered script unrestricted while
            // the project's config is unreachable. Treat exactly like a spend-cap hit.
            engineEnv.maxTier = 1 as ExecutionTier;
            spendCapped++;
            continue;
          }
          if (projectCfg) engineEnv.maxTier = projectCfg.execution_ceiling as ExecutionTier;
          const scriptResult = await tools.run(matchedRule.script_name, { text: msg.text, channel_user_id: msg.channel_user_id });
          if (scriptResult.ok) {
            this.markOutbound(msg.session_id, msg.id, `(handled by rule → ${matchedRule.script_name})`);
            ruleHandled++;
            continue;
          }
        }
        // Rule matched but delivery/script failed — fall through to escalation, not silent drop.
        escalated++;
        continue;
      }

      // 2. Daily spend cap (customer-bot projects only) — protects against a chatty or
      //    adversarial customer running up an unbounded bill. Once hit, leave the rest of
      //    today's messages for a human rather than silently dropping them.
      // F9: gate through SpaceDO (single writer for the whole project), not this DO's own
      // local tally — a project can otherwise receive traffic through more than one agent DO
      // (this channel-drain DO AND a direct per-thread /script/run session against the same
      // project), and only SpaceDO sees both.
      if (
        projectCfg &&
        projectCfg.daily_spend_cap_credits > 0 &&
        (await this.checkAndDebitProjectSpend(spaceId, tenantId, msg.project_id!, 0)).capped
      ) {
        spendCapped++;
        continue;
      }

      // 3. Full reasoning loop, under the project's execution ceiling if it has one.
      if (projectCfg) {
        engineEnv.maxTier = projectCfg.execution_ceiling as ExecutionTier;
      } else if (projectCfgResult?.status === "error") {
        // F17 / A1.13: SpaceDO fetch failed — fail CLOSED (most restrictive tier, treated as a
        // spend-cap hit) rather than running the full reasoning loop unrestricted.
        engineEnv.maxTier = 1 as ExecutionTier;
        spendCapped++;
        continue;
      } else {
        delete engineEnv.maxTier;
      }

      let result: Awaited<ReturnType<typeof runScriptLoop>>;
      try {
        result = await runScriptLoop(engineEnv, tools, reasoner, config.scripts.prebuilt, {
          goal:
            `A message arrived on ${msg.channel} from user ${msg.channel_user_id}: "${msg.text.slice(0, 2000)}". ` +
            `Draft a helpful, grounded reply and send it via notify.${msg.channel} to "${msg.channel_user_id}". ` +
            `If you cannot answer confidently, reply with exactly "ESCALATE" instead of guessing — do not send anything.`,
          startupObserve: config.scripts.startup_observe,
          requiresApprovalFor,
          sessionId: msg.session_id,
        });
      } catch (err) {
        result = { level: "L4", result: { ok: false, error: String(err), tier: 1, duration_ms: 0, tokens_used: 0 }, notes: [] };
      }

      if (msg.project_id && result.result?.tokens_used) {
        // Real per-model USD→credit conversion (billing-core), not the old "1 token ≈ 1
        // credit" proxy — falls back to the raw token count only if a future producer of
        // tokens_used ever omits the input/output breakdown (never happens today).
        const credits = result.result.input_tokens || result.result.output_tokens
          ? tokensToCredits(result.result.input_tokens ?? 0, result.result.output_tokens ?? 0, model)
          : result.result.tokens_used;
        // F9: SpaceDO is the authoritative tally; the local table is kept only as this DO's
        // own telemetry/cache.
        this.addProjectSpend(msg.project_id, credits);
        if (projectCfg && projectCfg.daily_spend_cap_credits > 0) {
          await this.checkAndDebitProjectSpend(spaceId, tenantId, msg.project_id, credits);
        }
      }

      const deliveredDirectly = result.script_name?.startsWith("notify.") && result.result?.ok;
      if (deliveredDirectly) {
        this.markOutbound(msg.session_id, msg.id, "(sent via notify)");
        answered++;
        continue;
      }

      const text = typeof result.result?.output === "string" ? result.result.output.trim() : "";
      if (!result.result?.ok || !text || text === "ESCALATE" || !moderateText(text).allowed) {
        escalated++;
        continue;
      }
      // The reasoner answered in text rather than calling notify.* itself — deliver it now.
      const deliver = await tools.run(`notify.${msg.channel}`, this.notifyParamsFor(msg.channel, msg.channel_user_id, text));
      if (!deliver.ok) { escalated++; continue; }
      this.markOutbound(msg.session_id, msg.id, text);
      answered++;
    }
    return Response.json({ drained: pending.length, answered, escalated, rule_handled: ruleHandled, spend_capped: spendCapped });
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
      platformSecret: this.env.PLATFORM_SECRET,
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
    const headers = await this.internalHeaders(tenantId, { "content-type": "application/json" });

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

    // §A1.17 Phase Q: this response's only two consumers (the GET .../agent/runs/:runId
    // passthrough and the SSE /stream poller in workers/agents/src/index.ts, both of which
    // apps/shell and apps/portal's clients read from) have always expected snake_case
    // final_answer/react_steps — this handler returned camelCase, so `run.final_answer` read
    // through every one of those call sites as `undefined`. A real, previously-undetected bug
    // (nothing exercised this route with a realistic client before now); fixed by matching the
    // shape every consumer already expects rather than touching three call sites.
    return Response.json({
      id: run.id,
      session_id: run.session_id,
      space_id: run.space_id,
      tenant_id: run.tenant_id,
      status: run.status,
      fsm_state: run.fsm_state,
      goal: run.goal,
      react_steps: JSON.parse(run.react_steps as string) as ReactStep[],
      final_answer: run.final_answer,
      error: run.error,
      created_at: run.created_at,
      updated_at: run.updated_at,
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
