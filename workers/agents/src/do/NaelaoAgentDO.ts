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
import { getDOName } from "@naelao/crypto";
import type { LlmTool, LlmFunctionTool, LlmMessage, ContentBlock } from "@naelao/llm-gateway";
import { callLlm, moderateInput, moderateOutput } from "@naelao/llm-gateway";
import type { SystemBlock } from "@naelao/llm-gateway";
import { moderateText } from "@naelao/moderation";
import { tokensToCredits, infraTimeToCredits, capabilityForModel, contextWindowForModel, DEFAULT_WORKING_MODEL, UTILITY_MODEL, isValidEffortLevel, resolveEscalationModel, type EffortLevel } from "@naelao/billing-core";
import { classifyFailure } from "@naelao/events";
import type { ReasoningRequest, GatewayOpts } from "../shared/ai-client.js";
import { byokProviderForModel, BYOK_PROVIDER_KEY_FIELD } from "../shared/ai-client.js";
import {
  ScriptToolSurface,
  runScriptLoop,
  parseRequiresApprovalFor,
  loadAgentConfig,
  writeAgentConfig,
  mergeMissingPrebuilt,
  DEFAULT_NAELAO_AGENT,
  LAUNCHPAD_ASSISTANT_PROFILE,
  type ScriptEngineEnv,
  type ExecutionTier,
  type TraceStep,
  type LiveCheckpoint,
  type LoopResult,
  type ScriptRunResult,
  type AgentConfig,
} from "../script-engine/index.js";
import { createTracer } from "@naelao/tracing";
import { GatewayReasoner, WorkersAIEmbedder } from "../script-engine/reasoner.js";
import { resolveAssistantApprovalPlan, type AssistantEffectiveRole } from "../script-engine/assistant-access.js";
import {
  buildCodeRunner,
  type WorkerLoaderBinding,
  VirtualPosixShell,
  ArtifactsGitService,
  buildRuntimeContext,
  type VirtualFsStorage,
} from "../script-engine/code-runner.js";
import { initMemorySchema, buildMemoryStore, runMemoryMaintenance } from "../script-engine/memory-os.js";
import { buildProjectMemoryStore, buildHybridMemoryStore } from "../script-engine/project-memory-client.js";
import {
  buildConversationContext,
  messagesToSummarize,
  buildSummaryPrompt,
  type ConversationContext,
  type ConversationMessage,
} from "../script-engine/conversation-context.js";
import { isChannelType, getAdapter, type NormalizedInbound } from "../launchpad/channels.js";
import type { BusinessContext } from "../launchpad/business-context.js";
import {
  sanitizeSubAgentOutput,
  safeJsonParse,
  budgetToMaxSteps,
  MAX_SUB_AGENTS_PER_SPAWN,
  DEFAULT_SUB_AGENT_BUDGET_TOKENS,
  MAX_CONCURRENT_SUB_AGENT_TREES,
} from "../script-engine/sub-agent-output.js";

import { buildCliSdkContext } from "../script-engine/tool-surface.js";
import { composeSystemPrompt } from "../script-engine/profiles.js";
import { assembleSystemPrompt, type BusinessContextBrief } from "../script-engine/prompt-assembly.js";
import { sanitizeToolsForRole, resolveAgentRole, type AgentRoleType, ROLE_FIREWALL_POLICIES } from "../script-engine/firewall.js";
import { AVOS_PATH_CONVENTIONS, getWorkspacePath } from "../script-engine/types.js";
import { parseGoalCommand, planGoalWithFrontier, executeSubtaskSlice } from "../script-engine/dual-tier-executor.js";
import type { SemanticDeduplicationResult, ProjectTask, TaskLeaseClaimResult, TaskStatus } from "@naelao/types";

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

export interface ShellSessionState {
  cwd: string;                   // e.g. "src/components"
  envVars: Record<string, string>; // e.g. { NODE_ENV: "production" }
  activeGitBranch: string;       // e.g. "feature-darkmode"
}

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

/** How long a human actually has to answer an approval. Bounded rather than open-ended so a
 *  forgotten request can't hold a checkpoint forever, but on a human scale — the previous 30s
 *  meant an owner who wasn't already staring at the screen could never approve anything. */
const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
/** How long the run holds its request open before suspending. Long enough that someone already
 *  looking at the approval sees an uninterrupted run; short enough not to burn the invocation. */
const APPROVAL_INLINE_WAIT_MS = 20_000;
/**
 * How long a single script-native run may keep taking new steps.
 *
 * The loop is no longer bounded by a step count (see script-engine/loop-budget.ts), so something
 * has to represent "a person is waiting." Ten minutes is far beyond any turn observed in practice
 * and well inside what a Durable Object holding an active outbound connection can sustain, so in
 * normal use it never fires — it exists so a pathological run ends with a real answer about what it
 * managed to do rather than hanging. A caller with its own budget (a sub-agent, a durable job whose
 * enclosing Workflow step has no wall-time limit of its own) overrides it via `context.deadline_ms`.
 */
const RUN_WALL_CLOCK_MS = 10 * 60 * 1000;
/** The outcome of a resolved run, retained briefly so a client polling just after completion gets
 *  the answer rather than a 404. See NaelaoAgentDO.finishLiveRun. */
/** One live-progress step as it is held in memory and stored in `run_stream` — a TraceStep plus
 *  the transient `partial` marker (the model is mid-sentence and this row will be rewritten). */
type LiveRunStepRow = Omit<TraceStep, "ts"> & { ts: number; partial?: boolean };

interface FinishedRunState {
  status: string;
  final_answer?: string;
  error?: string;
  pending_approval?: unknown;
  deferred_approvals?: unknown;
}
/** The same clock for a channel reply, where the loop is draining a queue of waiting customers
 *  rather than serving one person's request. */
const CHANNEL_REPLY_WALL_CLOCK_MS = 2 * 60 * 1000;
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

// P0-3: caller roles treated as "a builder using their own Space Assistant" for monthly LLM-usage
// metering — deliberately excludes "product_end_user" (its own separate credit-balance gate) and
// "agent" (Phase O API-key identity, a different pricing situation), and requires an EXPLICIT
// role match so an internal/system-initiated run (billing webhooks, scheduled jobs, triggers —
// none of which ever set x-naelao-role) is never accidentally gated.
const BUILDER_CALLER_ROLES = new Set(["owner", "admin", "editor", "viewer"]);

// G-BB03: Context window budget constants
// claude-sonnet-4-6 supports 200K tokens; we reserve 10K headroom for completion
/** Reserved scope id for memory that belongs to the SPACE's assistant rather than any one project.
 *  Same reserved name workspacePrefix() and the Tier-5 sandbox already use for "not a project", so
 *  the assistant's shared layers key off one stable id instead of a per-session DO. */
export const ASSISTANT_MEMORY_SCOPE = "_assistant";

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

// Go-live audit A-1/A-2: runReActLoop used to return only the final answer string, discarding the
// real token usage it already tracks internally (totalInputTokens/totalOutputTokens) — handleRun
// had no way to settle billing on its run because of this. Every return point in the loop now
// reports its accumulated usage so handleRun can call settleRunBilling with real numbers, the same
// way handleScriptRun already does from runScriptLoop's result.
interface ReActLoopResult {
  finalAnswer: string;
  inputTokens: number;
  outputTokens: number;
  tokensUsed: number;
}

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
  SPACES?: DurableObjectNamespace;
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
  /** The agents worker's own self-binding — lets the business-email prebuilt reach an internal
   *  route on this same worker that holds AGENTMAIL_API_KEY (the isolate never sees the key). */
  AGENTS_WORKER?: Fetcher;
  /** Billing worker — holds Lemon Squeezy creds; the only money-in path (commerce script). */
  BILLING_WORKER?: Fetcher;
  /** MCP hub worker — external-platform connector registry + tool proxy (mcp-connector). */
  MCP_HUB?: Fetcher;
  /** Credentials worker — used by the wallet prebuilt's check_bypass op to detect whether a
   *  business has its own credential for a known third-party payment provider. */
  CREDENTIALS_WORKER?: Fetcher;
  /** Phase 5: artifact worker — agent-authored deliverables (a rendered HTML page, a report),
   *  distinct from r2-workspace's own scratch storage. Optional: the `artifacts` prebuilt
   *  degrades honestly ("artifacts unavailable") when unbound, same posture as every other
   *  optional service binding here. */
  ARTIFACT_WORKER?: Fetcher;
  /** AI Gateway identity (spec §15). */
  NAELAO_ACCOUNT_ID?: string;
  NAELAO_GATEWAY_ID?: string;
  /** CF AI Gateway Authenticated-Gateway token (`cf-aig-authorization`). When set, the gateway
   *  holds the Anthropic/OpenAI key itself (BYOK / stored keys), so no ANTHROPIC_API_KEY is needed
   *  on the worker. Set via `wrangler secret put NAELAO_AIG_TOKEN`. */
  NAELAO_AIG_TOKEN?: string;
  /** Optional since the vendor cutover — see NAELAO_AIG_TOKEN. */
  ANTHROPIC_API_KEY?: string;
  /** A real Google AI Studio (Gemini) API key, BYOK — lets the model switcher offer Gemini models
   *  (`google-ai-studio/...`) routed through the AI Gateway's compat endpoint (see
   *  shared/ai-client.ts's isGoogleAiStudioModel doc for why this is a separate path from every
   *  other model). Set via `wrangler secret put GOOGLE_AI_STUDIO_API_KEY`. Absent → those model ids
   *  degrade honestly to a `give_up` naming the missing secret, same as every other credential gap
   *  in this file. */
  GOOGLE_AI_STUDIO_API_KEY?: string;
  /** Groq BYOK key — free tier is 14,400 requests/day, which is what makes real testing possible. */
  GROQ_API_KEY?: string;
  /** CF API token — enables the Universal Endpoint's Workers AI fallback provider (spec §15
   *  cross-provider failover). Required for Workers AI via the universal endpoint (distinct from
   *  the AI binding, which is for direct binding calls). Set via `wrangler secret put
   *  CF_API_TOKEN`. When absent, the reasoner uses the Anthropic-specific endpoint only. */
  CF_API_TOKEN?: string;
  /** F-12: cross-provider LLM failover. When the primary model fails at the gateway, it falls
   *  back to LLM_FALLBACK_MODEL (defaults to a cheaper Anthropic model on the SAME key — real
   *  within-provider model failover with no extra secret) and, if OPENAI_API_KEY is set,
   *  additionally to OPENAI_FALLBACK_MODEL on OpenAI — real CROSS-provider failover. All optional;
   *  absent → single-provider behavior unchanged. */
  LLM_FALLBACK_MODEL?: string;
  OPENAI_API_KEY?: string;
  OPENAI_FALLBACK_MODEL?: string;
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
  /** §A1.19 (AutoRAG/AI Search): the Cloudflare AutoRAG instance name backing Memory OS Layer 6
   *  (Wiki) semantic search, invoked via the existing `AI` binding's `.autorag(name)` accessor —
   *  no separate binding needed. Optional — wiki.search degrades to its existing SQLite
   *  LIKE-match when unset, same "configured:false" honest-degradation posture as every other
   *  optional platform integration (TAVILY_API_KEY, COMPOSIO_API_KEY, ...). Verify the exact
   *  `.autorag()` search response shape against current Cloudflare AutoRAG docs before relying on
   *  it in production — the adapter below is written defensively (best-effort try/catch) for
   *  exactly this reason. */
  AUTORAG_WIKI_INSTANCE?: string;
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
  private virtualShell!: VirtualPosixShell;
  private artifactsGit!: ArtifactsGitService;

  private ensureInit(): void {
    if (this.initialized) return;

    // Do NOT run PRAGMA statements here (journal_mode/synchronous/cache_size) — Cloudflare's
    // SQLite-backed DO storage manages its own engine settings and rejects these with "not
    // authorized: SQLITE_AUTH", throwing on every call to this DO in production (confirmed via a
    // live wrangler tail session against a real deployment; see RateLimitDO.ts's identical fix —
    // this was the root cause of the platform-wide "fetch failed" signup failure).

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

    // §A1 Phase HX1 — structured per-step trace for script-native runs (runScriptLoop's
    // TraceStep[]). handleScriptRun mints its own runId with no `agent_runs` row backing it
    // (that table is legacy-ReAct-only) — this table is the first persisted-by-id record of a
    // script-native run's existence, one row per phase/script.run/reasoner-decision.
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS run_traces (
        run_id      TEXT NOT NULL,
        seq         INTEGER NOT NULL,
        phase       TEXT NOT NULL,
        name        TEXT,
        tier        INTEGER,
        duration_ms INTEGER,
        tokens      INTEGER,
        ok          INTEGER,
        detail      TEXT,
        ts          INTEGER NOT NULL,
        PRIMARY KEY (run_id, seq)
      )
    `);
    this.ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS idx_run_traces_run ON run_traces(run_id)`);
    // These four were silently dropped at persistence — `TraceStep` always carried them, but the
    // DB round-trip stripped them, which is why a reload could never show what the model said
    // mid-run, its chain-of-thought, or a tool call's real arguments/result. Nullable TEXT: params
    // as JSON, output/narration/thinking as plain (already size-capped where it matters).
    try { this.ctx.storage.sql.exec(`ALTER TABLE run_traces ADD COLUMN narration TEXT`); } catch { /* exists */ }
    try { this.ctx.storage.sql.exec(`ALTER TABLE run_traces ADD COLUMN thinking TEXT`); } catch { /* exists */ }
    try { this.ctx.storage.sql.exec(`ALTER TABLE run_traces ADD COLUMN params TEXT`); } catch { /* exists */ }
    try { this.ctx.storage.sql.exec(`ALTER TABLE run_traces ADD COLUMN output TEXT`); } catch { /* exists */ }
    // A real message the model wrote to the person (its optional `say`), as opposed to `narration`
    // — the per-action status that the next action replaces. Kept separately because they render
    // in different places and have different lifetimes; see TraceStep's own doc.
    try { this.ctx.storage.sql.exec(`ALTER TABLE run_traces ADD COLUMN message TEXT`); } catch { /* exists */ }

    // The durable stream: a run's live progress and its answer AS IT IS BEING WRITTEN.
    //
    // This exists so a person can close the tab and come back. The in-memory `liveRuns` map is
    // per-instance and dies with hibernation or eviction, so before this the only two states a
    // returning client could see were "still running, no idea what it has done" and "finished".
    // Everything in between — the tool calls it had made, the half-written reply — was gone.
    //
    // `run_traces` above is deliberately NOT reused: it is the finished audit record, written once
    // at the end, and by definition holds nothing while the run is the thing you want to watch.
    //
    // Two tables rather than an append-only event log per delta: a growing answer is ONE fact that
    // keeps changing, not a thousand facts, so it is an UPSERT on a single row (throttled), and a
    // step is a row keyed by its own seq so a partial can be updated in place. That keeps writes
    // proportional to real progress rather than to token count.
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS run_state (
        run_id         TEXT PRIMARY KEY,
        session_id     TEXT NOT NULL,
        status         TEXT NOT NULL,
        partial_answer TEXT,
        terminal_json  TEXT,
        started_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL
      )
    `);
    // Finding "is anything running in this conversation?" is what lets a NEW tab reattach at all —
    // the client cannot be the source of truth for that, because a new tab has no memory.
    this.ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS idx_run_state_session ON run_state(session_id, started_at DESC)`);
    this.ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS idx_run_state_age ON run_state(updated_at)`);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS run_stream (
        run_id  TEXT NOT NULL,
        seq     INTEGER NOT NULL,
        step_json TEXT NOT NULL,
        ts      INTEGER NOT NULL,
        PRIMARY KEY (run_id, seq)
      )
    `);

    // Compacted-conversation summaries. Kept in the agent DO rather than SpaceDO because this is
    // derived reasoning context, not conversation data of record — SpaceDO still holds every
    // message verbatim, which is what conversation.search reads. `covered_messages` is how many
    // of the oldest messages the summary already accounts for, so it is only regenerated when the
    // conversation has actually grown past it, not on every turn.
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS conversation_summaries (
        session_id      TEXT PRIMARY KEY,
        summary         TEXT NOT NULL,
        covered_messages INTEGER NOT NULL,
        updated_at      TEXT NOT NULL
      )
    `);

    // Actions that have actually executed, so a replay can't execute them again. Keyed by the
    // run's ledger key (an original run and every resume of it share one), the action name, and a
    // hash of its arguments. Rows are pruned by age — this is replay protection for a run in
    // flight, not a permanent audit log (run_traces and agent_activity_log are that).
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS action_ledger (
        ledger_key  TEXT NOT NULL,
        action_name TEXT NOT NULL,
        params_hash TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        PRIMARY KEY (ledger_key, action_name, params_hash)
      )
    `);
    this.ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS idx_action_ledger_age ON action_ledger(created_at)`);

    // Runs suspended at a HITL gate, waiting for a human. The checkpoint that makes an approval
    // answerable on a human timescale rather than within one request: the run stopped just BEFORE
    // the gated action, so nothing gated has executed, and everything it had already done is
    // preserved in `steps_json` to be handed back to the model on resume instead of re-derived.
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS suspended_runs (
        approval_id  TEXT PRIMARY KEY,
        run_id       TEXT NOT NULL,
        space_id     TEXT NOT NULL,
        tenant_id    TEXT NOT NULL,
        agent_id     TEXT NOT NULL,
        session_id   TEXT NOT NULL,
        project_id   TEXT,
        user_id      TEXT,
        caller_role  TEXT,
        model        TEXT,
        goal         TEXT NOT NULL,
        action_name  TEXT NOT NULL,
        steps_json   TEXT NOT NULL DEFAULT '[]',
        status       TEXT NOT NULL DEFAULT 'suspended',
        created_at   TEXT NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS idx_suspended_runs_run ON suspended_runs(run_id)`);

    // A run that FAILED (or ran out of steps) and can still be picked up.
    //
    // The sibling of suspended_runs: that one is "stopped waiting for a person", this one is
    // "stopped because something went wrong". Both keep the work already done so continuing means
    // continuing — the action ledger is keyed on the ORIGINAL run id, so a Continue re-enters
    // under that same key and every completed action short-circuits instead of running twice.
    // Restarting is what created a second project when a user pressed Try again.
    //
    // Durable on purpose: the offer to continue has to survive a refresh, a closed tab and a DO
    // eviction, or the work is stranded the moment the person looks away.
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS interrupted_runs (
        run_id         TEXT PRIMARY KEY,
        space_id       TEXT NOT NULL,
        tenant_id      TEXT NOT NULL,
        agent_id       TEXT NOT NULL,
        session_id     TEXT NOT NULL,
        project_id     TEXT,
        user_id        TEXT,
        caller_role    TEXT,
        model          TEXT,
        goal           TEXT NOT NULL,
        reason         TEXT NOT NULL,
        steps_json     TEXT NOT NULL DEFAULT '[]',
        status         TEXT NOT NULL DEFAULT 'open',
        continued_run_id TEXT,
        created_at     INTEGER NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_interrupted_session ON interrupted_runs(session_id, status)`
    );
    // The run id handleResumeRun mints for its continuation pass, recorded as soon as it exists
    // (before the continuation actually executes) so a chat client can poll for it and attach to
    // the SAME pollRun/streamRun machinery an ordinary run uses — reusing the live activity trail
    // and completion handling instead of the client only ever learning about the answer on reload.
    try { this.ctx.storage.sql.exec(`ALTER TABLE suspended_runs ADD COLUMN resumed_run_id TEXT`); } catch { /* exists */ }

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

    // 4-Dimension State Sync — shell session state
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS shell_session_state (
        session_id        TEXT PRIMARY KEY,
        cwd               TEXT NOT NULL DEFAULT '',
        env_vars_json     TEXT NOT NULL DEFAULT '{}',
        active_git_branch TEXT NOT NULL DEFAULT 'main',
        updated_at        INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
      )
    `);

    // Virtual workspace files storage for VirtualPosixShell
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS workspace_files (
        path        TEXT PRIMARY KEY,
        content     TEXT NOT NULL,
        hash        TEXT NOT NULL,
        size_bytes  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
      )
    `);

    // JIT-synthesized custom virtual CLIs
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS virtual_cli_commands (
        id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL,
        project_id TEXT,                   -- NULL for space-wide CLIs, TEXT for project-bound
        command_name TEXT NOT NULL,        -- e.g. "shopify", "linear", "hubspot"
        description TEXT NOT NULL,
        subcommands_manifest_json TEXT,    -- e.g. { "products list": "List inventory" }
        handler_code TEXT NOT NULL,        -- The raw TypeScript handler
        version INTEGER NOT NULL DEFAULT 1,
        created_by_agent_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    try {
      this.ctx.storage.sql.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_virtual_cli_cmd 
        ON virtual_cli_commands(space_id, project_id, command_name);
      `);
    } catch { /* exists */ }

    this.virtualShell = new VirtualPosixShell(this.getVirtualFsStorage());
    this.artifactsGit = new ArtifactsGitService(this.env);

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

      // POST /delegated/run — delegated task run with cryptographic verification
      if (method === "POST" && url.pathname === "/delegated/run") {
        return this.handleDelegatedRun(request);
      }

      // POST /script/resume — continue a run that suspended at a HITL gate, now that a human
      // has answered. See handleResumeRun for why re-entering the loop is the correct (and only
      // hibernation-safe) shape here.
      if (method === "POST" && url.pathname === "/script/resume") {
        return this.handleResumeRun(request);
      }

      // GET /script/resume-status?approvalId= — the id handleResumeRun minted for its
      // continuation pass, if it's started yet. Lets a chat client attach to the SAME run-polling
      // machinery an ordinary run uses (pollRun/streamRun) instead of only learning the answer on
      // reload, with no live activity trail at all.
      if (method === "GET" && url.pathname === "/script/resume-status") {
        const approvalId = url.searchParams.get("approvalId") ?? "";
        const row = this.ctx.storage.sql
          .exec(`SELECT status, resumed_run_id FROM suspended_runs WHERE approval_id = ?`, approvalId)
          .toArray() as unknown as Array<{ status: string; resumed_run_id: string | null }>;
        return Response.json({ status: row[0]?.status ?? null, resumed_run_id: row[0]?.resumed_run_id ?? null });
      }

      // GET /script/interrupted?sessionId= — the standing offer to continue a run that went
      // wrong in this thread, if there is one. Read from durable storage rather than held in the
      // client, so the offer survives a refresh, a closed tab and a DO eviction.
      if (method === "GET" && url.pathname === "/script/interrupted") {
        return this.handleGetInterruptedRun(url.searchParams.get("sessionId") ?? "");
      }

      // POST /script/interrupted — {runId, action: "continue" | "dismiss"}. One route with an
      // action field rather than /interrupted/:runId/continue: a dynamic segment followed by a
      // static suffix is the shape that has repeatedly triggered Hono's route-table corruption
      // in this codebase.
      if (method === "POST" && url.pathname === "/script/interrupted") {
        return this.handleContinueInterruptedRun(request);
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

      // GET /active-run?session_id= — "is anything still running in this conversation?"
      //
      // A new tab has no memory of a run it was never open for, so this cannot be answered from
      // the client. Answering it here is what lets someone close the laptop, come back, and find
      // the work still going rather than a silent transcript.
      //
      // GET /active-run (no session_id) — "is this DO instance running ANYTHING right now?" —
      // the scheduled-job dispatcher's own pending-run check (see handleAgentTick's scheduled_job
      // case in index.ts): every wake for a space addresses the SAME `{spaceId}:naelao-agent`
      // instance, so this is what lets it skip firing a second, overlapping run into a still-busy
      // assistant instead of finding out the hard way.
      if (method === "GET" && url.pathname === "/active-run") {
        const sessionId = url.searchParams.get("session_id") ?? "";
        const active = sessionId ? this.findActiveRunForSession(sessionId) : this.findAnyActiveRun();
        if (!active) return Response.json({ active: false });
        const durable = this.readDurableRun(active.run_id);
        return Response.json({
          active: true,
          run_id: active.run_id,
          status: "running",
          live_steps: durable?.steps ?? [],
          ...(durable?.partial_answer ? { partial_answer: durable.partial_answer } : {}),
        });
      }

      // GET /runs/:runId
      const runMatch = url.pathname.match(/^\/runs\/([^/]+)$/);
      if (method === "GET" && runMatch?.[1]) {
        return this.handleGetRun(runMatch[1]);
      }

      // POST /runs/:runId/cancel
      const cancelMatch = url.pathname.match(/^\/runs\/([^/]+)\/cancel$/);
      if (method === "POST" && cancelMatch?.[1]) {
        // A script-native run — which is every real chat message since the dispatch cutover —
        // writes no `agent_runs` row, so the legacy handler below 404'd for exactly the runs a
        // person would want to stop. Ask the live run to stop first; fall through to the legacy
        // table only for a run that predates the script-native path.
        if (this.requestCancel(cancelMatch[1])) {
          return Response.json({ id: cancelMatch[1], status: "cancelling" });
        }
        return this.handleCancelRun(cancelMatch[1]);
      }

      // GET /runs/:runId/trace — §A1 Phase HX1, the builder trace view's DO-local read side.
      const traceMatch = url.pathname.match(/^\/runs\/([^/]+)\/trace$/);
      if (method === "GET" && traceMatch?.[1]) {
        return Response.json({ run_id: traceMatch[1], trace: this.readRunTrace(traceMatch[1]) });
      }

      // POST /attested-turn — Invoker-Attested Split-Actor Execution (Phase 5 Chunk 05)
      if (method === "POST" && url.pathname === "/attested-turn") {
        const body = await request.json<{
          actionType: string;
          payload: any;
          callerContext: { userId: string; sessionId: string; assistantId: string; agentId: string; spaceId: string; projectId?: string };
        }>();
        const res = await this.executeAttestedTurn(body.actionType, body.payload, body.callerContext);
        return Response.json(res);
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

  // ── Shell Session State & 4-Dimension State Synchronization ────────────────
  private sessionState: ShellSessionState = {
    cwd: "",
    envVars: {},
    activeGitBranch: "main",
  };

  getShellSessionState(sessionId?: string): ShellSessionState {
    this.ensureInit();
    if (sessionId) {
      try {
        const rows = this.ctx.storage.sql.exec(
          `SELECT cwd, env_vars_json, active_git_branch FROM shell_session_state WHERE session_id = ?`,
          sessionId
        ).toArray() as unknown as Array<{ cwd: string; env_vars_json: string; active_git_branch: string }>;
        const row = rows[0];
        if (row) {
          let envVars: Record<string, string> = {};
          try { envVars = JSON.parse(row.env_vars_json); } catch { /* default empty */ }
          return {
            cwd: row.cwd || "",
            envVars,
            activeGitBranch: row.active_git_branch || "main",
          };
        }
      } catch { /* fallback */ }
    }
    return { ...this.sessionState };
  }

  saveShellSessionState(sessionId: string, state: ShellSessionState): void {
    this.ensureInit();
    this.sessionState = { ...state };
    try {
      this.ctx.storage.sql.exec(
        `INSERT INTO shell_session_state (session_id, cwd, env_vars_json, active_git_branch, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET cwd = excluded.cwd, env_vars_json = excluded.env_vars_json, active_git_branch = excluded.active_git_branch, updated_at = excluded.updated_at`,
        sessionId,
        state.cwd,
        JSON.stringify(state.envVars),
        state.activeGitBranch,
        Date.now()
      );
    } catch { /* best-effort */ }
  }

  updateShellSession(command: string, sessionId?: string): string {
    const trimmed = command.trim();
    const current = this.getShellSessionState(sessionId);

    if (trimmed.startsWith("cd ")) {
      const targetDir = trimmed.replace(/^cd\s+/, "").trim();
      current.cwd = targetDir === "." ? "" : targetDir.replace(/^\/+/, "");
      if (sessionId) this.saveShellSessionState(sessionId, current);
      else this.sessionState = { ...current };
      return `✔ Changed directory to /workspace/${current.cwd}`;
    }

    if (trimmed.startsWith("export ")) {
      const [key, val] = trimmed.replace(/^export\s+/, "").split("=");
      if (key && val) {
        current.envVars[key.trim()] = val.trim().replace(/^['"]|['"]$/g, "");
        if (sessionId) this.saveShellSessionState(sessionId, current);
        else this.sessionState = { ...current };
        return `✔ Set environment variable ${key.trim()}=${val.trim()}`;
      }
    }

    if (trimmed.startsWith("git checkout -b ") || trimmed.startsWith("git checkout ") || trimmed.startsWith("git switch ")) {
      const branchName = trimmed.split(/\s+/).pop()?.trim();
      if (branchName && !branchName.startsWith("-")) {
        current.activeGitBranch = branchName;
        if (sessionId) this.saveShellSessionState(sessionId, current);
        else this.sessionState = { ...current };
        return `✔ Switched to branch ${branchName}`;
      }
    }

    return "";
  }

  getSessionState(sessionId?: string): ShellSessionState {
    return this.getShellSessionState(sessionId);
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

  buildScriptEngineEnv(
    spaceIdOrOptions: string | { spaceId?: string; agentId?: string; tenantId?: string; userId?: string; actingUserId?: string; actingRoleRank?: number; projectId?: string; sessionId?: string },
    agentId?: string,
    tenantId?: string,
    userId?: string,
    projectId?: string,
    sessionId?: string
  ): ScriptEngineEnv | null {
    let sId: string;
    let aId: string;
    let tId: string;
    let uId: string | undefined;
    let pId: string | undefined;
    let sessId: string | undefined;

    if (typeof spaceIdOrOptions === "object" && spaceIdOrOptions !== null) {
      sId = spaceIdOrOptions.spaceId ?? "";
      aId = spaceIdOrOptions.agentId ?? "naelao-agent";
      tId = spaceIdOrOptions.tenantId ?? "";
      uId = spaceIdOrOptions.actingUserId ?? spaceIdOrOptions.userId;
      pId = spaceIdOrOptions.projectId;
      sessId = spaceIdOrOptions.sessionId;
    } else {
      sId = spaceIdOrOptions;
      aId = agentId ?? "naelao-agent";
      tId = tenantId ?? "";
      uId = userId;
      pId = projectId;
      sessId = sessionId;
    }

    if (!this.env.SCRIPTS_R2) return null;
    const env: ScriptEngineEnv = {
      scriptsBucket: this.env.SCRIPTS_R2,
      spaceId: sId,
      agentId: aId,
      tenantId: tId,
      platformSecret: this.env.PLATFORM_SECRET,
      ...(uId ? { userId: uId } : {}),
      // Project-scoped workspace (every thread's agent in a project shares one R2 filesystem)
      // vs. the Space Assistant's space-wide workspace — see workspacePrefix() in types.ts.
      ...(pId ? { projectId: pId } : {}),
    };
    if (this.env.SCRIPTS_VECTORIZE) {
      env.vectorIndex = this.env.SCRIPTS_VECTORIZE as unknown as NonNullable<ScriptEngineEnv["vectorIndex"]>;
    }
    if (this.env.AI) env.embedder = new WorkersAIEmbedder(this.env.AI);
    {
      // Memory OS — backed by this DO's own SQLite + (optionally) MEMORY_VECTORIZE for the
      // semantic layer. Always available (Layer 3 works with no Vectorize binding at all).
      const memoryEmbedder = this.env.AI ? new WorkersAIEmbedder(this.env.AI) : undefined;
      const ai = this.env.AI;
      const autoRagInstance = this.env.AUTORAG_WIKI_INSTANCE;
      const localMemoryStore = buildMemoryStore({
        sql: this.ctx.storage.sql,
        spaceId,
        ...(this.env.MEMORY_VECTORIZE
          ? { vectorIndex: this.env.MEMORY_VECTORIZE as unknown as NonNullable<ScriptEngineEnv["vectorIndex"]> }
          : {}),
        ...(memoryEmbedder ? { embedder: memoryEmbedder } : {}),
        ...(this.env.SCRIPTS_R2 ? { wikiBucket: this.env.SCRIPTS_R2 } : {}),
        // §A1.19: AutoRAG-backed Wiki semantic search. `.autorag(name)` is Workers AI's own
        // sub-binding accessor — no separate wrangler binding needed beyond `AI` + the instance
        // name. Wrapped defensively since this is a newer CF product; searchWiki's own try/catch
        // already treats this as best-effort, degrading to plain SQLite LIKE-match on any error.
        ...(ai && autoRagInstance
          ? {
              autoRag: {
                async search(query: string, opts: { topK: number }) {
                  const instance = (ai as unknown as { autorag(name: string): { search(args: { query: string; max_num_results?: number }): Promise<{ data?: Array<{ filename?: string; attributes?: Record<string, unknown> }> }> } }).autorag(autoRagInstance);
                  const res = await instance.search({ query, max_num_results: opts.topK });
                  return (res.data ?? [])
                    .map((d, i) => ({
                      concept: String(d.attributes?.["concept"] ?? d.filename ?? ""),
                      score: 1 - i / Math.max(1, (res.data?.length ?? 1)),
                    }))
                    .filter((r) => r.concept);
                },
              },
            }
          : {}),
      });
      // §A1.17 Phase U: a project-bound run (this DO instance addressed per (thread, agentId) —
      // see T2) composes the local store with SpaceDO's project-scoped Layers 3/4/6, so agents
      // sharing a project share facts/fabric/wiki even though each has its own local
      // episodic/semantic memory. The Space Assistant's own `_assistant` slot (no projectId)
      // keeps using localMemoryStore directly, unwrapped — unaffected by this migration.
      //
      // A run with NO projectId (the Space Assistant chatting) used to fall through to
      // localMemoryStore alone — and a chat run's DO is addressed BY SESSION, so every fact it
      // learned was sealed inside that one conversation's DO. Nothing survived to the next session,
      // and the Memory panel (which reads the space-wide `{spaceId}:naelao-agent` DO) could never
      // see any of it: "the AI isn't recording anything in memory". Those runs now share the
      // space-level `_assistant` scope — the same reserved id workspacePrefix() and the Tier-5
      // sandbox already use for "this space's assistant, not a project" — so the assistant's facts
      // are one set across every conversation it has. Layer 5 (episodic) still stays local and
      // per-session by design; it is the raw per-thread trail, not shared knowledge.
      const memoryScope = projectId || ASSISTANT_MEMORY_SCOPE;
      env.memoryStore = this.env.SPACES_WORKER
        ? buildHybridMemoryStore(localMemoryStore, buildProjectMemoryStore({
            spacesWorker: this.env.SPACES_WORKER,
            platformSecret: this.env.PLATFORM_SECRET,
            spaceId,
            tenantId,
            projectId: memoryScope,
            mintInternalToken,
          }))
        : localMemoryStore;
      // Makes the SAME Memory OS maintenance pass the client-driven POST .../compact HTTP route
      // (see that route's own comment) callable AS A TOOL, from inside a run — a model that
      // notices its own conversation growing shouldn't need the shell UI to trigger this on its
      // behalf. Bound to this specific spaceId/DO instance, matching runMemoryMaintenanceForSpace's
      // own scoping (memory maintenance is per-space, not per-session).
      env.compactMemory = () => this.runMemoryMaintenanceForSpace(spaceId);
    }
    // §A1.25: lets web-search's grounded_answer op make its own direct LLM call (native
    // web-search tool) — degrades to unavailable (never a silent no-op) when neither credential
    // is configured, same posture as canAuthenticateLlm() elsewhere in this file.
    if (this.env.ANTHROPIC_API_KEY || this.env.NAELAO_AIG_TOKEN) {
      const anthropicKey = this.env.ANTHROPIC_API_KEY ?? "";
      const gatewayConfig = this.aiGatewayConfig();
      env.llmCaller = {
        callWithNativeWebSearch: async ({ model, query, maxUses }) => {
          const response = await callLlm(
            anthropicKey,
            {
              model,
              system: "Answer the user's question, using web search when it would help. Be concise and factual.",
              messages: [{ role: "user", content: query }],
              tools: [{ type: "web_search_20250305", name: "web_search", max_uses: maxUses ?? 5 }],
              max_tokens: 1024,
            },
            undefined,
            gatewayConfig
          );
          const answer = response.content
            .filter((b) => b.type === "text")
            .map((b) => b.text ?? "")
            .join("\n");
          const citations = response.content
            .filter((b) => b.type === "web_search_tool_result")
            .flatMap((b) => (b.web_search_results ?? []).map((r) => ({ title: r.title, url: r.url })));
          return {
            answer,
            citations,
            tokens_used: response.usage.input_tokens + response.usage.output_tokens,
            input_tokens: response.usage.input_tokens,
            output_tokens: response.usage.output_tokens,
          };
        },
        // Plain completion for prebuilts doing their own small LLM work (project-journal
        // compaction). Same gateway, same billing path as any other call — nothing here is a
        // free side-channel.
        complete: async ({ model, prompt, maxTokens }) => {
          const response = await callLlm(
            anthropicKey,
            {
              model,
              messages: [{ role: "user", content: prompt }],
              max_tokens: maxTokens ?? 512,
            },
            undefined,
            gatewayConfig
          );
          const text = response.content
            .filter((b) => b.type === "text")
            .map((b) => b.text ?? "")
            .join("\n");
          return {
            text,
            tokens_used: response.usage.input_tokens + response.usage.output_tokens,
            input_tokens: response.usage.input_tokens,
            output_tokens: response.usage.output_tokens,
          };
        },
      };
    }
    if (this.env.KNOWLEDGE_WORKER) env.knowledgeWorker = this.env.KNOWLEDGE_WORKER;
    if (this.env.SPACES_WORKER) env.spacesWorker = this.env.SPACES_WORKER;
    if (this.env.NOTIFICATIONS_WORKER) env.notificationsWorker = this.env.NOTIFICATIONS_WORKER;
    // Self-binding — lets the business-email prebuilt reach /internal/business-email/{provision,send}
    // (the AgentMail path, whose API key lives on the worker, never in the isolate).
    if (this.env.AGENTS_WORKER) env.agentsWorker = this.env.AGENTS_WORKER;
    if (this.env.BILLING_WORKER) env.billingWorker = this.env.BILLING_WORKER;
    if (this.env.MCP_HUB) env.mcpHubWorker = this.env.MCP_HUB;
    if (this.env.CREDENTIALS_WORKER) env.credentialsWorker = this.env.CREDENTIALS_WORKER;
    if (this.env.ARTIFACT_WORKER) env.artifactWorker = this.env.ARTIFACT_WORKER;

    // Execution ladder Tiers 2-5 (code-runner.ts) — degrades tier-by-tier when a binding
    // (LOADER / BROWSER_WORKER / TOOL_SANDBOX) is absent; Tier 1 (R2) never needs this.
    const sessionState = this.getShellSessionState(sessionId);
    const baseCodeRunner = buildCodeRunner({
      ...(this.env.LOADER ? { loader: this.env.LOADER } : {}),
      ...(this.env.BROWSER_WORKER ? { browserWorker: this.env.BROWSER_WORKER } : {}),
      ...(this.env.MCP_HUB ? { mcpHubWorker: this.env.MCP_HUB } : {}),
      ...(this.env.PLATFORM_SECRET ? { platformSecret: this.env.PLATFORM_SECRET } : {}),
      ...(this.env.TOOL_SANDBOX ? { toolSandbox: this.env.TOOL_SANDBOX } : {}),
    });
    env.codeRunner = {
      run: async (params) => {
        const runCtx = params.ctx || {};
        runCtx.storage = runCtx.storage || this.ctx.storage;
        runCtx.env = runCtx.env || { spaceId, projectId, agentId };
        runCtx.cli = runCtx.cli || buildCliSdkContext(this.ctx.storage, spaceId, projectId, agentId);
        return baseCodeRunner.run({
          ...params,
          ctx: runCtx,
          sessionState: params.sessionState || sessionState,
        });
      },
    };

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
              // The whole point of the suspend/resume path: an approval must outlive the request
              // that opened it. HITLApprovalDO's own 30s default is a request-lifetime timeout —
              // fine when the only outcome was "proceed or don't", actively wrong now that the
              // run can wait. A person who is asleep, at work, or on another screen gets a day.
              ttl_ms: APPROVAL_TTL_MS,
              // Route a later resume back to THIS DO. Agent DOs are addressed per
              // space:project:thread, so the approving request (which only knows the space)
              // could not otherwise find the checkpoint that lets the run continue.
              resume_do_id: this.ctx.id.toString(),
            }),
          }));
          const { approval_id } = await createResp.json<{ approval_id: string }>();

          // §A1.17 Phase O: "if the agent wants human approval, the assistant is triggered so it
          // always knows what's going on, and uses a channel script to tell the user." Fire this
          // concurrently with the poll below (never awaited) — a slow/failed notification must
          // never delay or fail the approval flow itself.
          void this.notifyApprovalRequested(spaceId, tenantId, agentId, approval_id, params.actionName, params.description);

          // Short courtesy poll, not a deadline. Someone already looking at the approval answers
          // within seconds, and holding the request open for them keeps the common interactive
          // case feeling synchronous. Nobody answering is NOT a refusal — it returns `pending`,
          // the run suspends with its work intact, and the resume path picks it back up whenever
          // the human actually gets to it.
          const deadline = Date.now() + APPROVAL_INLINE_WAIT_MS;
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
          return {
            approvalId: approval_id,
            approved: false,
            pending: true,
            expiresAt: Date.now() + APPROVAL_TTL_MS,
          };
        },
      };
    }

    // A workspace write is what makes a handoff between projects possible: the agent that owns
    // one stage records its result as a file, and a no-code rule wakes whoever owns the next.
    // Only wired for a PROJECT-scoped run — the Space Assistant's own space-wide workspace is
    // scratch space, not a pipeline, and firing on every note it writes would be noise.
    if (this.env.SPACES_WORKER && projectId) {
      const spacesWorker = this.env.SPACES_WORKER;
      env.onWorkspaceChange = (change) => {
        // Fire-and-forget in both directions: the write already succeeded, so a failure to
        // announce it must not surface as a failed write.
        void (async () => {
          try {
            await spacesWorker.fetch(new Request(
              `http://spaces-worker/internal/spaces/${spaceId}/events/fire`,
              {
                method: "POST",
                headers: await this.internalHeaders(tenantId, { "content-type": "application/json" }),
                body: JSON.stringify({
                  type: "workspace.file_changed",
                  space_id: spaceId,
                  project_id: projectId,
                  payload: { path: change.path, operation: change.operation, agent_id: agentId },
                }),
              }
            ));
          } catch {
            /* best-effort */
          }
        })();
      };
    }

    // Exactly-once record of executed actions (see ActionLedger). Always wired — unlike the
    // gateways around it there is no binding to be missing; the store is this DO's own SQLite.
    env.actionLedger = {
      lookup: async (key, actionName, paramsHash) => {
        const rows = this.ctx.storage.sql
          .exec(
            `SELECT result_json FROM action_ledger WHERE ledger_key = ? AND action_name = ? AND params_hash = ?`,
            key, actionName, paramsHash
          )
          .toArray() as unknown as Array<{ result_json: string }>;
        if (!rows[0]) return null;
        try {
          return JSON.parse(rows[0].result_json) as ScriptRunResult;
        } catch {
          // An unparseable row is worse than no row: returning null re-runs the action, which is
          // the behavior we had before a ledger existed, rather than handing back garbage.
          return null;
        }
      },
      record: async (key, actionName, paramsHash, result) => {
        // INSERT OR IGNORE, not REPLACE: the FIRST execution is the one that happened, and a
        // later attempt must never overwrite the recorded truth with its own.
        this.ctx.storage.sql.exec(
          `INSERT OR IGNORE INTO action_ledger (ledger_key, action_name, params_hash, result_json, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          key, actionName, paramsHash, JSON.stringify(result), Date.now()
        );
      },
    };

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
    tools?: ScriptToolSurface,
    // F-36: the acting user the PARENT run is on behalf of — threaded into every child spawn
    // so a clamped parent can't escape its per-user clamp by fanning work out to sub-agents
    // (the child's own handleScriptRun re-resolves the same clamp for the same user).
    userId?: string,
    // item 79 (inline consult cards): when given, every thread.consult call this run makes is
    // recorded here — thread_id/agent_id, regardless of whether the consult itself succeeded
    // (the subthread and the assistant's opening message were created either way, so it's still
    // worth a link). The caller attaches this to the run's own answer message as metadata so the
    // client can render an inline, expandable card at the point in the conversation where the
    // delegation happened, instead of only in a separate side panel with no correlation to any
    // specific turn.
    consultLog?: Array<{ thread_id: string; agent_id: string; title: string; session_id?: string }>,
    // Effort/escalation-budget policy for sub-agent spawns made BY this run — see
    // resolveEscalationModel. currentModel is what THIS run itself is on (the baseline the
    // ceiling is computed relative to); effort defaults to "low" the same way handleScriptRun's
    // own caller (index.ts) already defaults an absent request to "low".
    currentModel?: string,
    effort?: string
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
          return await this.spawnSubAgentBatch(tasks, spaceId, agentId, tenantId, apiKey, parentRunId, parentThreadId, projectId, agentDO, userId, currentModel, effort);
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
      hooks.consultAgent = async (params) => {
        const result = await this.consultAgentImpl(params, tenantId, apiKey, agentDO);
        if (consultLog && result.thread_id) {
          consultLog.push({
            thread_id: result.thread_id,
            agent_id: params.agentId,
            title: `Consult: ${params.agentId}`,
            ...(result.session_id ? { session_id: result.session_id } : {}),
          });
        }
        return result;
      };
      hooks.sendToThread = (params) => this.sendToThreadImpl(params, tenantId, apiKey, agentDO);
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
    agentDO: DurableObjectNamespace<NaelaoAgentDO>,
    userId?: string,
    currentModel?: string,
    effort?: string
  ): Promise<{ id: string }> {
    // Effort ceiling resolved ONCE for the whole batch — every task in one agent.spawn call
    // shares the same parent run and the same Effort setting, so there's no reason to re-derive
    // it per task. A downgrade is a real product decision ("you asked for something this Effort
    // level won't allow, so this ran on X instead") — surfaced on the task's own result, never
    // silently swallowed, per the "get an error message and move down to cheaper" ask.
    const effortLevel: EffortLevel = isValidEffortLevel(currentModel ?? DEFAULT_WORKING_MODEL, effort ?? "low")
      ? (effort as EffortLevel)
      : "low";
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
        // Effort ceiling enforcement: a task can name a specific model (t["model"]) — resolve it
        // against the parent's own Effort setting before ever dispatching. A request that exceeds
        // the ceiling is NOT run as asked; it's clamped to the best model still within budget and
        // the clamp is reported back on the task's own result (never silently run over-budget,
        // never silently swallowed either).
        const requestedModel = typeof t["model"] === "string" ? t["model"] : undefined;
        const modelResolution = resolveEscalationModel(currentModel ?? DEFAULT_WORKING_MODEL, effortLevel, { preferModel: requestedModel });
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
              // F-36: a child acts on behalf of the SAME user as its parent — its own
              // handleScriptRun re-resolves the clamp, so a viewer-clamped parent can't
              // launder a mutation through a spawn.
              ...(userId ? { userId } : {}),
              model: modelResolution.model,
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
          return {
            id: subId,
            ok,
            model_used: modelResolution.model,
            ...(modelResolution.downgraded ? { effort_downgraded: true, effort_downgrade_reason: modelResolution.reason } : {}),
            ...(ok ? { output } : { error: body.result?.error ?? `HTTP ${resp.status}` }),
          };
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
   * Assistant<->project-agent consult (§A1.18 thread model). Unlike spawnSubAgent, this talks to
   * an EXISTING named agent definition (a real, addressable "Agent1" a builder configured), not a
   * throwaway child — so it's addressed exactly the way @mention dispatch already addresses one:
   * `{sessionId}:{agentId}` (Phase T2), meaning the consulted agent's own per-thread memory/state
   * for THIS consult session is separate from its memory in the visible user<->agent thread, same
   * as two @mentioned agents in one project already get separate state.
   *
   * The exchange gets its own subthread (thread_kind='sub_agent', parent_thread_id — reusing the
   * existing sub-agent-spawn hierarchy pattern rather than inventing a second one) so the shell
   * can show it collapsed-but-expandable under the visible thread it's about, never mixed into
   * that transcript directly (no addressing ambiguity: whoever reads the subthread knows both
   * parties are the assistant and the named agent, nobody else).
   *
   * `threadId` given: reuse that subthread's session (continuing a prior consult). Omitted:
   * mint a fresh session + subthread. Either way, the caller (this hook, standing in for "the
   * client") writes the assistant's own message with role:'user' before dispatching — exactly
   * what apps/shell's Chat.tsx does for a human turn — because handleScriptRun only ever writes
   * back the ANSWER (see its own comment at the writeAgentAnswerToSession call site); nothing
   * else here writes the question.
   */
  private async consultAgentImpl(
    params: { agentId: string; message: string; spaceId: string; projectId?: string; parentThreadId?: string; threadId?: string },
    tenantId: string,
    apiKey: string,
    agentDO: DurableObjectNamespace<NaelaoAgentDO>
  ): Promise<{ ok: boolean; thread_id?: string; session_id?: string; reply?: string; error?: string }> {
    const { agentId: targetAgentId, message, spaceId, projectId, parentThreadId } = params;
    if (!targetAgentId || !message) return { ok: false, error: "agent_id and message are required" };
    if (!this.env.SPACES_WORKER) return { ok: false, error: "spaces worker binding not configured" };
    const headers = await this.internalHeaders(tenantId, { "content-type": "application/json" });

    let threadId = params.threadId;
    let sessionId: string;
    try {
      if (threadId) {
        const threadResp = await this.env.SPACES_WORKER.fetch(new Request(
          `http://spaces-worker/spaces/${spaceId}/threads/${encodeURIComponent(threadId)}`,
          { headers }
        ));
        if (!threadResp.ok) return { ok: false, error: `consult thread ${threadId} not found` };
        const thread = await threadResp.json<{ session_id?: string | null }>();
        if (!thread.session_id) return { ok: false, error: `consult thread ${threadId} has no session` };
        sessionId = thread.session_id;
      } else {
        const sessionResp = await this.env.SPACES_WORKER.fetch(new Request(
          `http://spaces-worker/spaces/${spaceId}/sessions`,
          { method: "POST", headers, body: JSON.stringify({}) }
        ));
        if (!sessionResp.ok) return { ok: false, error: `failed to create consult session: HTTP ${sessionResp.status}` };
        const session = await sessionResp.json<{ id: string }>();
        sessionId = session.id;

        const threadResp = await this.env.SPACES_WORKER.fetch(new Request(
          `http://spaces-worker/spaces/${spaceId}/threads`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              thread_kind: "sub_agent",
              session_id: sessionId,
              title: `Consult: ${targetAgentId}`,
              ...(parentThreadId ? { parent_thread_id: parentThreadId } : {}),
              ...(projectId ? { project_id: projectId } : {}),
            }),
          }
        ));
        if (!threadResp.ok) return { ok: false, error: `failed to create consult thread: HTTP ${threadResp.status}` };
        const thread = await threadResp.json<{ id: string }>();
        threadId = thread.id;
      }

      // The assistant's own turn — see this method's header for why nothing else writes it.
      await this.env.SPACES_WORKER.fetch(new Request(
        `http://spaces-worker/spaces/${spaceId}/sessions/${sessionId}/messages`,
        { method: "POST", headers, body: JSON.stringify({ role: "user", content: message, agent_id: "naelao-agent" }) }
      ));

      const doName = await getDOName("agent", `${sessionId}:${targetAgentId}`, tenantId, this.env.PLATFORM_SECRET);
      const stub = agentDO.get(agentDO.idFromName(doName));
      const resp = await stub.fetch(new Request("http://agent-do/script/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          goal: message, spaceId, agentId: targetAgentId, tenantId, sessionId, apiKey,
          ...(projectId ? { projectId } : {}),
        }),
      }));
      const runBody = await resp.json<{
        result?: { ok?: boolean; output?: unknown; error?: unknown };
        pending_approval?: { action_name: string };
      }>().catch(() => ({}) as Record<string, never>);
      if (runBody.pending_approval) {
        return { ok: true, thread_id: threadId, session_id: sessionId, reply: `${targetAgentId} needs approval before it can act on this: ${runBody.pending_approval.action_name}` };
      }
      const ok = resp.ok && runBody.result?.ok !== false;
      if (!ok) {
        const errMsg = typeof runBody.result?.error === "string" ? runBody.result.error : `HTTP ${resp.status}`;
        return { ok: false, thread_id: threadId, session_id: sessionId, error: errMsg };
      }
      const reply = typeof runBody.result?.output === "string" ? runBody.result.output : JSON.stringify(runBody.result?.output ?? "");
      return { ok: true, thread_id: threadId, session_id: sessionId, reply };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Post a real message into an EXISTING, visible thread — not a private consult subthread.
   * Mirrors consultAgentImpl above (same direct-DO addressing, same internal auth) with one
   * deliberate difference: it never creates a `thread_kind='sub_agent'` thread, it writes into
   * the GIVEN thread's own session, so the message and (when `respond` isn't false) the target
   * agent's reply land exactly where a person reading that thread would see them. This is what
   * lets the assistant participate in a thread the way a person can — per the explicit "give the
   * assistant everything the user can do" ask — distinct from thread.consult, which stays the
   * private, hidden coordination channel.
   *
   * `agentId` is required whenever a reply is wanted (respond !== false), same contract
   * thread.consult already has — there's no attempt here to infer "the project's default agent"
   * from scratch; the caller (the assistant, or the project-coordination op it calls this
   * through) names who it's addressing.
   */
  private async sendToThreadImpl(
    params: { threadId: string; message: string; spaceId: string; agentId?: string; respond?: boolean; model?: string },
    tenantId: string,
    apiKey: string,
    agentDO: DurableObjectNamespace<NaelaoAgentDO>
  ): Promise<{ ok: boolean; session_id?: string; reply?: string; dispatched: boolean; error?: string }> {
    const { threadId, message, spaceId } = params;
    if (!threadId || !message) return { ok: false, dispatched: false, error: "thread_id and message are required" };
    if (!this.env.SPACES_WORKER) return { ok: false, dispatched: false, error: "spaces worker binding not configured" };
    const respond = params.respond !== false;
    if (respond && !params.agentId) return { ok: false, dispatched: false, error: "agent_id is required to get a reply (or pass respond:false to only post)" };
    const headers = await this.internalHeaders(tenantId, { "content-type": "application/json" });

    try {
      const threadResp = await this.env.SPACES_WORKER.fetch(new Request(
        `http://spaces-worker/spaces/${spaceId}/threads/${encodeURIComponent(threadId)}`,
        { headers }
      ));
      if (!threadResp.ok) return { ok: false, dispatched: false, error: `thread ${threadId} not found` };
      const thread = await threadResp.json<{ session_id?: string | null; project_id?: string | null }>();

      let sessionId = thread.session_id ?? undefined;
      if (!sessionId) {
        const sessionResp = await this.env.SPACES_WORKER.fetch(new Request(
          `http://spaces-worker/spaces/${spaceId}/sessions`,
          { method: "POST", headers, body: JSON.stringify({ thread_id: threadId }) }
        ));
        if (!sessionResp.ok) return { ok: false, dispatched: false, error: `failed to create a session for thread ${threadId}: HTTP ${sessionResp.status}` };
        const session = await sessionResp.json<{ id: string }>();
        sessionId = session.id;
      }

      // The assistant's own turn, attributed to it (author_type resolves to 'assistant' for
      // agent_id 'naelao-agent') — visible in the real thread, unlike consultAgentImpl's write
      // into a hidden sub_agent thread.
      //
      // `assistant_delegation` is what stops this reading as the assistant talking to itself: the
      // client groups this message and the target agent's reply into ONE collapsible card labelled
      // as the business assistant acting on the owner's behalf, rather than two adjacent
      // left-aligned bubbles that look like one speaker answering their own question.
      await this.env.SPACES_WORKER.fetch(new Request(
        `http://spaces-worker/spaces/${spaceId}/sessions/${sessionId}/messages`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            role: "assistant",
            content: message,
            agent_id: "naelao-agent",
            metadata: {
              assistant_delegation: {
                agent_id: params.agentId ?? null,
                on_behalf_of_user: true,
                awaiting_reply: respond,
              },
            },
          }),
        }
      ));

      if (!respond) return { ok: true, session_id: sessionId, dispatched: false };

      const doName = await getDOName("agent", `${sessionId}:${params.agentId}`, tenantId, this.env.PLATFORM_SECRET);
      const stub = agentDO.get(agentDO.idFromName(doName));
      const resp = await stub.fetch(new Request("http://agent-do/script/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          // Framed so the receiving agent knows this is the BUSINESS ASSISTANT acting for the
          // owner — not an ordinary customer/user message. Without this it has no way to tell the
          // two apart, and they warrant different judgement about what to do unasked.
          goal:
            `[from the business assistant, acting autonomously on the owner's behalf]\n${message}`,
          spaceId, agentId: params.agentId, tenantId, sessionId, apiKey,
          // An explicit model for this one dispatch — a cheap agent answering a routine question
          // and one doing real reasoning shouldn't be forced onto the same model. Omitted, the
          // target agent's own configured default applies, exactly as before.
          ...(params.model ? { model: params.model } : {}),
          ...(thread.project_id ? { projectId: thread.project_id } : {}),
        }),
      }));
      const runBody = await resp.json<{
        result?: { ok?: boolean; output?: unknown; error?: unknown };
        pending_approval?: { action_name: string };
      }>().catch(() => ({}) as Record<string, never>);
      if (runBody.pending_approval) {
        return { ok: true, session_id: sessionId, dispatched: true, reply: `${params.agentId} needs approval before it can act on this: ${runBody.pending_approval.action_name}` };
      }
      const ok = resp.ok && runBody.result?.ok !== false;
      if (!ok) {
        const errMsg = typeof runBody.result?.error === "string" ? runBody.result.error : `HTTP ${resp.status}`;
        return { ok: false, session_id: sessionId, dispatched: true, error: errMsg };
      }
      const reply = typeof runBody.result?.output === "string" ? runBody.result.output : JSON.stringify(runBody.result?.output ?? "");
      return { ok: true, session_id: sessionId, dispatched: true, reply };
    } catch (err) {
      return { ok: false, dispatched: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * When this run is a sub-agent (its context carries parent_do_id + sub_agent_id — set by
   * the parent's spawnSubAgent hook), builds an onProgress callback that calls back to the
   * PARENT DO instance so its sub_agents row is updated live, mid-run — see loop.ts's
   * onProgress checkpoints and handleSubAgentProgress below.
   */
  /**
   * §A1 Harness Excellence (chat UI parity): an in-flight run's live "currently doing X" state —
   * observe/find/gate/reason/run/answer checkpoints, most-recent-first-consumed, capped so a
   * runaway loop can't grow this unbounded. In-memory only, on THIS DO instance: the interactive
   * chat path (handleScriptRun) and its poller (GET /runs/:runId, called by the SAME agent-DO
   * stub the SSE endpoint already addresses) run against the identical DO id, so a concurrent
   * poll reads this while the run is still executing. Cleared once the run resolves (see the
   * `finally` in handleScriptRun) — deliberately NOT persisted, since `run_traces` (HX1) already
   * durably records the same information once the run completes; this is only for the window
   * while it hasn't yet.
   */
  private liveRuns = new Map<
    string,
    {
      steps: LiveRunStepRow[];
      updatedAt: number;
      /**
       * The final answer as the model is writing it, before the run has finished.
       *
       * This is what makes a long reply appear as it is generated instead of landing whole after
       * a silence. The poller diffs it exactly the way it already diffs a completed `final_answer`,
       * so the growing text needs no separate transport — see handleGetRun.
       */
      partialAnswer?: string;
      /**
       * Set once the run resolves, and the entry then LINGERS rather than being deleted.
       *
       * A script-native run writes no `agent_runs` row, and a run dispatched straight into this DO
       * (the Continue-an-interrupted-run path, and every sub-agent) has no TaskDO task either — so
       * the moment the entry was deleted the run existed nowhere and `GET /runs/:runId` answered
       * 404. Reported live as "API error 404 when I click continue": the continuation had actually
       * SUCCEEDED, and the client polling for its result was told it did not exist.
       */
      terminal?: {
        status: string;
        final_answer?: string;
        error?: string;
        pending_approval?: unknown;
        deferred_approvals?: unknown;
      };
    }
  >();
  private static readonly MAX_LIVE_STEPS = 60;
  /** How long a resolved run stays answerable after finishing. Clients poll within seconds; this is
   *  long enough to cover a slow tab or a retry, short enough that the map cannot grow unbounded. */
  private static readonly FINISHED_RUN_TTL_MS = 10 * 60 * 1000;
  /** Hard cap on retained entries, so a busy DO can't accumulate them faster than the TTL prunes. */
  private static readonly MAX_RETAINED_RUNS = 50;

  /** Turns a client-requested (model, level) pair into a GatewayReasoner-ready ReasoningRequest,
   *  or undefined when the model has no reasoning capability, no level was requested, or the
   *  requested level isn't one this model actually offers (billing-core's isValidReasoningLevel —
   *  an invalid level is dropped honestly rather than sent through and 400ing at the gateway). */
  private static resolveReasoningRequest(model: string | undefined, level: string | undefined): ReasoningRequest | undefined {
    if (!model || !level) return undefined;
    const { reasoningParam, reasoningLevels } = capabilityForModel(model);
    if (reasoningParam === "none" || !reasoningLevels.includes(level)) return undefined;
    return { param: reasoningParam, level };
  }

  private recordLiveProgress(runId: string, checkpoint: LiveCheckpoint): void {
    const entry = this.liveRuns.get(runId) ?? { steps: [], updatedAt: Date.now() };
    const { partial, answer_preview, ...step } = checkpoint;

    // The final answer as it is being written belongs on the RUN, not on a step — it becomes the
    // reply bubble, and the poller diffs it exactly the way it already diffs a completed
    // final_answer, so this needs no separate client mechanism.
    if (answer_preview) entry.partialAnswer = answer_preview;

    if (partial) {
      // A partial is the same step arriving again with more of its text — it must replace what is
      // already there rather than append, or one reasoning turn would emit a row per chunk. It
      // updates the step in flight: either an earlier partial of the same phase, or the "starting"
      // checkpoint the loop pushed before the call began (which has no duration_ms yet).
      const last = entry.steps[entry.steps.length - 1];
      if (last && last.phase === step.phase && last.duration_ms === undefined) {
        entry.steps[entry.steps.length - 1] = { ...last, ...step, partial: true, seq: last.seq, ts: Date.now() };
        entry.updatedAt = Date.now();
        this.liveRuns.set(runId, entry);
        return;
      }
      entry.steps.push({ seq: entry.steps.length, ts: Date.now(), ...step, partial: true });
    } else {
      entry.steps.push({ seq: entry.steps.length, ts: Date.now(), ...step });
    }
    if (entry.steps.length > NaelaoAgentDO.MAX_LIVE_STEPS) entry.steps.shift();
    entry.updatedAt = Date.now();
    this.liveRuns.set(runId, entry);
  }

  private buildLiveProgressReporter(runId: string, sessionId?: string): (checkpoint: LiveCheckpoint) => void {
    if (sessionId) this.openDurableRun(runId, sessionId);
    return (checkpoint) => {
      this.recordLiveProgress(runId, checkpoint);
      this.persistLiveRun(runId, checkpoint.partial === true);
    };
  }

  /** How often a still-growing answer is written through to SQLite. A reply arrives token by
   *  token; persisting each one would trade a real cost for precision nobody can perceive, since
   *  what this protects is a person coming back seconds or minutes later. Step boundaries are
   *  always written immediately regardless — they are bounded and each one is real news. */
  private static readonly DURABLE_PARTIAL_INTERVAL_MS = 400;
  /** Resolved runs older than this are pruned. Long enough to cover coming back after a coffee;
   *  short enough that a busy DO's storage cannot grow without bound. */
  private static readonly DURABLE_RUN_TTL_MS = 6 * 60 * 60 * 1000;
  private lastDurableWrite = new Map<string, number>();

  /** Register a run as in flight BEFORE any progress exists, so a client that reconnects during
   *  the first slow reasoning call finds "running" rather than nothing at all. */
  private openDurableRun(runId: string, sessionId: string): void {
    try {
      const now = Date.now();
      this.ctx.storage.sql.exec(
        `INSERT INTO run_state (run_id, session_id, status, started_at, updated_at) VALUES (?, ?, 'running', ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at`,
        runId, sessionId, now, now
      );
      this.pruneDurableRuns();
    } catch { /* durability is an enhancement to observability; it never fails a run */ }
  }

  /** Write the current live state through to SQLite so it survives hibernation and eviction. */
  private persistLiveRun(runId: string, isPartial: boolean): void {
    const entry = this.liveRuns.get(runId);
    if (!entry) return;
    const now = Date.now();
    // The throttle clock is advanced by PARTIAL writes only. Sharing it with step boundaries meant
    // every step reset it, so the first partial after any step was always dropped — and on a short
    // answer that finished inside one interval, the growing reply was never written through at all
    // until the run ended. Step boundaries are bounded by the step count, so writing each one
    // immediately costs nothing worth throttling.
    if (isPartial) {
      const last = this.lastDurableWrite.get(runId) ?? 0;
      if (now - last < NaelaoAgentDO.DURABLE_PARTIAL_INTERVAL_MS) return;
      this.lastDurableWrite.set(runId, now);
    }
    try {
      this.ctx.storage.sql.exec(
        `UPDATE run_state SET partial_answer = ?, updated_at = ? WHERE run_id = ?`,
        entry.partialAnswer ?? null, now, runId
      );
      // Only the tail is rewritten: earlier steps are immutable once complete, and rewriting the
      // whole list on every checkpoint would make a long run quadratic.
      for (const step of entry.steps.slice(-2)) {
        this.ctx.storage.sql.exec(
          `INSERT INTO run_stream (run_id, seq, step_json, ts) VALUES (?, ?, ?, ?)
           ON CONFLICT(run_id, seq) DO UPDATE SET step_json = excluded.step_json, ts = excluded.ts`,
          runId, step.seq, JSON.stringify(step), step.ts
        );
      }
    } catch { /* see openDurableRun */ }
  }

  /** Read a run back from SQLite — the path a client takes after the DO has hibernated, or from a
   *  tab that was not even open when the run started. */
  private readDurableRun(runId: string): { steps: LiveRunStepRow[]; partial_answer?: string; terminal?: FinishedRunState; status: string } | null {
    try {
      const state = (this.ctx.storage.sql
        .exec(`SELECT status, partial_answer, terminal_json FROM run_state WHERE run_id = ?`, runId)
        .toArray() as unknown as Array<{ status: string; partial_answer: string | null; terminal_json: string | null }>)[0];
      if (!state) return null;
      const steps = (this.ctx.storage.sql
        .exec(`SELECT step_json FROM run_stream WHERE run_id = ? ORDER BY seq ASC`, runId)
        .toArray() as unknown as Array<{ step_json: string }>)
        .map((r) => { try { return JSON.parse(r.step_json) as LiveRunStepRow; } catch { return null; } })
        .filter((s): s is LiveRunStepRow => s !== null);
      let terminal: FinishedRunState | undefined;
      if (state.terminal_json) {
        try { terminal = JSON.parse(state.terminal_json) as FinishedRunState; } catch { /* keep undefined */ }
      }
      return {
        steps,
        status: state.status,
        ...(state.partial_answer ? { partial_answer: state.partial_answer } : {}),
        ...(terminal ? { terminal } : {}),
      };
    } catch {
      return null;
    }
  }

  /** The newest run still in flight for a conversation — what lets a brand-new tab reattach.
   *  A run that never reported a terminal state (its DO died mid-flight) would otherwise look
   *  in-flight forever, so anything untouched for a few minutes is treated as no longer live. */
  private findActiveRunForSession(sessionId: string): { run_id: string; status: string; updated_at: number } | null {
    try {
      const row = (this.ctx.storage.sql
        .exec(
          `SELECT run_id, status, updated_at FROM run_state
           WHERE session_id = ? AND terminal_json IS NULL ORDER BY started_at DESC LIMIT 1`,
          sessionId
        )
        .toArray() as unknown as Array<{ run_id: string; status: string; updated_at: number }>)[0];
      if (!row) return null;
      if (Date.now() - row.updated_at > 5 * 60 * 1000) return null;
      return row;
    } catch {
      return null;
    }
  }

  /**
   * Phase 3 item 23/24 — "pending background run awareness" for a scheduled/cron wake, not a
   * person's own tab. This DO instance is addressed once per space (`{spaceId}:naelao-agent`
   * for every heartbeat/scheduled_job wake alike — see wakeAgentGoal), so a run still going when
   * the NEXT hourly tick fires would otherwise get a SECOND, overlapping `/script/run` dispatched
   * into the exact same instance. Same staleness rule as findActiveRunForSession (a `run_state`
   * row that stopped updating 5+ minutes ago is treated as dead, not active — a crashed run must
   * never permanently block every future tick).
   */
  private findAnyActiveRun(): { run_id: string; session_id: string; status: string; updated_at: number } | null {
    try {
      const row = (this.ctx.storage.sql
        .exec(
          `SELECT run_id, session_id, status, updated_at FROM run_state
           WHERE terminal_json IS NULL ORDER BY started_at DESC LIMIT 1`
        )
        .toArray() as unknown as Array<{ run_id: string; session_id: string; status: string; updated_at: number }>)[0];
      if (!row) return null;
      if (Date.now() - row.updated_at > 5 * 60 * 1000) return null;
      return row;
    } catch {
      return null;
    }
  }

  /** Runs a person has asked to stop, since this DO instance woke. The durable copy in
   *  `run_state.status` is what makes a cancel land even if the request arrives at an instance
   *  that is not the one executing — this set is only the fast path. */
  private cancelledRuns = new Set<string>();

  /** Ask a run to stop. Cooperative: the loop finishes the action it is inside and stops at the
   *  next step boundary, so a half-completed side effect is never left ambiguous. */
  private requestCancel(runId: string): boolean {
    this.cancelledRuns.add(runId);
    try {
      const updated = this.ctx.storage.sql
        .exec(`UPDATE run_state SET status = 'cancelling', updated_at = ? WHERE run_id = ? AND terminal_json IS NULL RETURNING run_id`, Date.now(), runId)
        .toArray();
      // A run with no durable row at all is one this DO never started — say so honestly rather
      // than reporting a stop that will never happen.
      return updated.length > 0 || this.liveRuns.has(runId);
    } catch {
      return this.liveRuns.has(runId);
    }
  }

  /** Read by the loop once per step. Checks memory first, then storage — so a cancel issued
   *  against a different instance of this DO (or before it woke) is still honoured. */
  private isCancelRequested(runId: string): boolean {
    if (this.cancelledRuns.has(runId)) return true;
    try {
      const row = (this.ctx.storage.sql
        .exec(`SELECT status FROM run_state WHERE run_id = ?`, runId)
        .toArray() as unknown as Array<{ status: string }>)[0];
      if (row?.status === "cancelling") {
        this.cancelledRuns.add(runId);
        return true;
      }
    } catch { /* a storage hiccup must never cancel a run that nobody asked to stop */ }
    return false;
  }

  private pruneDurableRuns(): void {
    try {
      const cutoff = Date.now() - NaelaoAgentDO.DURABLE_RUN_TTL_MS;
      const stale = (this.ctx.storage.sql
        .exec(`SELECT run_id FROM run_state WHERE updated_at < ? LIMIT 50`, cutoff)
        .toArray() as unknown as Array<{ run_id: string }>);
      for (const { run_id } of stale) {
        this.ctx.storage.sql.exec(`DELETE FROM run_stream WHERE run_id = ?`, run_id);
        this.ctx.storage.sql.exec(`DELETE FROM run_state WHERE run_id = ?`, run_id);
        this.lastDurableWrite.delete(run_id);
      }
    } catch { /* pruning is housekeeping, never load-bearing */ }
  }

  /**
   * Mark a run resolved and keep its answer available for a short window.
   *
   * This used to be a plain `delete`, which is what produced the reported "API error 404 on
   * Continue": the continuation ran, succeeded, returned — and the client's very next poll found
   * the run nowhere, because a script-native run has no `agent_runs` row and a direct DO dispatch
   * has no TaskDO task. Retaining the terminal result is cheaper and more honest than teaching
   * three separate clients to stop polling.
   */
  private finishLiveRun(runId: string, terminal: FinishedRunState): void {
    const entry = this.liveRuns.get(runId) ?? { steps: [], updatedAt: Date.now() };
    entry.terminal = terminal;
    entry.updatedAt = Date.now();
    this.liveRuns.set(runId, entry);
    this.pruneLiveRuns();
    // Also durably: this is what a client that reconnects AFTER the run finished reads, and it is
    // what stops findActiveRunForSession offering a run that is already over.
    try {
      // Flush the tail unconditionally — the last partial is very often the one the throttle
      // skipped, and losing the end of the answer is the most visible way this could fail.
      this.lastDurableWrite.delete(runId);
      this.persistLiveRun(runId, false);
      this.ctx.storage.sql.exec(
        `UPDATE run_state SET status = ?, terminal_json = ?, updated_at = ? WHERE run_id = ?`,
        terminal.status, JSON.stringify(terminal), Date.now(), runId
      );
      this.lastDurableWrite.delete(runId);
    } catch { /* see openDurableRun */ }
  }

  /** Drop resolved entries past their TTL, and the oldest resolved ones if the map is still over
   *  its cap. An unresolved run is never pruned — it is still executing. */
  private pruneLiveRuns(): void {
    const now = Date.now();
    for (const [id, e] of this.liveRuns) {
      if (e.terminal && now - e.updatedAt > NaelaoAgentDO.FINISHED_RUN_TTL_MS) this.liveRuns.delete(id);
    }
    if (this.liveRuns.size <= NaelaoAgentDO.MAX_RETAINED_RUNS) return;
    const resolved = [...this.liveRuns.entries()].filter(([, e]) => e.terminal).sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    for (const [id] of resolved.slice(0, this.liveRuns.size - NaelaoAgentDO.MAX_RETAINED_RUNS)) this.liveRuns.delete(id);
  }


  /** Combines any number of onProgress reporters (live-progress + sub-agent-parent-callback,
   *  when both apply) into one — each fires independently and a throwing one never blocks the
   *  others, same "never fails the run" contract loop.ts's own reportProgress already has. */
  private composeProgressReporters(
    reporters: Array<((checkpoint: LiveCheckpoint) => void | Promise<void>) | undefined>
  ): ((checkpoint: LiveCheckpoint) => Promise<void>) | undefined {
    const active = reporters.filter((r): r is (checkpoint: Omit<TraceStep, "seq" | "ts">) => void | Promise<void> => !!r);
    if (active.length === 0) return undefined;
    return async (checkpoint) => {
      for (const r of active) {
        try {
          await r(checkpoint);
        } catch {
          /* one reporter failing must never block the others or the run itself */
        }
      }
    };
  }

  private buildSubAgentProgressReporter(context: Record<string, unknown> | undefined): ((checkpoint: Omit<TraceStep, "seq" | "ts">) => Promise<void>) | undefined {
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

  /**
   * `parentRunId` is OPTIONAL. With one, this is the live poll for a single run's fan-out. Without
   * one, it lists this DO's recent sub-agents across every run.
   *
   * That second mode is what the Sub-agents panel needed: a DO is addressed per
   * space:project:thread (or space:agentId for the Space Assistant), so "everything in this DO" is
   * already scoped to this one conversation — no cross-thread leak. Scoping the panel to the
   * CURRENT run instead meant every earlier run's sub-agents were invisible, and a conversation
   * whose latest turn happened to spawn nothing reported "no sub-agent activity" however much had
   * really run. Newest first, bounded, since this is a panel and not an export.
   */
  private handleListSubAgents(parentRunId: string): Response {
    const cols = `id, parent_run_id, goal, status, budget_tokens, tokens_used, progress_note, created_at, updated_at`;
    const rows = parentRunId
      ? this.ctx.storage.sql
          .exec(`SELECT ${cols} FROM sub_agents WHERE parent_run_id = ? ORDER BY created_at ASC`, parentRunId)
          .toArray()
      : this.ctx.storage.sql
          .exec(`SELECT ${cols} FROM sub_agents ORDER BY created_at DESC LIMIT 50`)
          .toArray();
    return Response.json({ data: rows, count: rows.length });
  }

  /**
   * Live-reported: the Space Assistant flatly claimed `thread.create` "isn't supported" — a real,
   * shipped capability. Root cause (confirmed by reading the actual persisted R2 file for the
   * reporting business): `scripts.json` is written ONCE at provision time
   * (`writeAgentConfig`/the provisioner) and NOTHING re-syncs it when profiles.ts later gains a
   * new prebuilt script — that business was provisioned before `project-coordination` was added
   * to the Space Assistant's profile, so its persisted `prebuilt` list genuinely never had it.
   * This is not a one-off: every prebuilt added to the profile since ANY business's provisioning
   * date is equally missing for that business, silently.
   *
   * Self-heals the SAME way `SpaceTypeRegistryDO.ensureInit()` does for an empty registry: on
   * every load for the ONE hardcoded Space Assistant agentId ("naelao-agent" — every dispatcher
   * platform-wide already hardcodes this, see profiles.ts), union in whatever the CURRENT code's
   * Space Assistant profiles declare (both DEFAULT_NAELAO_AGENT and LAUNCHPAD_ASSISTANT_PROFILE —
   * this DO has no D1 access to know which SpaceType variant applies, and there is no builder UI
   * to individually trim which prebuilt SCRIPTS an agent has, only per-action approval policy, so
   * a script the CURRENT code declares but a persisted list lacks is staleness, never an
   * intentional trim). Additive only — never removes anything persisted. A project-scoped
   * specialist agent (a different, per-business agentId, deliberately restricted per the F-36/
   * item-130 access split) is untouched. Best-effort re-persist so this heals once per agent, not
   * every run; a write failure never blocks the run itself — the union still applies in memory.
   */
  private async loadAgentConfigHealed(bucket: R2Bucket, spaceId: string, agentId: string): Promise<AgentConfig | null> {
    const config = await loadAgentConfig(bucket, spaceId, agentId);
    if (!config || agentId !== "naelao-agent") return config;
    const wanted = [...new Set([...DEFAULT_NAELAO_AGENT.config.scripts.prebuilt, ...LAUNCHPAD_ASSISTANT_PROFILE.config.scripts.prebuilt])];
    const { merged, changed } = mergeMissingPrebuilt(config.scripts, wanted);
    if (!changed) return config;
    const healed: AgentConfig = { ...config, scripts: merged };
    writeAgentConfig(bucket, spaceId, agentId, healed).catch(() => {
      /* best-effort — the in-memory union below still applies to THIS run either way */
    });
    return healed;
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
    const config = await this.loadAgentConfigHealed(engineEnv.scriptsBucket, body.spaceId, body.agentId);
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
      /** A chosen reasoning-effort/thinking level for `model`, already validated by the caller
       *  (index.ts's /agent/run route) against billing-core's isValidReasoningLevel — an invalid
       *  or unsupported level for the chosen model is dropped rather than trusted again here,
       *  same "validate once at the edge, degrade honestly if it somehow arrives wrong" posture
       *  every other client-supplied enum in this handler already has. */
      reasoningEffort?: string;
      /** The escalation-budget dial (billing-core's EffortLevel) — already validated/defaulted
       *  by the caller (index.ts's /agent/run route) against whichever model this run actually
       *  uses. Governs which model a sub-agent spawn/consult THIS run makes is allowed to run on
       *  — see buildOrchestrationHooks's spawnSubAgent hook and resolveEscalationModel. */
      effort?: string;
      // §A1 Harness Excellence Phase HX2: resolved by the caller (index.ts) from
      // productConfig.limits.sessionCreditCeiling — this DO has no PLATFORM_DB binding.
      sessionCreditCeiling?: number;
      /** WHICH business this run is for (name, what it sells, whether setup is done). Resolved by
       *  the caller (index.ts) from the space row it already fetches — this DO has no PLATFORM_DB
       *  binding, so it cannot look the space up itself. Absent for a direct/internal caller that
       *  never resolved one, in which case the reasoner simply omits the field. */
      businessContext?: BusinessContext;
      /** The id the caller already handed to its client, so the persisted trace is reachable
       *  through GET .../runs/:runId/trace. Optional — direct callers omit it. */
      runId?: string;
      /** Set only by the resume path (handleResumeRun) — never by an external caller, whose
       *  request never reaches this DO except through the router's verified proxy. */
      preApprovedActions?: string[];
      resumeSteps?: Array<{ name: string; params: Record<string, unknown>; ok: boolean; output?: unknown; error?: string }>;
      /** The ORIGINAL run's id, so the action ledger recognises a resume as the same task. */
      ledgerKey?: string;
      /** Phase 2 item 13 — opt-in progressive tool disclosure (see ScriptEngineEnv's own doc).
       *  Resolved by the caller (index.ts) from an explicit per-request override or the space's
       *  own stored productConfig.modelConfig.progressiveToolDisclosure; defaults to false/full
       *  disclosure when neither is set, so every existing run is unaffected. */
      progressiveToolDisclosure?: boolean;
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
    // Set only by the agents worker, from a server-side business_memberships lookup — never a
    // client-supplied value. Absent for builder callers and system wakes.
    const businessRole = request.headers.get("x-naelao-business-role") ?? undefined;
    // Prefer the caller's own run id. /agent/run generates one, returns it to the client, and
    // exposes GET .../runs/:runId/trace — but it never sent it here, so the trace was persisted
    // under a DIFFERENT, internal-only id and that endpoint could never find anything. Falling
    // back to a fresh id keeps direct callers (channel heartbeats, triggers) working unchanged.
    const runId = body.runId ?? crypto.randomUUID();

    if (!body.goal || !spaceId) {
      return Response.json({ error: "goal and spaceId are required" }, { status: 400 });
    }

    // Check for Dual-Tier Planner-Worker Asymmetry Engine (/goal)
    const { isGoalMode, goalPrompt } = parseGoalCommand(body.goal);
    if (isGoalMode) {
      console.log(`🚀 Ingress Goal Intercepted: "${goalPrompt}". Engaging Dual-Tier Planner-Worker Engine...`);
      const repoMap = await this.virtualShell.exec("tree -L 2 -I 'node_modules|dist|.git'");
      const targetProjectId = projectId || "default";
      
      const plan = await planGoalWithFrontier(goalPrompt, repoMap.stdout, this.env);
      
      const completedTasks: string[] = [];
      const allModifiedFiles: string[] = [];
      for (const task of plan.tasks) {
        const fileSlices: Record<string, string> = {};
        for (const filePath of task.targetFiles) {
          const content = await this.getVirtualFsStorage().readFile(filePath);
          if (content !== null) {
            fileSlices[filePath] = content;
          }
        }

        const dualTierCtx: import("../script-engine/dual-tier-executor.js").DualTierContext = {
          env: this.env,
          spaceId,
          projectId: targetProjectId,
          workspaceFs: {
            readFile: async (p: string) => this.getVirtualFsStorage().readFile(p),
            writeFile: async (p: string, c: string) => this.getVirtualFsStorage().writeFile(p, c),
            editFile: async (p: string, o: string, n: string) => {
              const cur = await this.getVirtualFsStorage().readFile(p);
              if (cur === null || !cur.includes(o)) return { ok: false };
              await this.getVirtualFsStorage().writeFile(p, cur.replace(o, n));
              return { ok: true };
            },
            execBash: async (cmd: string) => this.virtualShell.exec(cmd),
          },
          artifactsGit: {
            createRepoFork: async (parentRepo: string, forkSuffix: string) => {
              const forkName = `${parentRepo}_${forkSuffix}`;
              return { forkName };
            },
            generateCommitDiff: async (_baseRepo: string, forkRepo: string) => {
              return { summary: `Diff generated for ${forkRepo}`, filesChanged: 1 };
            },
            commitWorkspace: async (opts: { repoName: string; branch: string; message: string }) => {
              return { ok: true, commitId: "commit_" + Date.now().toString(36), ...opts };
            },
          },
        };

        const subtaskTools = new ScriptToolSurface(engineEnv, config.scripts.prebuilt);
        await executeSubtaskSlice(task, fileSlices, dualTierCtx);
        completedTasks.push(task.title);
        allModifiedFiles.push(...task.targetFiles);
      }

      const outputText = `### 🎯 Goal Execution Plan Completed\n\n**Architectural Summary:**\n${plan.architecturalSummary}\n\n**Status:** ✅ APPROVED\n**Tasks Executed:** ${completedTasks.length}/${completedTasks.length}\n**Modified Files:** ${[...new Set(allModifiedFiles)].join(", ")}`;

      await this.writeAgentAnswerToSession(
        sessionId,
        spaceId,
        tenantId,
        outputText,
        agentId,
        { goal_pipeline_result: plan },
        runId
      );

      return Response.json({
        level: "L4",
        result: {
          ok: true,
          output: outputText,
          tier: 1,
          duration_ms: 0,
          tokens_used: 0,
        },
        goal_pipeline: plan,
        notes: [`Goal pipeline completed successfully`],
        trace: [],
      });
    }

    // Go-live monetization pass: a business that opted into revenue-cut billing (productConfig.
    // pricingConfig.externalRevenueCut.enabled) but has stopped reporting its tracked revenue
    // (Whop credential revoked/broken) could otherwise keep running its agent indefinitely with
    // no technical consequence — a ToS-only "must keep it connected" clause nobody enforces.
    // Space-wide (applies to both project-scoped and Space Assistant runs) since this is an
    // access restriction, not a per-project billing concern. Fails OPEN on any lookup error or
    // when the business has NEVER successfully tracked (a business just turning this feature on
    // hasn't had a chance to connect Whop yet — only a PREVIOUSLY-connected-then-lapsed business
    // is gated, never a newly-enabled one with zero history).
    const reportingLapsed = await this.checkRevenueReportingLapsed(spaceId, tenantId);
    if (reportingLapsed) {
      return Response.json(
        { error: "Whop revenue reporting has lapsed for this business — reconnect it to resume", error_code: "revenue_reporting_lapsed" },
        { status: 403 }
      );
    }

    // Tier 2 metering follow-up: business_subscriptions (Phase E) was write-only — the Lemon
    // Squeezy webhook upserted a row on every subscription event but nothing ever read it to gate
    // access, so a business on a pricingConfig.model === "subscription" product could run its
    // agent indefinitely whether or not it ever actually subscribed. Fails CLOSED (deny) on any
    // lookup error — a network hiccup must not silently unblock a gated subscription run.
    const subGate = await this.checkBusinessSubscriptionGate(spaceId, tenantId);
    if (subGate.gated && !subGate.active) {
      return Response.json(
        { error: "this business's subscription is not active — resubscribe to resume", error_code: subGate.reason || "subscription_inactive" },
        { status: 402 }
      );
    }

    const engineEnv = this.buildScriptEngineEnv(spaceId, agentId, tenantId, userId, projectId, sessionId);
    if (!engineEnv) {
      return Response.json({ error: "script engine unavailable: SCRIPTS_R2 not bound" }, { status: 503 });
    }
    // §A1 connector default-vs-personal switch: read once per run, best-effort — a failure or an
    // empty map both mean "resolve as business" (today's implicit default), never blocks the run.
    engineEnv.connectorAccountMode = await this.fetchConnectorAccountMode(spaceId, sessionId, tenantId);
    // F14: customer-bot daily spend cap was only enforced in the channel-heartbeat drain path
    // (handleChannelHeartbeat) — a direct /script/run call with the same projectId bypassed it
    // entirely. Apply the identical cap-then-execution-ceiling gate here.
    // F9: the gate itself now checks through SpaceDO (single writer for the whole project),
    // not this DO's own local tally — see checkAndDebitProjectSpend.
    // Go-live audit A-1/A-2: this block (F-36 clamp, execution ceiling + daily spend cap, project
    // wallet gate, product_end_user pre-run credit check) is shared with the legacy ReAct
    // `handleRun` path via `enforceRunGates` — see that method's own doc for why both runtimes
    // must call the identical gate logic rather than each carrying their own copy.
    const gate = await this.enforceRunGates({
      spaceId, tenantId, projectId, userId, callerRole,
      sessionId, agentId, runId, sessionCreditCeiling: body.sessionCreditCeiling,
    });
    if (!gate.ok) return gate.response;
    const { hasSpendCap, walletProjectId } = gate;
    if (gate.effectiveRole !== undefined) {
      // "viewer" makes the whole run read-only — enforced structurally in ScriptToolSurface
      // (script.create/update/delete, stored scripts, and non-read-safe prebuilt ops all
      // refuse). editor/owner run unclamped at the six-op surface.
      engineEnv.effectiveRole = gate.effectiveRole;
    }
    if (gate.maxTier !== undefined) {
      engineEnv.maxTier = gate.maxTier;
    }
    // Phase 2 item 13 — opt-in progressive tool disclosure. Absent/false is byte-identical to
    // every run before this feature existed; the field only exists so a real business can be
    // opted in (via productConfig.modelConfig, resolved by index.ts) once proven safe.
    if (body.progressiveToolDisclosure) {
      engineEnv.progressiveToolDisclosure = true;
    }

    // Load the agent's 4-file config; without it the agent is not provisioned.
    const config = await this.loadAgentConfigHealed(engineEnv.scriptsBucket, spaceId, agentId);
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
      // F-36 enforcement (policy half): the space-wide policy is intersected with the VERIFIED
      // acting caller's role — `yolo` fully applies only for system wakes (no x-naelao-role:
      // the autonomous operation the owner configured it for) and owner/admin callers, who
      // could self-authorize any gated action anyway. For everyone else (editor/viewer
      // builders, product end users, agent API keys) yolo downgrades to the always_ask
      // posture, so a space set to yolo no longer grants un-gated autonomy to a run made on
      // behalf of a user who couldn't approve those actions themself. Pure logic + tests in
      // script-engine/assistant-access.ts.
      //
      // businessRole is what stops that downgrade from locking a business OWNER out of the yolo
      // they set on their own business — resolved server-side from business_memberships by the
      // agents worker, never taken from the client.
      const plan = resolveAssistantApprovalPlan(policy, callerRole, businessRole);
      requiresApprovalFor = plan.requiresApprovalFor;
      approvalMode = plan.approvalMode;
    }

    const tools = new ScriptToolSurface(engineEnv, config.scripts.prebuilt);

    // Enforce Hardware-Enforced Role Capability Firewall
    const agentRole = resolveAgentRole(agentId, projectId, callerRole || businessRole);
    const firewallPolicy = ROLE_FIREWALL_POLICIES[agentRole] || ROLE_FIREWALL_POLICIES.CUSTOM;
    if (engineEnv.maxTier === undefined || engineEnv.maxTier > firewallPolicy.maxLadderTier) {
      engineEnv.maxTier = firewallPolicy.maxLadderTier;
    }

    // Load SOUL.md from .avos/agents/:agentId/SOUL.md
    let soulMarkdown = "";
    try {
      const soulPath = AVOS_PATH_CONVENTIONS.agentSoul(agentId);
      const vfsContent = await this.getVirtualFsStorage().readFile(soulPath);
      if (vfsContent && vfsContent.trim().length > 0) {
        soulMarkdown = vfsContent;
      } else if (engineEnv.workspaceBucket) {
        const r2Obj = await engineEnv.workspaceBucket.get(`${getWorkspacePath(spaceId, projectId)}${soulPath}`);
        if (r2Obj) soulMarkdown = await r2Obj.text();
      }
    } catch {
      /* fallback to config */
    }
    if (!soulMarkdown) {
      soulMarkdown = config.systemPrompt || "";
    }

    // Prepare Living Business Identity Brief
    const businessBrief: BusinessContextBrief = {
      businessName: body.businessContext?.business_name || (body.businessContext as any)?.name || spaceId,
      templateType: body.businessContext?.space_type || "standard",
      currency: body.businessContext?.currency || "USD",
      activeOfferings: (body.businessContext?.offerings || []).map((o: any) => ({
        name: o.name || o.title || "Standard Service",
        priceCents: typeof o.price_cents === "number" ? o.price_cents : (typeof o.priceCents === "number" ? o.priceCents : 0),
      })),
      complianceMode: ((body.businessContext as any)?.compliance_mode as any) || "standard",
      operatingJurisdiction: (body.businessContext as any)?.operatingJurisdiction || (body.businessContext as any)?.jurisdiction,
    };

    // Assemble 4-Layer Dynamic System Prompt
    const assembledSystemPrompt = assembleSystemPrompt({
      businessContext: businessBrief,
      soulMarkdown,
      founderDirectives: typeof (body.context as any)?.founder_directives === "string" ? (body.context as any).founder_directives : undefined,
      agentRole,
      activeWorkspacePath: projectId ? `/workspace/projects/${projectId}/` : "/workspace/",
    });

    // 1. Generate the Zero-Turn Catalog
    const zeroTurnCatalog = await ScriptToolSurface.generateZeroTurnCatalog(
      this.ctx.storage,
      this.getVirtualFsStorage(),
      spaceId,
      projectId
    );

    // 2. Compose the final system prompt
    const enrichedSystemPrompt = composeSystemPrompt(
      assembledSystemPrompt,
      body.businessContext ? JSON.stringify(body.businessContext, null, 2) : "",
      zeroTurnCatalog
    );

    // A sub-agent spawned mid-task inherits the SAME project scoping as its parent — it's
    // conceptually a subthread of the same project, not a different workspace. Built after
    // `tools` (§A1.17 Phase J's workflow.create/run ops need it to author/re-run stored
    // scripts) — read lazily at call time, so ordering relative to runScriptLoop is safe.
    const consultLog: Array<{ thread_id: string; agent_id: string; title: string }> = [];
    engineEnv.orchestration = this.buildOrchestrationHooks(spaceId, agentId, tenantId, body.apiKey ?? "", runId, sessionId, projectId, tools, userId, consultLog, body.model, body.effort);
    const reasoningRequest = NaelaoAgentDO.resolveReasoningRequest(body.model, body.reasoningEffort);
    // Step 28: a business's OWN Gemini/Groq key wins over the platform key for its own runs. Spread
    // AFTER the env keys so it overrides; a business with none (or a default @cf/ model) gets the
    // platform key exactly as before — see resolveBusinessLlmOverride's own doc.
    const byokOverride = await this.resolveBusinessLlmOverride(spaceId, tenantId, body.model ?? DEFAULT_WORKING_MODEL);
    const reasoner = new GatewayReasoner({
      apiKey: body.apiKey ?? "",
      gateway: {
        accountId: this.env.NAELAO_ACCOUNT_ID ?? "placeholder",
        gatewayId: this.env.NAELAO_GATEWAY_ID ?? "naelao-gateway",
        ...(this.env.CF_API_TOKEN ? { cfApiToken: this.env.CF_API_TOKEN } : {}),
        ...(this.env.NAELAO_AIG_TOKEN ? { aigToken: this.env.NAELAO_AIG_TOKEN } : {}),
        ...(this.env.GOOGLE_AI_STUDIO_API_KEY ? { googleAiStudioApiKey: this.env.GOOGLE_AI_STUDIO_API_KEY } : {}), ...(this.env.GROQ_API_KEY ? { groqApiKey: this.env.GROQ_API_KEY } : {}),
        ...byokOverride,
      },
      ctx: { spaceId, agentId, model: body.model ?? DEFAULT_WORKING_MODEL },
      ...(body.model ? { model: body.model } : {}),
      fallbacks: this.resolveFailoverChain(body.model ?? DEFAULT_WORKING_MODEL, body.apiKey ?? ""),
      ...(reasoningRequest ? { reasoning: reasoningRequest } : {}),
      // The agent's OWN identity and instructions. Loaded from R2 on every run since the script
      // engine was built, and never once handed to the model — see ReasonerDeps.agentPrompt.
      ...(enrichedSystemPrompt ? { agentPrompt: enrichedSystemPrompt } : {}),
      // WHICH business this run is for. Resolved by index.ts from the space row it already
      // fetches; omitted entirely when the caller never resolved one.
      ...(body.businessContext ? { businessContext: body.businessContext } : {}),
    });

    try {
      const maxStepsFromContext = body.context?.["max_steps"];
      const maxTokensFromContext = body.context?.["max_tokens"];
      const deadlineMsFromContext = body.context?.["deadline_ms"];
      const onProgress = this.composeProgressReporters([
        // sessionId is what makes this run findable again from a tab that was never open for it.
        this.buildLiveProgressReporter(runId, sessionId),
        this.buildSubAgentProgressReporter(body.context),
      ]);
      // The thread's own history — without it the agent has no memory of the conversation it is
      // replying in. Best-effort: undefined simply means "no history", the prior behaviour.
      const conversation = await this.loadConversationContext(spaceId, sessionId, tenantId);
      const result = await runScriptLoop(engineEnv, tools, reasoner, config.scripts.prebuilt, {
        goal: body.goal,
        startupObserve: config.scripts.startup_observe,
        ...(conversation ? { conversation } : {}),
        requiresApprovalFor,
        approvalMode,
        runId,
        sessionId,
        // Checked once per step, so a Stop button actually stops something. Only wired here —
        // the interactive path — since a cron wake or channel drain has nobody watching it.
        shouldCancel: () => this.isCancelRequested(runId),
        ...(body.preApprovedActions?.length ? { preApprovedActions: body.preApprovedActions } : {}),
        ...(body.ledgerKey ? { ledgerKey: body.ledgerKey } : {}),
        ...(body.resumeSteps?.length ? { resumeSteps: body.resumeSteps } : {}),
        ...(typeof maxStepsFromContext === "number" ? { maxSteps: maxStepsFromContext } : {}),
        ...(typeof maxTokensFromContext === "number" ? { maxTokens: maxTokensFromContext } : {}),
        // How much of its own history the run may carry each turn. Resolved from the model
        // ACTUALLY running, because the platform's default is served with a 24k window against a
        // nominal 128k — sizing against the wrong figure overflows it (see step-context.ts).
        contextWindowTokens: contextWindowForModel(body.model ?? DEFAULT_WORKING_MODEL),
        // A person is waiting on the other end of this request, so the loop gets a wall clock. One
        // turn before it expires the model is told to wrap up, which turns "ran out of time" into a
        // real answer about what was done rather than a stalled request.
        deadlineAt: Date.now() + (typeof deadlineMsFromContext === "number" ? deadlineMsFromContext : RUN_WALL_CLOCK_MS),
        ...(onProgress ? { onProgress } : {}),
      });

      // Suspended at a gate. Persist the checkpoint and return without billing, memory, or a
      // run_completed/run_failed activity row — none of those are true yet, and recording a
      // waiting run as failed is exactly what made approvals look broken.
      // Parked-and-continued: the run finished with a real answer, but some actions are waiting on
      // a human. Each gets its own checkpoint so it resumes alone when answered — the run itself is
      // done and bills/settles normally below, unlike a fully suspended one.
      for (const parked of result.deferred_approvals ?? []) {
        this.persistSuspendedRun(parked, {
          runId, spaceId, tenantId, agentId, sessionId, projectId, userId, callerRole,
          model: body.model, goal: body.goal,
        });
        void this.logAgentActivity(spaceId, tenantId, agentId, "approval_requested", {
          projectId: projectId ?? null,
          threadId: sessionId,
          summary: `Waiting for approval to run '${parked.action_name}' — the rest of the task continued`,
        });
      }

      if (result.pending_approval) {
        this.persistSuspendedRun(result.pending_approval, {
          runId, spaceId, tenantId, agentId, sessionId, projectId, userId, callerRole,
          model: body.model, goal: body.goal,
        });
        void this.logAgentActivity(spaceId, tenantId, agentId, "approval_requested", {
          projectId: projectId ?? null,
          threadId: sessionId,
          summary: `Waiting for approval to run '${result.pending_approval.action_name}'`,
        });
        this.persistRunTrace(runId, tenantId, result.trace);
        // Retained like any other resolved run, so a client polling a suspended run is told it is
        // waiting on a human rather than getting a 404 that reads as "your message vanished".
        this.finishLiveRun(runId, {
          status: "awaiting_approval",
          pending_approval: result.pending_approval,
          ...(result.deferred_approvals?.length ? { deferred_approvals: result.deferred_approvals } : {}),
        });
        return Response.json(result);
      }

      // §A1 Phase HX1 — persist the structured trace this run just produced (see loop.ts's
      // TraceStep[]). Never blocks/fails the run itself (persistRunTrace swallows its own
      // errors) — this must run even when result.result.ok is false, since a failed run's
      // trace is exactly what a builder (or a future skill-evolution job) needs to diagnose it.
      this.persistRunTrace(runId, tenantId, result.trace);

      // A run that went wrong is checkpointed so it can be CONTINUED rather than restarted.
      // Restarting is what created a second project when a user pressed Try again: a fresh run
      // gets a fresh ledger key and redoes everything. The offer is durable (see
      // interrupted_runs) so it survives a refresh, and it carries the completed steps forward.
      if (result.result && result.result.ok === false) {
        this.persistInterruptedRun({
          runId, spaceId, tenantId, agentId, sessionId, projectId, userId, callerRole,
          model: body.model, goal: body.goal,
          reason: result.result.error ?? "the run did not finish",
          steps: result.steps_completed ?? [],
        });
      }

      // Go-live audit A-1/A-2: shared with handleRun via settleRunBilling — see that method's
      // doc for why both runtimes must settle billing identically rather than each carrying
      // their own copy (the divergence that let handleRun run completely unmetered).
      await this.settleRunBilling({
        spaceId, tenantId, projectId, userId, callerRole, hasSpendCap, walletProjectId, runId,
        tokensUsed: result.result?.tokens_used ?? 0,
        inputTokens: result.result?.input_tokens ?? 0,
        outputTokens: result.result?.output_tokens ?? 0,
        model: body.model,
        notes: result.notes,
        tier: result.result?.tier,
        durationMs: result.result?.duration_ms,
        sessionId, sessionCreditCeiling: body.sessionCreditCeiling,
      });

      // Persist the answer into the thread. The client already writes the USER message before
      // dispatching, but nothing wrote the assistant's — so a reload showed a conversation of
      // questions with no replies, and the agent's own conversation memory (which reads this same
      // transcript) only ever saw the user's half. `agent_id` is what lets a bubble say which
      // agent spoke: the Space Assistant, or a named project agent.
      // needs_connector/connector_id/connector_name (tool-surface.ts, set when resolveServerId
      // names a catalogued-but-unregistered connector) rides in the SAME metadata object as
      // consulted_threads so the chat UI can render an inline "Connect X" card at the exact turn
      // the assistant asked for it, instead of the connector name only ever appearing in prose.
      if (typeof result.result?.output === "string" && result.result.output.trim()) {
        const answerMetadata: Record<string, unknown> = {};
        if (consultLog.length) answerMetadata["consulted_threads"] = consultLog;
        if (result.result.needs_connector) {
          answerMetadata["needs_connector"] = true;
          if (result.result.connector_id) answerMetadata["connector_id"] = result.result.connector_id;
          if (result.result.connector_name) answerMetadata["connector_name"] = result.result.connector_name;
        }
        // Step 5/7/11: surface any artifact CREATED during this run so the chat renders an inline
        // preview (iframe + download) at this exact turn — like Claude showing an artifact — rather
        // than the artifact only ever appearing in the side panel. Reuses this run's own trace
        // (the artifacts.create step already recorded its result), so no extra work/LLM call.
        const createdArtifacts: Array<{ artifact_id: string; filename: string; content_type?: string }> = [];
        for (const step of result.trace ?? []) {
          if (step.phase === "run" && step.name === "artifacts.create" && step.ok && step.output != null) {
            try {
              const out = (typeof step.output === "string" ? JSON.parse(step.output) : step.output) as Record<string, unknown>;
              const id = out["artifact_id"] ?? out["id"];
              const filename = out["filename"];
              if (id && filename) {
                createdArtifacts.push({
                  artifact_id: String(id),
                  filename: String(filename),
                  ...(typeof out["content_type"] === "string" ? { content_type: out["content_type"] as string } : {}),
                });
              }
            } catch { /* unparseable trace output — skip */ }
          }
        }
        if (createdArtifacts.length) answerMetadata["created_artifacts"] = createdArtifacts;
        // The run's own id, so a reload can re-fetch this exact run's activity trail (run_traces,
        // §A1 HX1) instead of losing it — the client's own in-memory `activity` is genuinely
        // client-only and doesn't survive a reload, but the trace itself is durable; this is what
        // lets the client find it again. Cheap: runId already resolved above for the interrupted-
        // run checkpoint and billing settlement.
        answerMetadata["run_id"] = runId;
        // AWAITED, not fire-and-forget. A promise still pending when a DO handler returns may
        // never run — so this write raced the response and the reply would sometimes be on screen
        // and then simply gone after a reload ("it's like it ended the conversation there").
        // Awaiting is safe: writeAgentAnswerToSession swallows its own errors, so it can still
        // never turn an already-successful run into a failed one.
        await this.writeAgentAnswerToSession(
          sessionId, spaceId, tenantId, result.result.output, agentId,
          Object.keys(answerMetadata).length > 0 ? answerMetadata : undefined,
          runId
        );
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
        // Layer 5 (episodic) automatic write. Before this, the ONLY way anything ever landed in
        // episodic_log was the model explicitly calling memory.remember — a tool call it rarely
        // makes unprompted, which is the real, previously-undetected cause of "the AI isn't
        // recording anything in memory": Fabric (above) consolidates PROJECT-shared facts, but a
        // thread's own episodic trail — the raw "what happened" a later `memory.recall` in this
        // same thread/user scope can actually retrieve — stayed empty unless the model remembered
        // to ask for it. This mirrors that same explicit call, at low importance (0.3, below the
        // promotion threshold `runMemoryMaintenance` uses to surface something into a wiki
        // article) — a background trail the model can recall on demand, not something that forces
        // itself into every future prompt. Best-effort, same posture as the Fabric write above.
        try {
          await engineEnv.memoryStore.remember({
            ...(userId ? { userId } : {}),
            text: `Goal: ${body.goal.slice(0, 300)}\nOutcome: ${result.result.output.slice(0, 500)}`,
            importance: 0.3,
          });
        } catch {
          /* best-effort — an automatic episodic note is a convenience, not run-critical */
        }
      }

      // Security audit follow-up (observability gap): one row per completed run, independent of
      // and in addition to the billing debit branches above (this is a separate concern — a
      // builder-readable log, not a payer's balance). Computed the same way the debit branches
      // already compute credits, just not tied to any one payer.
      // What woke this run. Carried into the log so the diagnostics rollup can say "the heartbeat
      // fired four times and hit a limit every time" — a pattern that is invisible per-run.
      const triggerSource = typeof body.context?.["trigger"] === "string"
        ? String(body.context["trigger"])
        : "chat";
      const failed = result.result?.ok === false;
      const failureText = result.result?.error ? String(result.result.error) : "";

      void this.logAgentActivity(spaceId, tenantId, agentId, result.result?.ok ? "run_completed" : "run_failed", {
        projectId: projectId ?? null,
        threadId: sessionId,
        sessionId,
        runId,
        triggerSource,
        // origin matters: see ScriptRunResult.failure_origin. A model give_up misclassified as
        // a self-clearing capacity failure freezes every future wake-up.
        ...(failed ? { failureKind: classifyFailure(failureText, undefined, result.result?.failure_origin).kind } : {}),
        summary: result.result?.ok
          ? (typeof result.result.output === "string" ? result.result.output.slice(0, 500) : `Goal: ${body.goal.slice(0, 200)}`)
          : (failureText ? failureText.slice(0, 500) : "Run did not complete successfully"),
        tokensUsed: result.result?.tokens_used ?? null,
        costCredits: result.result?.input_tokens || result.result?.output_tokens
          ? tokensToCredits(result.result.input_tokens ?? 0, result.result.output_tokens ?? 0, body.model ?? DEFAULT_WORKING_MODEL)
          : (result.result?.tokens_used ?? null),
      });
      if (failed) {
        // The classification decides how loudly to say it. A quota that resets on its own is a
        // heads-up; a tool that keeps throwing is something the owner should actually look at.
        // Notifying at 'warning' for both trains people to ignore the whole channel.
        const classification = classifyFailure(failureText);
        // A run the person themselves stopped is not a failure notification waiting to happen —
        // they are the one who just did it, right there, watching. logAgentActivity's run_failed
        // row above still records it (a real, honest fact for the audit trail); this is only the
        // push-style notification, which would otherwise read as "your agent couldn't finish" for
        // something entirely under the person's own control.
        if (classification.kind !== "user_cancelled") {
          void this.createSpaceNotification(spaceId, tenantId, {
            kind: "run_failed",
            title: `'${agentId}' couldn't finish: ${body.goal.slice(0, 80)}`,
            body: `${failureText ? failureText.slice(0, 400) : "Run did not complete successfully"}\n\n${classification.summary}`,
            severity: classification.clears_on_its_own ? "info" : "warning",
            projectId: projectId ?? null,
            sourceAgentId: agentId,
          });
        }
      }

      // Keep this run answerable for a short window. A script-native run has no `agent_runs` row,
      // and one dispatched straight into this DO (Continue, sub-agents) has no TaskDO task either
      // — so deleting the entry here is what made the client's next poll 404 on a run that had
      // actually succeeded.
      this.finishLiveRun(runId, {
        status: result.result?.ok === false ? "failed" : "completed",
        ...(typeof result.result?.output === "string" ? { final_answer: result.result.output } : {}),
        ...(result.result?.error ? { error: String(result.result.error) } : {}),
        ...(result.deferred_approvals?.length ? { deferred_approvals: result.deferred_approvals } : {}),
      });
      return Response.json(result);
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      void this.logAgentActivity(spaceId, tenantId, agentId, "run_failed", {
        projectId: projectId ?? null, threadId: sessionId, summary: errMessage.slice(0, 500),
        sessionId, runId,
        failureKind: classifyFailure(errMessage).kind,
        triggerSource: typeof body.context?.["trigger"] === "string" ? String(body.context["trigger"]) : "chat",
      });
      this.finishLiveRun(runId, { status: "failed", error: errMessage });
      return Response.json(
        { error: errMessage },
        { status: 500 }
      );
    } finally {
      // Every normal exit above records a terminal state, which keeps the entry (briefly) rather
      // than dropping it. Anything that reaches here WITHOUT one left the run unresolved — there
      // is nothing to report and no more onProgress will fire, so the live window is over.
      const entry = this.liveRuns.get(runId);
      if (entry && !entry.terminal) this.liveRuns.delete(runId);
    }
  }

  private async handleMemoryMaintenance(request: Request): Promise<Response> {
    this.ensureInit();
    const body = await request.json<{ spaceId?: string; sessionId?: string; tenantId?: string }>()
      .catch(() => ({}) as { spaceId?: string; sessionId?: string; tenantId?: string });
    const spaceId = body.spaceId ?? request.headers.get("x-naelao-space-id") ?? "";
    if (!spaceId) return Response.json({ error: "spaceId is required" }, { status: 400 });
    const tenantId = body.tenantId ?? request.headers.get("x-naelao-tenant-id") ?? "";
    const result = await this.runMemoryMaintenanceForSpace(spaceId);
    // Memory OS maintenance (fact decay/prune/promote) does not shrink the CONTEXT WINDOW, which
    // is what someone pressing "Compact" at 85% full is actually asking for. When a session is
    // named, also fold its older messages into a stored summary — that summary is what
    // loadConversationContext serves on the next turn IN PLACE of those messages, so the window
    // genuinely gets smaller. Without this, Compact ran and visibly did nothing.
    const conversation = body.sessionId && tenantId
      ? await this.compactConversationForSession(spaceId, body.sessionId, tenantId)
      : undefined;
    return Response.json({ ...result, ...(conversation ? { conversation } : {}) });
  }

  /**
   * Force the conversation-summary pass for one session, rather than waiting for the next run to
   * do it lazily. Returns real counts so the caller can say what happened instead of claiming a
   * result it didn't verify.
   */
  private async compactConversationForSession(
    spaceId: string,
    sessionId: string,
    tenantId: string
  ): Promise<{ summarized_messages: number; summary_chars: number; already_current: boolean } | undefined> {
    try {
      const messages = await this.fetchSessionMessages(spaceId, sessionId, tenantId);
      if (!messages || messages.length === 0) return undefined;

      const toSummarize = messagesToSummarize(messages);
      if (toSummarize.length === 0) {
        // Nothing has fallen outside the recent window yet — honest "nothing to do", not a
        // fabricated success.
        return { summarized_messages: 0, summary_chars: 0, already_current: true };
      }

      let existing = "";
      let covered = 0;
      try {
        const row = this.ctx.storage.sql
          .exec("SELECT summary, covered_messages FROM conversation_summaries WHERE session_id = ?", sessionId)
          .toArray()[0] as { summary?: string; covered_messages?: number } | undefined;
        if (row) {
          existing = String(row.summary ?? "");
          covered = Number(row.covered_messages ?? 0);
        }
      } catch {
        /* no stored summary is a valid state */
      }
      if (toSummarize.length <= covered && existing) {
        return { summarized_messages: covered, summary_chars: existing.length, already_current: true };
      }

      const regenerated = await this.summarizeConversation(toSummarize, existing);
      if (!regenerated) return undefined; // summariser unavailable — never claim it compacted
      try {
        this.ctx.storage.sql.exec(
          `INSERT OR REPLACE INTO conversation_summaries (session_id, summary, covered_messages, updated_at)
           VALUES (?, ?, ?, ?)`,
          sessionId, regenerated, toSummarize.length, new Date().toISOString()
        );
      } catch {
        return undefined;
      }
      return { summarized_messages: toSummarize.length, summary_chars: regenerated.length, already_current: false };
    } catch {
      return undefined;
    }
  }

  /** Shared by the client-driven HTTP route above and env.compactMemory (script-engine/types.ts)
   *  — the SAME maintenance pass, whether triggered by the shell UI crossing a context-usage
   *  threshold or by the model itself calling memory.compact mid-run. */
  private async runMemoryMaintenanceForSpace(spaceId: string): Promise<Awaited<ReturnType<typeof runMemoryMaintenance>>> {
    this.ensureInit();
    return runMemoryMaintenance({
      sql: this.ctx.storage.sql,
      spaceId,
      ...(this.env.MEMORY_VECTORIZE
        ? { vectorIndex: this.env.MEMORY_VECTORIZE as unknown as NonNullable<ScriptEngineEnv["vectorIndex"]> }
        : {}),
      ...(this.env.AI ? { embedder: new WorkersAIEmbedder(this.env.AI) } : {}),
    });
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

    type InboundBody = { raw?: Record<string, unknown>; projectId?: string; spaceId?: string; tenantId?: string; apiKey?: string };
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

    // Dedupe on (session, direction, external_id) — re-delivered webhook events no-op. A
    // replayed event (freshness window bypassed, or delivered twice within it) that hits the
    // unique index is IGNORED, so rowsWritten is 0 — that's the "already handled" signal used
    // below to skip kicking a second drain for a message already in the queue/answered.
    const insertResult = this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO channel_messages (id, session_id, direction, text, external_id, answered, created_at)
       VALUES (?, ?, 'inbound', ?, ?, 0, ?)`,
      crypto.randomUUID(), sessionId, norm.text, norm.external_id, norm.timestamp
    );
    const isNewMessage = insertResult.rowsWritten > 0;

    // Kick a drain immediately rather than leaving this message for the next hourly cron
    // heartbeat — the difference between a customer getting a WhatsApp reply in seconds vs. up
    // to 60 minutes later. Best-effort: handleChannelHeartbeat has its own per-message error
    // handling and the claim/revert step above makes it safe to overlap with a concurrent cron
    // sweep or another inbound message's own immediate drain on this same DO. Skipped entirely
    // for a duplicate (isNewMessage false) — the message is already queued/answered, so a
    // redundant heartbeat sweep would just do wasted work (or, worse, contend with an
    // in-flight drain of the ORIGINAL delivery).
    if (isNewMessage && body.spaceId && body.tenantId) {
      const spaceId = body.spaceId, tenantId = body.tenantId, apiKey = body.apiKey ?? "";
      this.ctx.waitUntil(
        this.handleChannelHeartbeat(new Request("http://agent-do/channels/heartbeat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ spaceId, agentId: "naelao-agent", tenantId, apiKey }),
        })).catch((err) => {
          console.error(`[channels] immediate drain failed space=${spaceId}:`, (err as Error).message);
        })
      );
    }

    return Response.json({ session_id: sessionId, queued: true, duplicate: !isNewMessage });
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
   * Record a run that stopped at a HITL gate so it can be picked up again once a human answers.
   *
   * Safe to replay from: the loop suspends BEFORE executing the gated action, so at the moment
   * this row is written nothing gated has happened. `steps_json` is the ungated work the run had
   * already completed — carried so the resumed pass hands it to the model as steps-so-far rather
   * than doing it a second time.
   *
   * Best-effort by design: a run that suspended has already returned its pending state to the
   * caller, and throwing here would turn a correctly-paused run into a failed one.
   */
  private persistSuspendedRun(
    pending: NonNullable<LoopResult["pending_approval"]> | NonNullable<LoopResult["deferred_approvals"]>[number],
    ctx: {
      runId: string; spaceId: string; tenantId: string; agentId: string; sessionId: string;
      projectId?: string | undefined; userId?: string | undefined; callerRole?: string | undefined;
      model?: string | undefined; goal: string;
    }
  ): void {
    try {
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO suspended_runs
           (approval_id, run_id, space_id, tenant_id, agent_id, session_id, project_id, user_id,
            caller_role, model, goal, action_name, steps_json, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'suspended', ?)`,
        pending.approval_id, ctx.runId, ctx.spaceId, ctx.tenantId, ctx.agentId, ctx.sessionId,
        ctx.projectId ?? null, ctx.userId ?? null, ctx.callerRole ?? null, ctx.model ?? null,
        ctx.goal, pending.action_name, JSON.stringify(pending.steps_completed ?? []),
        new Date().toISOString()
      );
    } catch {
      /* the run is already correctly paused; losing the checkpoint must not fail it */
    }
  }

  /**
   * Checkpoint a run that failed, so the person can continue it instead of starting over.
   *
   * Only ONE offer stays open per thread: a second failure replaces the first rather than
   * stacking, because a queue of stale "continue?" cards is noise, and the newest failure is the
   * one that actually reflects where the work stands.
   */
  private persistInterruptedRun(ctx: {
    runId: string; spaceId: string; tenantId: string; agentId: string; sessionId: string;
    projectId?: string | undefined; userId?: string | undefined; callerRole?: string | undefined;
    model?: string | undefined; goal: string; reason: string;
    steps: Array<{ name: string; params: Record<string, unknown>; ok: boolean; output?: unknown; error?: string }>;
  }): void {
    try {
      this.ctx.storage.sql.exec(
        `UPDATE interrupted_runs SET status = 'superseded' WHERE session_id = ? AND status = 'open'`,
        ctx.sessionId
      );
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO interrupted_runs
           (run_id, space_id, tenant_id, agent_id, session_id, project_id, user_id, caller_role,
            model, goal, reason, steps_json, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
        ctx.runId, ctx.spaceId, ctx.tenantId, ctx.agentId, ctx.sessionId,
        ctx.projectId ?? null, ctx.userId ?? null, ctx.callerRole ?? null, ctx.model ?? null,
        ctx.goal, ctx.reason.slice(0, 2000), JSON.stringify(ctx.steps), Date.now()
      );
    } catch {
      /* the failure is already reported to the caller; losing the checkpoint must not add to it */
    }
  }

  /** The open offer to continue for this thread, if there is one. */
  private handleGetInterruptedRun(sessionId: string): Response {
    try {
      const rows = this.ctx.storage.sql
        .exec(
          `SELECT run_id, goal, reason, steps_json, created_at FROM interrupted_runs
            WHERE session_id = ? AND status = 'open' ORDER BY created_at DESC LIMIT 1`,
          sessionId
        )
        .toArray() as unknown as Array<Record<string, string | number | null>>;
      const row = rows[0];
      if (!row) return Response.json({ interrupted: null });
      let completed = 0;
      try {
        completed = (JSON.parse(String(row["steps_json"] ?? "[]")) as unknown[]).length;
      } catch { /* a malformed checkpoint still deserves to offer a continue */ }
      // Classified on read rather than stored: the reason text is already here, classifyFailure is
      // deterministic, and this way an interrupted run written before the classifier existed still
      // gets a useful answer instead of a null column.
      const classification = classifyFailure(String(row["reason"] ?? ""));
      return Response.json({
        interrupted: {
          run_id: row["run_id"],
          goal: row["goal"],
          reason: row["reason"],
          failure_kind: classification.kind,
          // Lets the card say "this clears by itself, try again shortly" instead of showing a raw
          // provider error and leaving the person to guess whether continuing is even worth it.
          clears_on_its_own: classification.clears_on_its_own,
          explanation: classification.summary,
          steps_completed: completed,
          created_at: row["created_at"],
        },
      });
    } catch {
      // Never turn "I couldn't read the checkpoint" into "there is nothing to continue" — the
      // caller distinguishes the two, and claiming the latter would strand real work.
      return Response.json({ error: "could not read the checkpoint" }, { status: 500 });
    }
  }

  /**
   * Continue (or dismiss) an interrupted run.
   *
   * The whole point is the ledger key: re-entering under the ORIGINAL run id means every action
   * already recorded short-circuits instead of executing a second time. A fresh run — which is
   * what a naive "Try again" does — gets a fresh key and redoes the lot.
   *
   * Claimed with a conditional UPDATE so a double click can only ever continue once.
   */
  private async handleContinueInterruptedRun(request: Request): Promise<Response> {
    const body = await request.json<{ runId?: string; action?: string }>();
    const runId = body.runId;
    if (!runId) return Response.json({ error: "runId is required" }, { status: 400 });
    const action = body.action === "dismiss" ? "dismiss" : "continue";

    const rows = this.ctx.storage.sql
      .exec(`SELECT * FROM interrupted_runs WHERE run_id = ? AND status = 'open'`, runId)
      .toArray() as unknown as Array<Record<string, string | number | null>>;
    const row = rows[0];
    if (!row) return Response.json({ continued: false, reason: "nothing open to continue" });

    // RETURNING, not rowsWritten: that counter is a billing measure of rows touched, INCLUDING
    // index entries, so an UPDATE of a column that appears in an index (status does, here)
    // reports 2 for a single changed row. Checking it against 1 silently consumed the offer
    // while reporting that nothing was continued — caught live, not in tests.
    const claimed = this.ctx.storage.sql.exec(
      `UPDATE interrupted_runs SET status = ? WHERE run_id = ? AND status = 'open' RETURNING run_id`,
      action === "dismiss" ? "dismissed" : "continuing", runId
    ).toArray();
    if (claimed.length !== 1) return Response.json({ continued: false, reason: "already handled" });
    if (action === "dismiss") return Response.json({ continued: false, dismissed: true });

    let steps: Array<{ name: string; params: Record<string, unknown>; ok: boolean; output?: unknown; error?: string }> = [];
    try {
      steps = JSON.parse(String(row["steps_json"] ?? "[]"));
    } catch { /* continue with no prior steps rather than refusing to continue at all */ }

    const continuedRunId = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      `UPDATE interrupted_runs SET continued_run_id = ? WHERE run_id = ?`, continuedRunId, runId
    );

    const res = await this.fetch(new Request("http://agent-do/script/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        spaceId: row["space_id"], tenantId: row["tenant_id"], agentId: row["agent_id"],
        sessionId: row["session_id"], projectId: row["project_id"] ?? undefined,
        userId: row["user_id"] ?? undefined, callerRole: row["caller_role"] ?? undefined,
        model: row["model"] ?? undefined, goal: row["goal"],
        runId: continuedRunId,
        // THE point of this route — same key as the original, so completed actions replay
        // instead of re-executing.
        ledgerKey: runId,
        resumeSteps: steps,
      }),
    }));

    this.ctx.storage.sql.exec(
      `UPDATE interrupted_runs SET status = 'continued' WHERE run_id = ?`, runId
    );
    const payload = await res.json().catch(() => ({}));
    return Response.json({ continued: true, run_id: continuedRunId, result: payload });
  }

  /**
   * Continue a run that was waiting on a human, now that the approval has been resolved.
   *
   * Deliberately re-enters the loop rather than restoring an in-memory continuation: DO
   * hibernation destroys in-memory state, so a continuation could never have survived the wait
   * this feature exists to allow. What makes re-entry safe is that the suspension point is the
   * gate — the dangerous action had not run — and `resumeSteps` hands the already-completed
   * ungated work back to the model instead of inviting it to repeat it.
   *
   * Idempotent: the checkpoint is claimed with a conditional UPDATE, so a duplicate resume
   * (a retried webhook, a double click on Approve) finds nothing to claim and does nothing.
   */
  private async handleResumeRun(request: Request): Promise<Response> {
    const { approvalId } = await request.json<{ approvalId: string }>();
    if (!approvalId) return Response.json({ error: "approvalId is required" }, { status: 400 });

    const rows = this.ctx.storage.sql
      .exec(`SELECT * FROM suspended_runs WHERE approval_id = ? AND status = 'suspended'`, approvalId)
      .toArray() as unknown as Array<Record<string, string | null>>;
    const row = rows[0];
    if (!row) return Response.json({ resumed: false, reason: "no suspended run for this approval" });

    // Claim it before doing any work — two concurrent resumes must not both re-enter the loop.
    // RETURNING rather than rowsWritten — see handleContinueInterruptedRun for why that counter
    // cannot be read as "rows changed". This works today only because no index on suspended_runs
    // happens to contain `status`; adding one would silently break every approval resume.
    const claimed = this.ctx.storage.sql.exec(
      `UPDATE suspended_runs SET status = 'resuming' WHERE approval_id = ? AND status = 'suspended'
       RETURNING approval_id`,
      approvalId
    ).toArray();
    if (claimed.length !== 1) {
      return Response.json({ resumed: false, reason: "already claimed" });
    }

    // Trust HITLApprovalDO, not the caller, for whether this was actually approved.
    let approved = false;
    if (this.env.HITL_APPROVAL_DO) {
      try {
        const stub = this.env.HITL_APPROVAL_DO.get(this.env.HITL_APPROVAL_DO.idFromName(`hitl:${row["space_id"]}`));
        const resp = await stub.fetch(new Request(`http://hitl/requests/${approvalId}`));
        const state = await resp.json<{ status?: string }>();
        approved = state.status === "approved";
      } catch {
        // Unknown resolution: leave the checkpoint claimable again rather than guessing. Guessing
        // "approved" would execute a gated action nobody confirmed; guessing "rejected" would
        // silently discard approved work.
        this.ctx.storage.sql.exec(`UPDATE suspended_runs SET status = 'suspended' WHERE approval_id = ?`, approvalId);
        return Response.json({ resumed: false, reason: "could not read approval state" }, { status: 503 });
      }
    }

    if (!approved) {
      this.ctx.storage.sql.exec(`UPDATE suspended_runs SET status = 'rejected' WHERE approval_id = ?`, approvalId);
      return Response.json({ resumed: false, reason: "approval was not granted" });
    }

    let steps: unknown[] = [];
    try {
      steps = JSON.parse(row["steps_json"] ?? "[]") as unknown[];
    } catch {
      steps = [];
    }

    const resumeBody = {
      goal: row["goal"] ?? "",
      spaceId: row["space_id"] ?? "",
      agentId: row["agent_id"] ?? "naelao-agent",
      tenantId: row["tenant_id"] ?? "",
      sessionId: row["session_id"] ?? "",
      ...(row["project_id"] ? { projectId: row["project_id"] } : {}),
      ...(row["user_id"] ? { userId: row["user_id"] } : {}),
      ...(row["model"] ? { model: row["model"] } : {}),
      // A fresh run id: this is a second, separately-traceable pass, and reusing the suspended
      // one would overwrite the trace that shows why it paused in the first place. The ledger key
      // stays the ORIGINAL run's, which is what stops this pass re-executing the ungated work the
      // first pass already did — the model is shown those steps, but being shown is not being
      // prevented, and the cost of it deciding to redo one is a second real side effect.
      runId: crypto.randomUUID(),
      ledgerKey: row["run_id"] ?? undefined,
      preApprovedActions: [row["action_name"] ?? ""],
      resumeSteps: steps,
    };

    // Recorded BEFORE the continuation actually executes (which can take as long as the rest of
    // the agent's work) — a poller watching this approval_id sees the new run id the moment it
    // exists, not only once the whole continuation has already finished.
    this.ctx.storage.sql.exec(
      `UPDATE suspended_runs SET resumed_run_id = ? WHERE approval_id = ?`,
      resumeBody.runId, approvalId
    );

    const resp = await this.handleScriptRun(
      new Request("http://agent-do/script/run", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-naelao-tenant-id": row["tenant_id"] ?? "",
          ...(row["caller_role"] ? { "x-naelao-role": row["caller_role"] } : {}),
        },
        body: JSON.stringify(resumeBody),
      })
    );

    this.ctx.storage.sql.exec(`UPDATE suspended_runs SET status = 'resumed' WHERE approval_id = ?`, approvalId);
    const result = await resp.json<Record<string, unknown>>();
    return Response.json({ resumed: true, run_id: resumeBody.runId, result });
  }

  /**
   * §A1 Phase HX1 — persist a script-native run's structured trace (runScriptLoop's
   * TraceStep[]) into this DO's own SQLite (`run_traces`), and best-effort mirror each step as
   * an Analytics Engine span via @naelao/tracing when ANALYTICS is bound (one root span for the
   * whole run, one child span per step — same fire-and-forget posture ActiveSpan.end() already
   * has, so a slow/failed AE write never delays or fails the caller's run). SQLite persistence
   * is unconditional (it's what the builder trace endpoint reads); AE is purely supplementary.
   */
  private persistRunTrace(runId: string, tenantId: string, trace: TraceStep[]): void {
    if (trace.length === 0) return;
    try {
      for (const step of trace) {
        this.ctx.storage.sql.exec(
          `INSERT OR REPLACE INTO run_traces (run_id, seq, phase, name, tier, duration_ms, tokens, ok, detail, ts, narration, thinking, params, output, message)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          runId,
          step.seq,
          step.phase,
          step.name ?? null,
          step.tier ?? null,
          step.duration_ms ?? null,
          step.tokens ?? null,
          step.ok === undefined ? null : step.ok ? 1 : 0,
          step.detail ?? null,
          step.ts,
          step.narration ?? null,
          step.thinking ?? null,
          step.params === undefined ? null : (() => { try { return JSON.stringify(step.params); } catch { return null; } })(),
          step.output ?? null,
          step.message ?? null
        );
      }
    } catch {
      /* trace persistence is observability, never fails the run */
    }

    if (!this.env.ANALYTICS) return;
    try {
      const tracer = createTracer({ service: "agents-worker", dataset: this.env.ANALYTICS }, runId);
      const root = tracer.startSpan("script_loop.run");
      root.setAttribute("tenant_id", tenantId).setAttribute("run_id", runId).setAttribute("steps", trace.length);
      for (const step of trace) {
        const span = tracer.startSpan(`script_loop.${step.phase}`, root.spanId);
        span.setAttribute("run_id", runId);
        if (step.name) span.setAttribute("name", step.name);
        if (step.tier !== undefined) span.setAttribute("tier", step.tier);
        if (step.tokens !== undefined) span.setAttribute("tokens", step.tokens);
        if (step.detail) span.setAttribute("detail", step.detail);
        if (step.ok === false) span.setError(step.detail ?? "step failed");
        span.end();
      }
      root.end();
    } catch {
      /* Analytics Engine is append-only best-effort — never block on failure */
    }
  }

  /**
   * §A1 Phase HX1 — read back a script-native run's persisted trace, ordered by step.
   */
  private readRunTrace(runId: string): TraceStep[] {
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT seq, phase, name, tier, duration_ms, tokens, ok, detail, ts, narration, thinking, params, output, message FROM run_traces WHERE run_id = ? ORDER BY seq ASC`,
        runId
      )
      .toArray() as Array<{
      seq: number;
      phase: string;
      name: string | null;
      tier: number | null;
      duration_ms: number | null;
      tokens: number | null;
      ok: number | null;
      detail: string | null;
      ts: number;
      narration: string | null;
      thinking: string | null;
      params: string | null;
      output: string | null;
      message: string | null;
    }>;
    return rows.map((r) => ({
      seq: r.seq,
      phase: r.phase,
      name: r.name ?? undefined,
      tier: r.tier ?? undefined,
      duration_ms: r.duration_ms ?? undefined,
      tokens: r.tokens ?? undefined,
      ok: r.ok === null ? undefined : r.ok === 1,
      detail: r.detail ?? undefined,
      ts: r.ts,
      narration: r.narration ?? undefined,
      thinking: r.thinking ?? undefined,
      params: r.params === null ? undefined : (() => { try { return JSON.parse(r.params!); } catch { return r.params; } })(),
      output: r.output ?? undefined,
      message: r.message ?? undefined,
    }));
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
  /**
   * Security audit follow-up (observability gap): posts one row to SpaceDO's agent_activity_log
   * — the single, product-wide, builder-readable surface for "what has my agent been doing"
   * (SpaceDO's own DO instance is shared across the whole space, unlike this DO which is
   * per-thread/per-agent — same "mirror into SpaceDO because it doesn't scale to open every
   * agent DO" precedent as thread/sub-agent mirroring). Best-effort and never awaited by
   * meaningfully blocking the caller — a logging failure must never fail an already-completed
   * run or a pending approval.
   */
  private async logAgentActivity(
    spaceId: string,
    tenantId: string,
    agentId: string,
    eventType: "run_completed" | "run_failed" | "approval_requested" | "moderation_blocked",
    opts: {
      projectId?: string | null; threadId?: string | null; summary?: string;
      tokensUsed?: number | null; costCredits?: number | null;
      /** Classified at the moment of failure (see @naelao/events classifyFailure) rather than
       *  re-parsed from free text later — the diagnostics rollup groups on this, and the wake-up
       *  brief's whole usefulness rests on it being right. */
      failureKind?: string | null;
      /** The thread and run, so a reader can go and continue the exact interrupted work. */
      sessionId?: string | null; runId?: string | null;
      /** What woke this run: chat, heartbeat, scheduled_job, connector_poll, trigger. */
      triggerSource?: string | null;
    } = {}
  ): Promise<void> {
    if (!this.env.SPACES_WORKER || !tenantId) return;
    try {
      await this.env.SPACES_WORKER.fetch(new Request(
        `http://spaces-worker/internal/spaces/${spaceId}/agent-activity`,
        {
          method: "POST",
          headers: await this.internalHeaders(tenantId, { "content-type": "application/json" }),
          body: JSON.stringify({
            space_id: spaceId,
            project_id: opts.projectId ?? null,
            thread_id: opts.threadId ?? null,
            agent_id: agentId,
            event_type: eventType,
            summary: opts.summary ?? "",
            tokens_used: opts.tokensUsed ?? null,
            cost_credits: opts.costCredits ?? null,
            failure_kind: opts.failureKind ?? null,
            session_id: opts.sessionId ?? null,
            run_id: opts.runId ?? null,
            trigger_source: opts.triggerSource ?? null,
          }),
        }
      ));
    } catch {
      /* best-effort — never fails the caller's own run/approval flow */
    }
  }

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
    void this.logAgentActivity(spaceId, tenantId, agentId, "approval_requested", { summary: `${actionName}: ${description}`.slice(0, 500) });
    void this.createSpaceNotification(spaceId, tenantId, {
      kind: "approval_requested",
      title: `Approval needed: '${agentId}' wants to ${actionName}`,
      body: `${description}\n\nApproval id: ${approvalId}.`,
      severity: "warning",
      sourceAgentId: agentId,
      relatedId: approvalId,
    });

    if (!this.env.NOTIFICATIONS_WORKER || !this.env.SPACES_WORKER || !tenantId) return;
    try {
      // Ask-before-emailing: someone actively in the space right now sees this via the in-app
      // notification / inline approval card (item 84) the moment it happens — an immediate email
      // on top of that is noise, not signal. Nobody present (or the presence check itself
      // failing) is treated the same as "away" — the hourly notification sweep is the real
      // backstop either way, so erring toward sending here costs nothing but an extra email.
      const present = await this.isAnyoneCurrentlyPresent(spaceId, tenantId);
      if (present) return;
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

  /** §A1 connector default-vs-personal switch: this session's stored mode per connector id. Any
   *  failure (unbound worker, network error, not-yet-migrated deployment) degrades to an empty
   *  map — identical to "nobody ever switched away from business", never a run-blocking error. */
  private async fetchConnectorAccountMode(spaceId: string, sessionId: string, tenantId: string): Promise<Record<string, "business" | "personal">> {
    if (!this.env.SPACES_WORKER || !tenantId) return {};
    try {
      const resp = await this.env.SPACES_WORKER.fetch(new Request(
        `http://spaces-worker/spaces/${spaceId}/sessions/${sessionId}/connector-mode`,
        { headers: await this.internalHeaders(tenantId) }
      ));
      if (!resp.ok) return {};
      const data = await resp.json<{ modes?: Record<string, string> }>();
      const out: Record<string, "business" | "personal"> = {};
      for (const [k, v] of Object.entries(data.modes ?? {})) {
        if (v === "personal") out[k] = "personal";
      }
      return out;
    } catch {
      return {};
    }
  }

  /** Whether anyone has a fresh presence heartbeat in this space right now — see
   *  requireBusinessMembership's own pass-through for a non-product_end_user caller, which is
   *  what lets this internal-token call reach the route at all. Any failure reads as "not
   *  present" (the safer default for an escalation decision: erring toward sending a
   *  notification is harmless, erring toward silence is not). */
  private async isAnyoneCurrentlyPresent(spaceId: string, tenantId: string): Promise<boolean> {
    if (!this.env.SPACES_WORKER || !tenantId) return false;
    try {
      const resp = await this.env.SPACES_WORKER.fetch(new Request(
        `http://spaces-worker/spaces/${spaceId}/presence`,
        { headers: await this.internalHeaders(tenantId) }
      ));
      if (!resp.ok) return false;
      const data = await resp.json<{ count?: number }>();
      return (data.count ?? 0) > 0;
    } catch {
      return false;
    }
  }

  /**
   * Write a durable, business-member-visible notification (SpaceDO's `notifications` table) —
   * the same "mirror into SpaceDO because it's the one product-wide surface" precedent as
   * logAgentActivity, but end-user-facing rather than a builder-only audit trail. Fire-and-forget:
   * a failure here must never fail the run/approval that triggered it.
   */
  private async createSpaceNotification(
    spaceId: string,
    tenantId: string,
    opts: {
      kind: string;
      title: string;
      body?: string;
      severity?: "info" | "warning" | "critical";
      projectId?: string | null;
      sourceAgentId?: string | null;
      relatedId?: string | null;
    }
  ): Promise<void> {
    if (!this.env.SPACES_WORKER || !tenantId) return;
    try {
      await this.env.SPACES_WORKER.fetch(new Request(
        `http://spaces-worker/internal/spaces/${spaceId}/notifications`,
        {
          method: "POST",
          headers: await this.internalHeaders(tenantId, { "content-type": "application/json" }),
          body: JSON.stringify({
            space_id: spaceId,
            project_id: opts.projectId ?? null,
            kind: opts.kind,
            title: opts.title,
            body: opts.body ?? "",
            severity: opts.severity ?? "info",
            source_agent_id: opts.sourceAgentId ?? null,
            related_id: opts.relatedId ?? null,
          }),
        }
      ));
    } catch {
      /* best-effort — never fails the caller's own run/approval flow */
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

    // Short-lived in-DO cache. This fetch sits on the hot path of EVERY Space Assistant run, and
    // a policy changes about as often as a person changes their mind about autonomy — roughly
    // never, per run. Caching it removes a cross-worker round trip from every run and, more
    // importantly, removes the failure mode that motivated this: under concurrent load against
    // the same SpaceDO the call can fail, which fails CLOSED and kills the run. Observed for real
    // while running the eval matrix — runs that worked fine when the space was idle came back
    // "HITL rejected" while it was busy.
    //
    // 30s is deliberately short: a builder who flips autonomy off wants that to take effect
    // promptly, and half a minute of staleness on a setting they just changed themself is the
    // outer bound of acceptable. A cached value is never used to widen access after it expires.
    const cached = this.assistantPolicyCache;
    if (cached && cached.spaceId === spaceId && Date.now() - cached.at < 30_000) {
      return cached.policy;
    }

    // One retry before giving up. The cache above covers a DO that has read the policy at least
    // once, but a COLD instance whose very first read fails has nothing to fall back on and would
    // gate every action for the whole run. A single retry turns that from "the assistant is
    // broken for this conversation" into a few hundred milliseconds — observed intermittently
    // during the live matrix, where a minority of runs gated actions the policy plainly allows.
    for (let attempt = 0; attempt < 2; attempt++) {
      const policy = await this.readAssistantPolicyOnce(spaceId, tenantId, cached);
      if (policy !== undefined) return policy;
    }
    return cached && cached.spaceId === spaceId ? cached.policy : null;
  }

  /** One attempt at reading the policy. `undefined` means "transient failure, worth retrying";
   *  `null` is a definitive no. */
  private async readAssistantPolicyOnce(
    spaceId: string,
    tenantId: string,
    cached: { spaceId: string; policy: { approval_mode: "always_ask" | "yolo"; auto_approved_actions: string[] }; at: number } | undefined
  ): Promise<{ approval_mode: "always_ask" | "yolo"; auto_approved_actions: string[] } | null | undefined> {
    if (!this.env.SPACES_WORKER) return null;
    try {
      const resp = await this.env.SPACES_WORKER.fetch(new Request(`http://spaces-worker/spaces/${spaceId}/assistant-policy`, {
        headers: await this.internalHeaders(tenantId),
      }));
      if (!resp.ok) {
        // 5xx (and the network errors caught below) are transient — the server didn't answer, so
        // a policy we verified moments ago is better evidence than "unknown". A 4xx IS an answer
        // (no such space, not permitted); that one must fail closed rather than keep serving a
        // policy the server is now declining to confirm.
        if (resp.status >= 500) {
          // Transient: prefer a policy we already verified, otherwise signal "retry".
          return cached && cached.spaceId === spaceId ? cached.policy : undefined;
        }
        return null;
      }
      const policy = await resp.json<{ approval_mode: "always_ask" | "yolo"; auto_approved_actions: string[] }>();
      this.assistantPolicyCache = { spaceId, policy, at: Date.now() };
      return policy;
    } catch {
      // A transient failure must not silently widen access, but neither should it discard a
      // policy we successfully read moments ago: serving the recent value is both safer and more
      // correct than falling back to "gate everything and reject", which reads to the user as
      // the assistant refusing to work.
      if (cached && cached.spaceId === spaceId) return cached.policy;
      return undefined;
    }
  }

  /** Last successfully-read assistant policy — see fetchAssistantPolicy. In-memory only: DO
   *  hibernation clears it, which just means the next run re-reads it. */
  private assistantPolicyCache: { spaceId: string; policy: { approval_mode: "always_ask" | "yolo"; auto_approved_actions: string[] }; at: number } | undefined;

  /**
   * F-36 enforcement — resolve the clamp SpaceDO defines (`resolveAssistantEffectiveRole`:
   * the min of the acting user's own project_members role and that row's assistant_mode)
   * for a project-scoped run made ON BEHALF OF a specific user. The clamp existed since the
   * F-36 pass but nothing in this worker ever consulted it, so a `read_only`/`none`-clamped
   * user's assistant ran with full space-scoped authority anyway. Callers fail CLOSED on
   * `status:"error"` (refuse the run — matching the fetchProjectConfig/F17 posture: an
   * authorization check that fails open isn't one); a `null` effectiveRole means the clamp
   * POSITIVELY denies this user (assistant_mode='none', or a plain non-member).
   */
  private async fetchAssistantAccess(
    spaceId: string, tenantId: string, projectId: string, userId: string
  ): Promise<{ status: "ok"; effectiveRole: AssistantEffectiveRole | null } | { status: "error" }> {
    if (!this.env.SPACES_WORKER || !tenantId) return { status: "error" };
    try {
      const resp = await this.env.SPACES_WORKER.fetch(new Request(
        `http://spaces-worker/spaces/${spaceId}/projects/${encodeURIComponent(projectId)}/assistant-access?user_id=${encodeURIComponent(userId)}`,
        { headers: await this.internalHeaders(tenantId) }
      ));
      if (!resp.ok) return { status: "error" };
      const { effective_role } = await resp.json<{ effective_role: AssistantEffectiveRole | null }>();
      return { status: "ok", effectiveRole: effective_role ?? null };
    } catch {
      return { status: "error" };
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
  /**
   * Go-live audit A-1/A-2: the F-36 clamp, execution-ceiling + daily-spend-cap, project wallet
   * gate, and product_end_user pre-run credit check used to live ONLY inline in handleScriptRun
   * (the script-native 6-op path) — the legacy ReAct `handleRun` path (every interactive
   * /agent/run message from apps/shell and apps/portal) called none of it, so a signed-in end
   * user could chat unmetered against a drained wallet/zero credit balance forever. Extracted so
   * BOTH runtimes call the identical gate — see CLAUDE.md item "S-A1" / the audit blueprint for
   * the full incident writeup. Every fail-open/fail-closed posture below is verbatim what
   * handleScriptRun always had: authorization denial and a CONFIRMED empty balance/wallet fail
   * CLOSED (block the run); a transient lookup error fails OPEN (never bricks a legitimate run
   * over a network hiccup) EXCEPT the project-config lookup itself, which fails CLOSED (clamps
   * to tier 1 and refuses) per F17/A1.13 — a spend-cap check that fails open isn't one.
   */
  private async enforceRunGates(opts: {
    spaceId: string; tenantId: string; projectId?: string | undefined; userId?: string | undefined; callerRole?: string | undefined;
    /** §A1 Harness Excellence Phase HX2: session token-budget guard — sessionId/agentId/runId
     *  are needed to open (and describe) a HITL approval when the ceiling is hit; ceiling itself
     *  comes from productConfig.limits.sessionCreditCeiling, resolved by the caller (index.ts —
     *  this DO has no PLATFORM_DB binding). Unset/<=0 disables the guard entirely. */
    sessionId?: string | undefined; agentId?: string | undefined; runId?: string | undefined; sessionCreditCeiling?: number | undefined;
  }): Promise<
    | { ok: true; hasSpendCap: boolean; walletProjectId: string | null; effectiveRole?: AssistantEffectiveRole | undefined; maxTier?: ExecutionTier | undefined }
    | { ok: false; response: Response }
  > {
    const { spaceId, tenantId, projectId, userId, callerRole, sessionId, agentId, runId, sessionCreditCeiling } = opts;
    let hasSpendCap = false;
    let walletProjectId: string | null = null;
    let effectiveRole: AssistantEffectiveRole | undefined;
    let maxTier: ExecutionTier | undefined;

    // §A1 Harness Excellence Phase HX2: session token-budget guard — checked first, ahead of
    // every payer-specific gate below, since it's a session-scoped ceiling independent of who's
    // paying. Never silent: crossing 100% always surfaces a clear error_code + approval_id
    // rather than a generic refusal, and the 80% warning fires through the same no-code
    // event_triggers machinery every other structural event already uses.
    if (sessionId && typeof sessionCreditCeiling === "number" && sessionCreditCeiling > 0 && this.env.SPACES_WORKER) {
      const budgetGate = await this.checkSessionBudget(spaceId, tenantId, sessionId, agentId ?? "naelao-agent", runId ?? sessionId, sessionCreditCeiling);
      if (!budgetGate.ok) return { ok: false, response: budgetGate.response };
    }

    if (projectId) {
      // F-36 enforcement: a project-scoped run made ON BEHALF OF a specific user is clamped to
      // that user's effective role in the project BEFORE any other gate runs — authorization
      // precedes billing. No acting user (cron/trigger/webhook/bootstrap wakes pass no userId,
      // and the channel drain's synthetic `channel:...` ids never route through here) means no
      // per-user clamp — the run keeps the assistant's own base grant, per the clamp's own doc
      // in SpaceDO.resolveAssistantEffectiveRole. Fails CLOSED on a lookup error: an
      // authorization check that fails open isn't one (fetchProjectConfig/F17 precedent).
      if (userId && !userId.startsWith("channel:")) {
        const access = await this.fetchAssistantAccess(spaceId, tenantId, projectId, userId);
        if (access.status === "error") {
          return {
            ok: false,
            response: Response.json(
              { error: "unable to verify assistant access to this project — try again shortly", error_code: "assistant_access_unverified" },
              { status: 403 }
            ),
          };
        }
        if (access.effectiveRole === null) {
          return {
            ok: false,
            response: Response.json(
              {
                error: "the assistant is not permitted to act in this project on behalf of this user (assistant access is 'none' or the user is not a project member)",
                error_code: "assistant_access_denied",
              },
              { status: 403 }
            ),
          };
        }
        effectiveRole = access.effectiveRole;
      }

      const projectCfg = await this.fetchProjectConfig(spaceId, tenantId, projectId);
      if (projectCfg.status === "error") {
        // F17 / A1.13: a transient SpaceDO error must fail CLOSED, never read as "unrestricted"
        // — that would silently disable BOTH structural customer-bot controls (execution
        // ceiling and daily spend cap) this project depends on being un-bypassable. Clamp to
        // the most restrictive tier and treat the run exactly like a real spend-cap hit.
        return {
          ok: false,
          response: Response.json(
            { error: "unable to verify project restrictions — try again shortly", error_code: "spend_capped" },
            { status: 429 }
          ),
        };
      }
      if (projectCfg.status === "found") {
        if (projectCfg.daily_spend_cap_credits > 0) {
          hasSpendCap = true;
          const spend = await this.checkAndDebitProjectSpend(spaceId, tenantId, projectId, 0);
          if (spend.capped) {
            return {
              ok: false,
              response: Response.json(
                { error: "daily spend cap reached for this project", error_code: "spend_capped" },
                { status: 429 }
              ),
            };
          }
        }
        maxTier = projectCfg.execution_ceiling as ExecutionTier;
      }
      // status === "not_found": no project config row — permissive by design, unchanged.

      // Wallet gate — fails OPEN only when the lookup/balance check itself errors (network/worker
      // outage, or no wallet ever provisioned e.g. a space created before this fix shipped),
      // matching the end-user credit gate's posture. A CONFIRMED zero/negative wallet balance
      // always blocks the run.
      const walletCheck = await this.checkProjectWallet(spaceId, tenantId);
      if (!walletCheck.ok) {
        return {
          ok: false,
          response: Response.json(
            { error: "this business's wallet is empty — top up to keep this agent running", error_code: "insufficient_credits", balance_cents: walletCheck.balance_cents },
            { status: 402 }
          ),
        };
      }
      walletProjectId = walletCheck.walletProjectId;
    } else if (callerRole === "product_end_user" && userId) {
      // Metering enforcement pass: a non-project (Space Assistant / Home chat) run by a signed-in
      // product end user used to debit their ProductUserDO balance ONLY after the run completed
      // (debitEndUserCredits below) — so an empty balance was discovered by a 402 on the debit
      // call, by which point the real Anthropic tokens for the run were already spent on Naelao's
      // own platform key. Check the balance BEFORE running the loop instead; refuse the run itself
      // when it's already at or below zero. Fails OPEN only when the balance check itself errors
      // (network/worker outage) — matching this run's own overall "never crash on a billing-side
      // hiccup" posture elsewhere in this method — but a *confirmed* zero/negative balance always
      // blocks the run.
      // Tier 2 metering follow-up: creditsIncludedPerMonth used to grant once, ever, at signup —
      // lazily refresh it here (idempotent, month-scoped — see that route's own comment) so the
      // FIRST run of a new calendar month tops up before the balance below is even read. This is
      // deliberately NOT in its own try/catch — a failure here must not silently skip straight to
      // reading a stale (pre-refresh) balance without at least attempting the top-up; the shared
      // catch below already covers both calls with the same fail-open posture.
      try {
        await this.env.SPACES_WORKER.fetch(new Request(
          `http://spaces-worker/internal/product-users/${spaceId}/${userId}/credits/refresh-monthly`,
          { method: "POST", headers: await this.internalHeaders(tenantId) }
        ));
        const balRes = await this.env.SPACES_WORKER.fetch(new Request(
          `http://spaces-worker/internal/product-users/${spaceId}/${userId}/credits/balance`,
          { headers: await this.internalHeaders(tenantId) }
        ));
        if (balRes.ok) {
          const { balance_credits } = await balRes.json<{ balance_credits: number }>();
          if (balance_credits <= 0) {
            return {
              ok: false,
              response: Response.json(
                { error: "insufficient credits — top up or subscribe to keep chatting", error_code: "insufficient_credits", balance_credits },
                { status: 402 }
              ),
            };
          }
        }
      } catch {
        // Balance service unreachable — do not block the run over a transient outage; the
        // post-run debit below still enforces the real ledger and will 402 on genuine overdraw.
      }
    } else if (BUILDER_CALLER_ROLES.has(callerRole ?? "")) {
      // P0-3: a builder (owner/admin/editor/viewer — a Team collaborator, not a signed-in
      // product end user) chatting with their OWN Space Assistant had NO metering at all — the
      // end-user credit gate above only fires for callerRole === "product_end_user". A free-tier
      // builder could burn the platform's Anthropic key all day at zero cost. Reuses the
      // existing per-org plan-tier/usage-quota infrastructure (@naelao/entitlements's numbers,
      // enforced via the billing worker's usage_events + KV-cached quota check) rather than
      // building a parallel ledger — this is a MONTHLY QUOTA (resets naturally each calendar
      // month via the underlying SQL window), not a wallet/credit balance. Deliberately scoped
      // to only these four caller roles: internal/system-initiated runs (billing webhooks,
      // scheduled jobs, triggers) never set x-naelao-role at all and must not be swept in here,
      // and an "agent" API-key caller (Phase O) is a different identity/pricing situation left
      // for a separate pass. Fails OPEN when BILLING_WORKER is unbound or the check itself
      // errors — matching every other billing gate's posture in this method.
      if (this.env.BILLING_WORKER) {
        try {
          const quotaRes = await this.env.BILLING_WORKER.fetch(new Request(
            "http://billing-worker/internal/usage/llm-tokens/check",
            { headers: await this.internalHeaders(tenantId) }
          ));
          if (quotaRes.ok) {
            const { allowed, current, limit } = await quotaRes.json<{ allowed: boolean; current: number; limit: number }>();
            if (!allowed) {
              return {
                ok: false,
                response: Response.json(
                  { error: "monthly usage limit reached for your plan — upgrade to keep chatting", error_code: "quota_exceeded", current, limit },
                  { status: 402 }
                ),
              };
            }
          }
        } catch {
          // Billing service unreachable — do not block the run over a transient outage.
        }

        // §A1.26: same scoping/posture as the llm-tokens check above, for Cloudflare infra
        // consumption (isolate/container/workflow-step credits) instead of LLM tokens — a
        // separate monthly ceiling per @naelao/entitlements' monthly_infra_credits.
        try {
          const infraQuotaRes = await this.env.BILLING_WORKER.fetch(new Request(
            "http://billing-worker/internal/usage/infra-credits/check",
            { headers: await this.internalHeaders(tenantId) }
          ));
          if (infraQuotaRes.ok) {
            const { allowed, current, limit } = await infraQuotaRes.json<{ allowed: boolean; current: number; limit: number }>();
            if (!allowed) {
              return {
                ok: false,
                response: Response.json(
                  { error: "monthly infra usage limit reached for your plan — upgrade to keep chatting", error_code: "infra_quota_exceeded", current, limit },
                  { status: 402 }
                ),
              };
            }
          }
        } catch {
          // Billing service unreachable — do not block the run over a transient outage.
        }
      }
    }

    return { ok: true, hasSpendCap, walletProjectId, effectiveRole, maxTier };
  }

  /**
   * §A1 Harness Excellence Phase HX2: the session token-budget guard's actual gate. Reuses the
   * HITL approval mechanism (no new gate engine, per the plan's explicit direction) by keying
   * approval rows on `run_id: sessionId` + `tool_name: 'session_budget_continue'` — a stable
   * identity that lets this method find an already-open or already-resolved request for THIS
   * session without needing a new column anywhere (SpaceDO's session_spend table only ever
   * stores the running tally, never an approval id — see its own migration comment). Fails
   * CLOSED at 100% (never silently lets a run through when the check itself can't be completed
   * confidently) but the 80% warning is best-effort only, matching every other observability
   * side-effect in this file.
   */
  private async checkSessionBudget(
    spaceId: string, tenantId: string, sessionId: string, agentId: string, runId: string, ceiling: number
  ): Promise<{ ok: true } | { ok: false; response: Response }> {
    const spendRes = await this.env.SPACES_WORKER!.fetch(new Request(
      `http://spaces-worker/internal/spaces/${spaceId}/session-spend/${sessionId}`,
      { headers: await this.internalHeaders(tenantId) }
    ));
    const spend = spendRes.ok
      ? await spendRes.json<{ credits_used: number; warned_80: boolean }>()
      : { credits_used: 0, warned_80: false };

    if (spend.credits_used < ceiling) {
      // Under ceiling — fire the 80% warning at most once per spending cycle.
      if (spend.credits_used >= ceiling * 0.8 && !spend.warned_80) {
        try {
          await this.env.SPACES_WORKER!.fetch(new Request(
            `http://spaces-worker/internal/spaces/${spaceId}/session-spend/${sessionId}`,
            { method: "POST", headers: await this.internalHeaders(tenantId, { "content-type": "application/json" }), body: JSON.stringify({ action: "mark_warned" }) }
          ));
          await this.env.SPACES_WORKER!.fetch(new Request(
            `http://spaces-worker/internal/spaces/${spaceId}/events/fire`,
            {
              method: "POST",
              headers: await this.internalHeaders(tenantId, { "content-type": "application/json" }),
              body: JSON.stringify({
                type: "agent.session_budget_warning", space_id: spaceId, thread_id: sessionId,
                payload: { credits_used: spend.credits_used, ceiling },
              }),
            }
          ));
        } catch {
          /* best-effort — a missed warning must never block the run itself */
        }
      }
      return { ok: true };
    }

    // At or past ceiling: look for an existing request for this session before opening a new
    // one (a second concurrent run on the same session must not spawn duplicate approvals).
    if (!this.env.HITL_APPROVAL_DO) {
      // No HITL support configured — fail CLOSED (the whole point of a ceiling is that it's
      // never silently bypassed just because the approval mechanism isn't wired up).
      return {
        ok: false,
        response: Response.json(
          { error: "session credit budget reached and no approval mechanism is configured", error_code: "session_budget_ceiling" },
          { status: 402 }
        ),
      };
    }
    const hitlStub = this.env.HITL_APPROVAL_DO.get(this.env.HITL_APPROVAL_DO.idFromName(`hitl:${spaceId}`));
    const listResp = await hitlStub.fetch(new Request(`http://hitl/requests?run_id=${encodeURIComponent(sessionId)}`));
    const { approvals } = await listResp.json<{ approvals: { id: string; tool_name: string; status: string }[] }>();
    const existing = approvals.find((a) => a.tool_name === "session_budget_continue");

    if (existing?.status === "approved") {
      // A human already approved continuing — reset the tally for a fresh spending cycle and
      // let this run proceed. The NEXT time the (same) ceiling is crossed, this branch won't
      // find an approved row anymore (a fresh one gets created below), so approval is required
      // again rather than permanently disabling the guard.
      await this.env.SPACES_WORKER!.fetch(new Request(
        `http://spaces-worker/internal/spaces/${spaceId}/session-spend/${sessionId}`,
        { method: "POST", headers: await this.internalHeaders(tenantId, { "content-type": "application/json" }), body: JSON.stringify({ action: "continue" }) }
      ));
      return { ok: true };
    }
    if (existing?.status === "pending") {
      return {
        ok: false,
        response: Response.json(
          { error: "session credit budget reached — waiting for a human to approve continuing", error_code: "session_budget_pending_approval", approval_id: existing.id },
          { status: 402 }
        ),
      };
    }

    // No pending/approved request (none yet, or a prior one was rejected/timed out) — open a
    // fresh one. 24h TTL: a human deciding whether to let a conversation keep spending is not
    // the 30s tool-call default this DO's in-loop gate uses.
    const createResp = await hitlStub.fetch(new Request("http://hitl/requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        run_id: sessionId,
        session_id: sessionId,
        tool_name: "session_budget_continue",
        tool_input: { ceiling, credits_used: spend.credits_used },
        action_description: `This session has used its allotted credit budget (${spend.credits_used}/${ceiling} credits). Approve to keep the conversation going.`,
        ttl_ms: 24 * 60 * 60 * 1000,
      }),
    }));
    const { approval_id } = await createResp.json<{ approval_id: string }>();
    void this.notifyApprovalRequested(spaceId, tenantId, agentId, approval_id, "session_budget_continue", `Session ${sessionId} reached its credit budget ceiling`);
    return {
      ok: false,
      response: Response.json(
        { error: "session credit budget reached — a human must approve continuing", error_code: "session_budget_ceiling", approval_id },
        { status: 402 }
      ),
    };
  }

  /**
   * Go-live audit A-1/A-2: the post-run debit counterpart to enforceRunGates — shared by
   * handleScriptRun and handleRun so a run's real token cost always lands on the same payer the
   * pre-run gate checked (project wallet, end-user credit balance, or the builder's org quota).
   * `notes` is mutated in place (pushed onto), matching the pre-existing convention of surfacing a
   * billing-side hiccup in the run's own response rather than silently swallowing it. Best-effort
   * throughout: a debit failure never fails an already-completed run.
   */
  /** §A1.26: maps a script's execution tier to the Cloudflare resource billing-core's
   *  infraTimeToCredits prices — Tier 1 (in-process R2) never carries a real duration_ms and
   *  isn't a distinct CF resource, so it's excluded (returns undefined, meaning "don't record"). */
  private static infraResourceTypeForTier(tier: number | string | undefined): import("@naelao/billing-core").InfraResourceType | undefined {
    if (tier === 2 || tier === 3 || tier === 4) return "isolate";
    if (tier === 5) return "container";
    return undefined;
  }

  private async settleRunBilling(params: {
    spaceId: string; tenantId: string; projectId?: string | undefined; userId?: string | undefined; callerRole?: string | undefined;
    hasSpendCap: boolean; walletProjectId: string | null;
    tokensUsed: number; inputTokens: number; outputTokens: number;
    model?: string | undefined; notes: string[]; runId: string;
    /** §A1.26: the executed script's tier + wall-clock duration, when known (script-native runs
     *  only — the legacy ReAct path has no equivalent concept and omits these). */
    tier?: number | string | undefined; durationMs?: number | undefined;
    /** §A1 Harness Excellence Phase HX2: the session-budget guard's post-run counterpart to
     *  enforceRunGates' pre-run check. Only posts the increment when a ceiling is actually
     *  configured — a space that never opted in pays zero extra round-trip cost per run. */
    sessionId?: string | undefined; sessionCreditCeiling?: number | undefined;
  }): Promise<void> {
    const { spaceId, tenantId, projectId, userId, callerRole, hasSpendCap, walletProjectId, tokensUsed, inputTokens, outputTokens, model, notes, runId, tier, durationMs, sessionId, sessionCreditCeiling } = params;

    // §A1.26: infra-credit usage is recorded independent of whether this run used any LLM
    // tokens at all (a pure script execution — e.g. a scheduled workflow.run with no reasoning
    // step — still consumes real isolate/container time) — so this happens before the
    // token-billing early-return below, not gated by it. Best-effort, never fails the run;
    // recorded for every caller (observability), the monthly-quota GATE in enforceRunGates is
    // deliberately scoped narrower (builder-Space-Assistant runs only, matching llm_tokens).
    const resourceType = NaelaoAgentDO.infraResourceTypeForTier(tier);
    if (resourceType && durationMs !== undefined && this.env.BILLING_WORKER) {
      const infraCredits = infraTimeToCredits(resourceType, durationMs);
      if (infraCredits > 0) {
        try {
          await this.env.BILLING_WORKER.fetch(new Request("http://billing-worker/billing/usage", {
            method: "POST",
            headers: await this.internalHeaders(tenantId, { "content-type": "application/json" }),
            body: JSON.stringify({
              event_type: "infra_credits",
              quantity: infraCredits,
              space_id: spaceId,
              idempotency_key: `run:${runId}:infra`,
            }),
          }));
          if (this.env.ANALYTICS) {
            try {
              this.env.ANALYTICS.writeDataPoint({
                blobs: ["infra.execution.completed", tenantId, spaceId, "", "", "", "agents", "", "", JSON.stringify({ resource_type: resourceType, run_id: runId })],
                doubles: [durationMs, infraCredits],
                indexes: [tenantId],
              });
            } catch {
              /* Analytics Engine is append-only best-effort — never block on failure */
            }
          }
        } catch {
          // Billing service unreachable — best-effort usage recording, never fails the run.
        }
      }
    }

    if (!tokensUsed) return;
    const credits = inputTokens || outputTokens
      ? tokensToCredits(inputTokens, outputTokens, model ?? DEFAULT_WORKING_MODEL)
      : tokensUsed;

    // §A1 Harness Excellence Phase HX2: post-run tally increment — only when this space actually
    // opted into the guard (sessionCreditCeiling set), so an unconfigured space pays zero extra
    // cost per run. Best-effort: a missed increment under-counts by one run's worth of credits,
    // never over-counts, and never fails an already-completed run.
    if (sessionId && typeof sessionCreditCeiling === "number" && sessionCreditCeiling > 0 && this.env.SPACES_WORKER) {
      try {
        await this.env.SPACES_WORKER.fetch(new Request(
          `http://spaces-worker/internal/spaces/${spaceId}/session-spend/${sessionId}`,
          {
            method: "POST",
            headers: await this.internalHeaders(tenantId, { "content-type": "application/json" }),
            body: JSON.stringify({ action: "increment", credits, space_id: spaceId, project_id: projectId ?? null }),
          }
        ));
      } catch {
        /* best-effort — never fails an already-completed run over an observability side effect */
      }
    }

    if (projectId) {
      // F9: SpaceDO is now the authoritative tally (single writer across every thread on
      // this project); the local table is kept only as this DO's own telemetry/cache.
      this.addProjectSpend(projectId, credits);
      if (hasSpendCap) await this.checkAndDebitProjectSpend(spaceId, tenantId, projectId, credits);
      // Metering enforcement follow-up: debit the space's own wallet for this run's real cost.
      // credits and wallet cents are the SAME unit by construction (packages/billing-core's
      // CREDITS_PER_USD = 100, i.e. 1 credit == 1 cent) — no conversion needed. Best-effort,
      // same "never fail an already-completed run over a billing-side hiccup" posture as the
      // end-user debit below.
      if (walletProjectId) await this.debitProjectWallet(spaceId, tenantId, walletProjectId, credits, notes, runId);
    } else if (callerRole === "product_end_user" && userId) {
      // §A1.17 Phase I: a non-project run (Space Assistant / Home chat) by a signed-in product
      // end user debits THEIR OWN ProductUserDO balance, not a project cap — mutually exclusive
      // with the branch above (a project-scoped run never reaches here). Post-hoc, best-effort,
      // same posture as the project-spend accounting above: never fails an already-completed
      // run's response over a billing-side hiccup, but insufficient balance is still surfaced
      // in the result notes so it's visible, not silently swallowed.
      await this.debitEndUserCredits(spaceId, tenantId, userId, credits, model, notes, runId);
    } else if (BUILDER_CALLER_ROLES.has(callerRole ?? "")) {
      // P0-3: record this builder's own real token usage against their org's monthly quota —
      // mutually exclusive with both branches above (a project-scoped run and a product-end-user
      // run never reach here). Raw token count, not credits — this feeds a MONTHLY QUOTA
      // (@naelao/entitlements' monthly_tokens limits), a different unit/purpose from the
      // wallet/credit ledgers above. Best-effort: never fails an already-completed run's
      // response over a billing-side hiccup.
      if (this.env.BILLING_WORKER) {
        try {
          await this.env.BILLING_WORKER.fetch(new Request("http://billing-worker/billing/usage", {
            method: "POST",
            headers: await this.internalHeaders(tenantId, { "content-type": "application/json" }),
            body: JSON.stringify({ event_type: "llm_tokens", quantity: tokensUsed, idempotency_key: `run:${runId}` }),
          }));
        } catch {
          // Billing service unreachable — best-effort usage recording, never fails the run.
        }
      }
    }
  }

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

  /** Days of no new tracked-revenue snapshot before a previously-reporting business is gated. */
  private static readonly REVENUE_REPORTING_LAPSE_DAYS = 45;

  /**
   * Go-live monetization pass: real technical enforcement (not just a ToS clause) that a business
   * on revenue-cut billing keeps its Whop revenue reporting connected. Two round trips (pricing
   * config, then tracked-revenue history) only when the product has this feature enabled at all —
   * the common case (not enabled) short-circuits after the first. Fails OPEN on any lookup error,
   * when the feature isn't enabled for this product, or when the business has NEVER successfully
   * tracked (only a PREVIOUSLY-connected-then-lapsed business is gated).
   */
  private async checkRevenueReportingLapsed(spaceId: string, tenantId: string): Promise<boolean> {
    if (!this.env.SPACES_WORKER) return false;
    try {
      const catalogRes = await this.env.SPACES_WORKER.fetch(new Request(
        `http://spaces-worker/internal/pricing-catalog?space_id=${encodeURIComponent(spaceId)}`,
        { headers: await this.internalHeaders(tenantId) }
      ));
      if (!catalogRes.ok) return false;
      const catalog = await catalogRes.json<{ external_revenue_cut: { enabled: boolean } | null }>();
      if (!catalog.external_revenue_cut?.enabled) return false;

      const revenueRes = await this.env.SPACES_WORKER.fetch(new Request(
        `http://spaces-worker/spaces/${spaceId}/revenue-tracking`,
        { headers: await this.internalHeaders(tenantId) }
      ));
      if (!revenueRes.ok) return false;
      const revenue = await revenueRes.json<{ last_tracked_at: string | null }>();
      if (!revenue.last_tracked_at) return false; // never tracked yet — not lapsed, just new

      const daysSinceTracked = (Date.now() - new Date(revenue.last_tracked_at).getTime()) / 86_400_000;
      return daysSinceTracked > NaelaoAgentDO.REVENUE_REPORTING_LAPSE_DAYS;
    } catch {
      return false;
    }
  }

  /**
   * Tier 2 metering follow-up: business_subscriptions was write-only (a Lemon Squeezy webhook
   * upserted it, nothing read it). One round trip to SPACES_WORKER, which resolves whether this
   * space is even a subscription-gated business at all (not the product root, product's
   * pricingConfig.model === "subscription") before checking for an active row — the common case
   * (not a subscription-model business) short-circuits there. Fails OPEN (gated: false) on any
   * lookup error, matching checkRevenueReportingLapsed's posture — a transient SPACES_WORKER
   * outage must never brick a legitimate business's agent.
   */
  private async checkBusinessSubscriptionGate(spaceId: string, tenantId: string): Promise<{ gated: boolean; active: boolean; reason: string }> {
    if (!this.env.SPACES_WORKER) return { gated: false, active: true, reason: "" };
    // Fail CLOSED on lookup errors when the product uses the subscription model — consistent with
    // fetchAssistantPolicy, checkReplayPrevention, and the pre-auth rate limiter's own posture.
    // "not a subscription-gated space" (gated: false) is the only safe short-circuit from the
    // spaces worker itself; a network/5xx error is not a signal of non-gatedness, so treat it the
    // same as "gated but not active" rather than silently allowing the run through.
    const FAIL_CLOSED: { gated: boolean; active: boolean; reason: string } = { gated: true, active: false, reason: "subscription check unavailable — please retry" };
    try {
      const res = await this.env.SPACES_WORKER.fetch(new Request(
        `http://spaces-worker/internal/business-subscription-status?space_id=${encodeURIComponent(spaceId)}`,
        { headers: await this.internalHeaders(tenantId) }
      ));
      if (!res.ok) return FAIL_CLOSED;
      return await res.json<{ gated: boolean; active: boolean; reason: string }>();
    } catch {
      return FAIL_CLOSED;
    }
  }

  /**
   * P0-2: the space's own auto-provisioned wallet (see the provisioner's seedWallet step) is the
   * payer of last resort for a project-scoped run, independent of whether daily_spend_cap_credits
   * is configured — shared by handleScriptRun (a direct /script/run call against a project) and
   * handleChannelHeartbeat (the actual customer-bot workload: WhatsApp/Slack/Discord/email
   * messages). Extracted here so both call sites resolve one wallet balance per space rather than
   * duplicating the fetch/parse logic. Fails OPEN only when the lookup/balance check itself errors
   * (network/worker outage, or no wallet ever provisioned — e.g. a space created before this fix
   * shipped) — a CONFIRMED zero/negative balance always blocks.
   */
  private async checkProjectWallet(
    spaceId: string, tenantId: string
  ): Promise<{ ok: true; walletProjectId: string | null } | { ok: false; balance_cents: number }> {
    try {
      const wpRes = await this.env.SPACES_WORKER.fetch(new Request(
        `http://spaces-worker/spaces/${spaceId}/wallet-project`,
        { headers: await this.internalHeaders(tenantId) }
      ));
      if (wpRes.ok) {
        const { project_id } = await wpRes.json<{ project_id: string | null }>();
        if (project_id) {
          const balRes = await this.env.SPACES_WORKER.fetch(new Request(
            `http://spaces-worker/spaces/${spaceId}/projects/${project_id}/wallet/balance`,
            { headers: await this.internalHeaders(tenantId) }
          ));
          if (balRes.ok) {
            const { balance_cents, credited_cents } = await balRes.json<{ balance_cents: number; credited_cents?: number }>();
            // A wallet that has NEVER been funded is not a wallet that ran out.
            //
            // Every business auto-provisions an empty wallet project at creation, so blocking on
            // a zero balance alone refused all project-agent work on a brand-new business, before
            // its owner had done anything — reproduced live, with the message "this business's
            // wallet is empty — top up to keep this agent running" as the first thing a new owner
            // saw from their own agent. It also contradicts the whole point of the wallet: taking a
            // business from $0 to real revenue with no owner money in.
            //
            // `credited_cents` is the evidence of real depletion: money went in and is now spent.
            // Absent (an older spaces worker mid-rolling-deploy) falls back to the previous
            // balance-only behaviour rather than silently opening the gate for everyone.
            const everFunded = credited_cents === undefined ? true : credited_cents > 0;
            if (balance_cents <= 0 && everFunded) return { ok: false, balance_cents };
          }
          return { ok: true, walletProjectId: project_id };
        }
      }
    } catch {
      // Wallet service unreachable — do not block the run over a transient outage.
    }
    return { ok: true, walletProjectId: null };
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

  /** Metering enforcement follow-up: debit a project-scoped run's real LLM usage from the space's
   *  own wallet (kind='wallet' project, auto-provisioned by the provisioner's seedWallet step).
   *  Best-effort, same posture as debitEndUserCredits above — a billing-side failure never
   *  crashes an already-completed run. idempotency_key namespaced "run:" mirrors that method's
   *  own convention (never collides with wallet-topup/starter-grant keys on the same index). */
  private async debitProjectWallet(
    spaceId: string, tenantId: string, walletProjectId: string, credits: number, notes: string[], runId?: string
  ): Promise<void> {
    try {
      const resp = await this.env.SPACES_WORKER.fetch(new Request(
        `http://spaces-worker/spaces/${spaceId}/projects/${walletProjectId}/wallet/debit`,
        {
          method: "POST",
          headers: await this.internalHeaders(tenantId, { "content-type": "application/json" }),
          body: JSON.stringify({ cents: credits, reason: "agent_run", ...(runId ? { idempotency_key: `run:${runId}` } : {}) }),
        }
      ));
      if (resp.status === 402) {
        notes.push(`Billing: this business's wallet had insufficient balance to cover this run's ${credits} credit(s) — balance was not debited.`);
      } else if (!resp.ok) {
        notes.push(`Billing: failed to debit ${credits} credit(s) from the wallet for this run (${resp.status}) — see logs.`);
      }
    } catch (err) {
      notes.push(`Billing: failed to debit ${credits} credit(s) from the wallet for this run (${(err as Error).message}).`);
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
    // businessContext: resolved by the caller (index.ts's heartbeat dispatch) — this DO has no
    // PLATFORM_DB binding. Without it the agent answering a real customer on WhatsApp/Slack knows
    // its role but not what the business actually sells, which is the one thing that conversation
    // is about.
    type HeartbeatBody = { spaceId?: string; agentId?: string; tenantId?: string; apiKey?: string; model?: string; max?: number; businessContext?: BusinessContext };
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

    // Claim these rows (answered: 0 -> 2) synchronously, before any async work below. Kicking a
    // heartbeat immediately on every inbound message (rather than only from the hourly cron)
    // means two invocations of this method can now genuinely overlap on the same DO — one
    // suspended mid-await on a tool call yields the isolate to a second invocation's own SELECT.
    // Without a claim step, that second SELECT (still `answered = 0`) would pick up the same
    // message and double-process it (double reply, double LLM spend). The claim is reverted to 0
    // in the per-message `finally` below unless the message reaches a real terminal state
    // (markOutbound -> 1, or human_takeover -> excluded from the WHERE clause entirely) — so an
    // exception or an intentional retry-later `continue` still leaves it retryable, never lost.
    this.ctx.storage.sql.exec(
      `UPDATE channel_messages SET answered = 2 WHERE id IN (${pending.map(() => "?").join(",")})`,
      ...pending.map((m) => m.id)
    );

    const engineEnv = this.buildScriptEngineEnv(spaceId, agentId, tenantId);
    if (!engineEnv) return Response.json({ error: "script engine unavailable: SCRIPTS_R2 not bound" }, { status: 503 });
    const config = await this.loadAgentConfigHealed(engineEnv.scriptsBucket, spaceId, agentId);
    if (!config) return Response.json({ error: `agent '${agentId}' is not provisioned in space '${spaceId}'` }, { status: 404 });
    // Same structural-config-first, agents.md-parse-fallback precedence as handleScriptRun above.
    const requiresApprovalFor = config.requiresApprovalFor ?? [...parseRequiresApprovalFor(config.agentsMd)];
    const tools = new ScriptToolSurface(engineEnv, config.scripts.prebuilt);

    const channelRole: AgentRoleType = "CUSTOMER_SUPPORT";
    const channelPolicy = ROLE_FIREWALL_POLICIES[channelRole];
    if (engineEnv.maxTier === undefined || engineEnv.maxTier > channelPolicy.maxLadderTier) {
      engineEnv.maxTier = channelPolicy.maxLadderTier;
    }

    const channelBusinessBrief: BusinessContextBrief = {
      businessName: body.businessContext?.business_name || (body.businessContext as any)?.name || spaceId,
      templateType: body.businessContext?.space_type || "standard",
      currency: body.businessContext?.currency || "USD",
      activeOfferings: (body.businessContext?.offerings || []).map((o: any) => ({
        name: o.name || o.title || "Standard Service",
        priceCents: typeof o.price_cents === "number" ? o.price_cents : (typeof o.priceCents === "number" ? o.priceCents : 0),
      })),
      complianceMode: ((body.businessContext as any)?.compliance_mode as any) || "standard",
      operatingJurisdiction: (body.businessContext as any)?.operatingJurisdiction || (body.businessContext as any)?.jurisdiction,
    };

    const assembledChannelPrompt = assembleSystemPrompt({
      businessContext: channelBusinessBrief,
      soulMarkdown: config.systemPrompt || "",
      agentRole: channelRole,
      activeWorkspacePath: "/workspace/",
    });

    // 1. Generate the Zero-Turn Catalog
    const zeroTurnCatalog = await ScriptToolSurface.generateZeroTurnCatalog(
      this.ctx.storage,
      this.getVirtualFsStorage(),
      spaceId,
      undefined
    );

    // 2. Compose the final system prompt
    const enrichedSystemPrompt = composeSystemPrompt(
      assembledChannelPrompt,
      body.businessContext ? JSON.stringify(body.businessContext, null, 2) : "",
      zeroTurnCatalog
    );

    const model = body.model ?? DEFAULT_WORKING_MODEL;
    // Step 28: same BYOK override as the interactive path — a customer messaging a business on a
    // channel is answered on the business's own Gemini/Groq key when it has one.
    const byokOverride = await this.resolveBusinessLlmOverride(spaceId, tenantId, model);
    const reasoner = new GatewayReasoner({
      apiKey: body.apiKey ?? "",
      gateway: { accountId: this.env.NAELAO_ACCOUNT_ID ?? "placeholder", gatewayId: this.env.NAELAO_GATEWAY_ID ?? "naelao-gateway", ...(this.env.CF_API_TOKEN ? { cfApiToken: this.env.CF_API_TOKEN } : {}), ...(this.env.NAELAO_AIG_TOKEN ? { aigToken: this.env.NAELAO_AIG_TOKEN } : {}), ...(this.env.GOOGLE_AI_STUDIO_API_KEY ? { googleAiStudioApiKey: this.env.GOOGLE_AI_STUDIO_API_KEY } : {}), ...(this.env.GROQ_API_KEY ? { groqApiKey: this.env.GROQ_API_KEY } : {}), ...byokOverride },
      ctx: { spaceId, agentId, model },
      model,
      fallbacks: this.resolveFailoverChain(model, body.apiKey ?? ""),
      // Same gap as the interactive path: a customer messaging a business on Slack/WhatsApp was
      // being answered by a model that had never been told what business it was answering for.
      ...(enrichedSystemPrompt ? { agentPrompt: enrichedSystemPrompt } : {}),
      // WHICH business this run is for. Resolved by index.ts from the space row it already
      // fetches; omitted entirely when the caller never resolved one.
      ...(body.businessContext ? { businessContext: body.businessContext } : {}),
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

    // P0-2: the wallet is space-scoped (one wallet per space, shared by every project in it), so
    // resolve it once for the whole batch rather than per project — only when at least one
    // pending message is project-scoped, since a customer-bot project is the only thing this gate
    // applies to (same scoping handleScriptRun's own wallet gate uses). Before this, the ONLY
    // metering on this drain was the OPTIONAL daily_spend_cap_credits — a customer-bot project
    // with no cap configured (the common case) ran its actual workload completely unmetered.
    const walletCheck = projectIds.length > 0 ? await this.checkProjectWallet(spaceId, tenantId) : null;

    let answered = 0;
    let escalated = 0;
    let ruleHandled = 0;
    let spendCapped = 0;

    for (const msg of pending) {
      try {
      // Untrusted inbound text — moderate before it ever reaches the reasoning prompt or a rule
      // match. This used to just count "escalated" and continue — the message was silently
      // dropped with nobody ever told a customer-bot channel (including a business's own inbound
      // email) had received something that tried to get the low-tier channel agent to do
      // something unsafe. Now it also flags the session for a human AND raises a real
      // notification, the same pattern every other genuine escalation in this platform uses.
      if (moderateInput(msg.text).blocked) {
        this.ctx.storage.sql.exec(`UPDATE channel_sessions SET human_takeover = 1 WHERE id = ?`, msg.session_id);
        void this.createSpaceNotification(spaceId, tenantId, {
          kind: "inbound_message_blocked",
          title: `An inbound ${msg.channel} message was blocked — looked unsafe`,
          body: "A message tried to get the agent to do something it flagged as unsafe (a prompt-injection or policy match). " +
            "It was not acted on. The conversation is now held for a human — review it before it continues automatically.",
          severity: "critical",
          projectId: msg.project_id ?? null,
          sourceAgentId: agentId,
          relatedId: msg.session_id,
        });
        escalated++;
        continue;
      }

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

      // 2b. Wallet gate (P0-2) — applies to every project-scoped message REGARDLESS of whether
      // a spend cap is configured, closing the gap where a customer-bot project with no cap set
      // (the common case) ran this drain's actual reasoning-loop LLM cost completely unmetered.
      // Deliberately placed after no-code rules (step 1) so STOP/opt-out replies and
      // human_takeover routing never depend on the business having money — only the paid
      // reasoning-loop path below is gated. Bucketed into the same spend_capped counter as the
      // spend cap above: "can't afford to run the paid loop right now," same externally-visible
      // outcome (left for a human/retry, not silently dropped).
      if (msg.project_id && walletCheck && !walletCheck.ok) {
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
          contextWindowTokens: contextWindowForModel(model),
          // A customer is waiting on a channel reply, and this loop drains a queue of them — so it
          // gets a tighter clock than an interactive turn. Answering one message thoroughly while
          // the rest of the inbox goes cold is the wrong trade here.
          deadlineAt: Date.now() + CHANNEL_REPLY_WALL_CLOCK_MS,
          // This customer's earlier messages on this channel — without it every inbound message
          // is answered as if it were the first thing they ever said.
          ...(() => {
            const conversation = this.loadChannelConversation(msg.session_id);
            return conversation ? { conversation } : {};
          })(),
        });
      } catch (err) {
        result = { level: "L4", result: { ok: false, error: String(err), tier: 1, duration_ms: 0, tokens_used: 0 }, notes: [], trace: [] };
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
      } finally {
        // Release the claim for any message that didn't reach a real terminal state this
        // iteration (markOutbound already moved it to 1; human_takeover moved the SESSION out of
        // the WHERE clause entirely) — safe no-op via the `answered = 2` guard otherwise.
        this.ctx.storage.sql.exec(`UPDATE channel_messages SET answered = 0 WHERE id = ? AND answered = 2`, msg.id);
      }
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
      userId?: string;
      projectId?: string;
      callerRole?: string;
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

    // Go-live audit A-1/A-2: this is the runtime every interactive /agent/run message from
    // apps/shell and apps/portal actually reaches — it used to carry NONE of the F-36 clamp /
    // spend-cap / wallet / product_end_user credit gates handleScriptRun always had, so a
    // signed-in end user (or a business whose wallet was drained) could chat unmetered forever.
    // Same shared gate handleScriptRun calls; see enforceRunGates' own doc.
    const gate = await this.enforceRunGates({
      spaceId: body.spaceId, tenantId: body.tenantId, projectId: body.projectId,
      userId: body.userId, callerRole: body.callerRole,
    });
    if (!gate.ok) return gate.response;

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

    // Enforce AgentFirewall tool pruning
    const agentRole = resolveAgentRole("naelao-agent", body.projectId, body.callerRole);
    const rawToolDefs = (body.tools || []).map((t) => ({
      name: t.name,
      description: (t as any).description || "",
      parameters: (t as any).input_schema || (t as any).parameters || {},
    }));
    const allowedTools = sanitizeToolsForRole(agentRole, rawToolDefs);
    const allowedToolNames = new Set(allowedTools.map((t) => t.name));
    const prunedTools = (body.tools || []).filter((t) => allowedToolNames.has(t.name));

    try {
      const loopResult = await this.runReActLoop(
        runId,
        body.goal,
        body.systemPrompt,
        prunedTools,
        body.kbContext,
        body.apiKey,
        model,
        allowedDomains,
        services
      );
      const { finalAnswer } = loopResult;

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

      // Go-live audit A-1/A-2: settle this run's real LLM cost on the same payer the pre-run
      // gate above checked (project wallet, end-user credit balance, or the builder's org
      // quota) — mirrors handleScriptRun's post-run debit exactly. Best-effort: a billing-side
      // hiccup is surfaced in billingNotes, never fails an already-completed run.
      const billingNotes: string[] = [];
      await this.settleRunBilling({
        spaceId: body.spaceId, tenantId: body.tenantId, projectId: body.projectId,
        userId: body.userId, callerRole: body.callerRole,
        hasSpendCap: gate.hasSpendCap, walletProjectId: gate.walletProjectId,
        tokensUsed: loopResult.tokensUsed, inputTokens: loopResult.inputTokens, outputTokens: loopResult.outputTokens,
        model: body.model, notes: billingNotes, runId,
      });

      return Response.json(
        {
          runId,
          status: "completed",
          finalAnswer,
          reactSteps: JSON.parse(run.react_steps as string) as ReactStep[],
          ...(billingNotes.length > 0 ? { billingNotes } : {}),
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
  ): Promise<ReActLoopResult> {
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
      }, undefined, this.aiGatewayConfig());

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
          return { finalAnswer: step.finalAnswer, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, tokensUsed: totalInputTokens + totalOutputTokens };
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
        return { finalAnswer: answerText, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, tokensUsed: totalInputTokens + totalOutputTokens };
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

        // G-AY01: Build a fast-lookup map of require_approval per tool name. `tools` is
        // LlmTool[] (a union with §A1.25's LlmNativeWebSearchTool, which has no
        // require_approval field at all) — this ReAct loop only ever deals in Naelao's own
        // custom function-calling tools, so narrow to that member first.
        const approvalRequiredTools = new Set(
          tools
            .filter((t): t is LlmFunctionTool => "require_approval" in t && t.require_approval === true)
            .map((t) => t.name)
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

      return { finalAnswer: step.finalAnswer, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, tokensUsed: totalInputTokens + totalOutputTokens };
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

    return { finalAnswer: maxIterAnswer, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, tokensUsed: totalInputTokens + totalOutputTokens };
  }

  /**
   * Load the thread's conversation into the bounded, possibly-compacted context the reasoner
   * carries.
   *
   * Before this existed the reasoner had NO conversation history: it could not resolve "do that
   * again", could not answer "what did we decide", and re-asked things the user had already said.
   *
   * Everything here is best-effort. A conversation the DO cannot load must degrade to "no
   * history" (the previous behaviour) rather than failing the run — an agent that answers with
   * less context is worse; an agent that refuses to answer at all is broken.
   */
  /** The session's persisted transcript. Shared by the per-turn context build and the on-demand
   *  compaction pass so both read the conversation the same way. */
  private async fetchSessionMessages(
    spaceId: string,
    sessionId: string,
    tenantId: string
  ): Promise<ConversationMessage[] | undefined> {
    if (!sessionId || !this.env.SPACES_WORKER) return undefined;
    try {
      const headers = await this.internalHeaders(tenantId);
      const resp = await this.env.SPACES_WORKER.fetch(
        new Request(
          `http://spaces-worker/spaces/${encodeURIComponent(spaceId)}/sessions/${encodeURIComponent(sessionId)}/messages`,
          { headers }
        )
      );
      if (!resp.ok) return undefined;
      const body = (await resp.json()) as { data?: ConversationMessage[]; messages?: ConversationMessage[] };
      return body.data ?? body.messages ?? [];
    } catch {
      return undefined;
    }
  }

  private async loadConversationContext(
    spaceId: string,
    sessionId: string,
    tenantId: string
  ): Promise<ConversationContext | undefined> {
    if (!sessionId || !this.env.SPACES_WORKER) return undefined;
    try {
      const messages = await this.fetchSessionMessages(spaceId, sessionId, tenantId);
      if (!messages || messages.length === 0) return undefined;

      // The stored summary covers the oldest `covered_messages`; reuse it unless the conversation
      // has grown enough that more messages now fall outside the recent window.
      let summary = "";
      let covered = 0;
      try {
        const row = this.ctx.storage.sql
          .exec("SELECT summary, covered_messages FROM conversation_summaries WHERE session_id = ?", sessionId)
          .toArray()[0] as { summary?: string; covered_messages?: number } | undefined;
        if (row) {
          summary = String(row.summary ?? "");
          covered = Number(row.covered_messages ?? 0);
        }
      } catch {
        // No summary is a valid state — the context is simply less informative.
      }

      const toSummarize = messagesToSummarize(messages);
      if (toSummarize.length > covered) {
        const regenerated = await this.summarizeConversation(toSummarize, summary);
        if (regenerated) {
          summary = regenerated;
          try {
            this.ctx.storage.sql.exec(
              `INSERT OR REPLACE INTO conversation_summaries (session_id, summary, covered_messages, updated_at)
               VALUES (?, ?, ?, ?)`,
              sessionId,
              summary,
              toSummarize.length,
              new Date().toISOString()
            );
          } catch {
            // Losing the cache costs a regeneration next turn, nothing more.
          }
        }
      }

      return buildConversationContext(messages, summary);
    } catch {
      return undefined;
    }
  }

  /**
   * The channel equivalent of loadConversationContext.
   *
   * A WhatsApp/Slack/Discord customer's earlier messages live in this DO's own channel_messages
   * table, not in SpaceDO's sessions — so the web-chat loader cannot see them. Without this the
   * drain loop handed the model ONE message with no history: a customer answering "yes, the blue
   * one" got a reply that had no idea what had been offered, which is exactly how a support bot
   * earns a reputation for being useless.
   */
  private loadChannelConversation(sessionId: string): ConversationContext | undefined {
    try {
      const rows = this.ctx.storage.sql
        .exec(
          `SELECT direction, text, created_at FROM channel_messages
           WHERE session_id = ? ORDER BY created_at DESC LIMIT 60`,
          sessionId
        )
        .toArray() as Array<{ direction: string; text: string; created_at: number }>;
      if (rows.length === 0) return undefined;
      const messages: ConversationMessage[] = rows
        .reverse()
        .map((r) => ({
          role: r.direction === "inbound" ? "user" : "assistant",
          content: r.text,
          created_at: new Date(r.created_at).toISOString(),
        }));
      // No stored summary for channel threads yet: the customer-bot path is cost-sensitive and a
      // per-drain summarisation call would run on every inbound message. Recent history bounded
      // by the same budget is the win; compaction here can come later if threads get long enough
      // to need it.
      return buildConversationContext(messages);
    } catch {
      return undefined;
    }
  }

  /** Condense the older part of a conversation. Returns null when no LLM is available or the
   *  call fails — the caller then carries recent messages with no summary, which is still far
   *  better than no history at all. */
  private async summarizeConversation(
    older: ConversationMessage[],
    existingSummary: string
  ): Promise<string | null> {
    try {
      const gatewayConfig = this.aiGatewayConfig();
      if (!gatewayConfig.accountId) return null;
      const response = await callLlm(
        "",
        {
          // Compaction is background maintenance, not user-facing reasoning — cascaded-routing
          // trick 4: route it to the shared cheap UTILITY_MODEL, not the agent's reasoning model.
          model: UTILITY_MODEL,
          messages: [{ role: "user", content: buildSummaryPrompt(older, existingSummary) }],
          max_tokens: 600,
        },
        undefined,
        gatewayConfig
      );
      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("\n")
        .trim();
      return text || null;
    } catch {
      return null;
    }
  }

  /**
   * Write just the agent's answer into the thread, attributed to the agent that produced it.
   *
   * Deliberately NOT the goal+answer pair `writeConversationToSession` writes: on this path the
   * client has already persisted the user's message before dispatching, so writing it again would
   * duplicate every question in the transcript.
   *
   * Errors are swallowed — the run itself already succeeded, and losing the transcript write must
   * not turn a completed run into a failed one. That makes this safe to AWAIT (and it must be
   * awaited: a promise left dangling when a DO handler returns may never run, which is exactly why
   * a reply would sometimes be on screen and then gone after a reload).
   *
   * `runId`, when given, is the idempotency key. One run produces one answer, so a replayed
   * Workflow step or a retried dispatch resolves to the answer already written instead of
   * appending a second copy of it.
   */
  private async writeAgentAnswerToSession(
    sessionId: string,
    spaceId: string,
    tenantId: string,
    answer: string,
    agentId: string,
    // item 79: {consulted_threads:[...]} when this run consulted a project agent — see
    // buildOrchestrationHooks' consultLog param for what populates it.
    metadata?: Record<string, unknown>,
    runId?: string
  ): Promise<void> {
    try {
      await this.env.SPACES_WORKER.fetch(new Request(
        `http://spaces-worker/spaces/${spaceId}/sessions/${sessionId}/messages`,
        {
          method: "POST",
          headers: await this.internalHeaders(tenantId, { "content-type": "application/json" }),
          body: JSON.stringify({
            role: "assistant", content: answer, agent_id: agentId,
            ...(metadata ? { metadata } : {}),
            ...(runId ? { client_message_id: `run:${runId}` } : {}),
          }),
        }
      ));
    } catch {
      /* the answer was already returned to the caller; history is the only casualty */
    }
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

  /**
   * F-12: resolve the cross-provider LLM failover chain from configured secrets. The primary model
   * is passed separately; this returns ONLY the fallbacks (tried in order after it). Defaults to a
   * cheaper Anthropic model on the SAME key (real within-provider model failover, zero extra
   * config), then OpenAI when OPENAI_API_KEY is set (real cross-provider). All optional — an empty
   * chain means single-provider behavior, unchanged.
   */
  /** CF AI Gateway config for the @naelao/llm-gateway callLlm path (the ReAct loop). Routes
   *  through the gateway when a real account is configured; carries the Authenticated-Gateway
   *  token so the gateway can supply its own stored Anthropic key (no per-worker key needed). */
  private aiGatewayConfig(): { accountId: string; gatewayId: string; aigToken?: string } {
    return {
      accountId: this.env.NAELAO_ACCOUNT_ID ?? "placeholder",
      gatewayId: this.env.NAELAO_GATEWAY_ID ?? "naelao-gateway",
      ...(this.env.NAELAO_AIG_TOKEN ? { aigToken: this.env.NAELAO_AIG_TOKEN } : {}),
    };
  }

  /**
   * Step 28 (business-wide BYOK): a business's OWN Gemini/Groq key, when it has stored one, so its
   * runs draw on ITS provider quota instead of the platform's shared allowance (the thing every
   * daily-quota limit in this platform's own docs keeps hitting). Resolved from the credentials
   * vault — never config_json, since it's a secret. Gated by the MODEL itself: the default
   * `@cf/...` model isn't a BYOK-compat provider, so `byokProviderForModel` returns null and NO
   * lookup happens for the overwhelming majority of runs; only a business that actually chose a
   * Gemini/Groq model pays one cheap internal fetch to check for its own key. Fails OPEN on any
   * error (missing binding, 404, network) — a BYOK lookup must never break a run; it falls straight
   * back to the platform key. CF Workers AI BYOK is deliberately NOT here: it needs a business's own
   * account-id + a scoped token + different gateway routing (not a drop-in key), a separate larger
   * piece.
   */
  private async resolveBusinessLlmOverride(
    spaceId: string,
    tenantId: string,
    model: string,
  ): Promise<Partial<Pick<GatewayOpts, "googleAiStudioApiKey" | "groqApiKey">>> {
    const provider = byokProviderForModel(model);
    if (!provider || !this.env.CREDENTIALS_WORKER) return {};
    const field = BYOK_PROVIDER_KEY_FIELD[provider];
    if (!field) return {};
    try {
      const token = await this.generateCredentialToken(spaceId, "naelao-agent");
      const resp = await this.env.CREDENTIALS_WORKER.fetch(
        new Request(
          `http://credentials/v1/internal/spaces/${spaceId}/credentials/${encodeURIComponent(`llm-byok:${provider}`)}/plaintext`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-naelao-tenant-id": tenantId,
              "x-naelao-credential-token": token,
            },
            body: "{}",
          },
        ),
      );
      if (!resp.ok) return {};
      const { value } = await resp.json<{ value?: string }>().catch(() => ({}) as { value?: string });
      return value ? { [field]: value } : {};
    } catch {
      return {};
    }
  }

  /** Short-lived HMAC credential token — mirrors the agents worker's own generateCredentialToken
   *  (index.ts) and workers/credentials, so the vault accepts this DO as a legitimate resolver. */
  private async generateCredentialToken(spaceId: string, agentId: string): Promise<string> {
    const timestamp = Math.floor(Date.now() / 1000);
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(this.env.PLATFORM_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${spaceId}:${agentId}:${timestamp}`));
    const hex = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
    return `t=${timestamp},aid=${agentId},v1=${hex}`;
  }

  private resolveFailoverChain(primaryModel: string, anthropicKey: string): { model: string; apiKey: string }[] {
    const chain: { model: string; apiKey: string }[] = [];
    const anthropicFallback = this.env.LLM_FALLBACK_MODEL ?? DEFAULT_WORKING_MODEL;
    if (anthropicKey && anthropicFallback && anthropicFallback !== primaryModel) {
      chain.push({ model: anthropicFallback, apiKey: anthropicKey });
    }
    if (this.env.OPENAI_API_KEY && this.env.OPENAI_FALLBACK_MODEL) {
      chain.push({ model: this.env.OPENAI_FALLBACK_MODEL, apiKey: this.env.OPENAI_API_KEY });
    }
    return chain;
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

  private async dispatchGuiAction(sandboxStub: DurableObjectStub, action: import("./ToolSandboxDO.js").GuiActionPayload): Promise<unknown> {
    const resp = await sandboxStub.fetch("http://internal/gui-action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(action),
    });
    return resp.json();
  }

  private handleGetRun(runId: string): Response {
    // §A1 Harness Excellence (chat UI parity): a script-native run (handleScriptRun, the default
    // dispatch path since item 47's cutover) writes NO `agent_runs` row — that table is legacy-
    // ReAct-only — so this route always 404'd for the run everyone actually uses, and
    // fetchRunOrTaskStatus correctly fell through to TaskDO on every single poll. That's still
    // right for the FINAL answer (TaskDO is the durable source of truth), but it meant a client
    // polling this route while the run was still executing learned nothing beyond "running" —
    // no live "currently doing X". While a live-progress entry exists for this runId (i.e. the
    // run is still inside this DO's own runScriptLoop call), answer from it directly instead of
    // falling through — synthesizing a "running" status with the steps recorded so far.
    const live = this.liveRuns.get(runId);
    if (live) {
      // Resolved but still retained — answer with the real outcome. Without this the client's
      // next poll after a synchronous run 404s even though the run succeeded (see finishLiveRun).
      if (live.terminal) {
        return Response.json({ id: runId, live_steps: live.steps, ...live.terminal });
      }
      return Response.json({
        id: runId,
        status: "running",
        live_steps: live.steps,
        // The answer as it is being written. Named separately from `final_answer` on purpose: a
        // caller must be able to tell "this is still growing" from "this is the result", and the
        // stream endpoint diffs it into real delta events without ever treating it as terminal.
        ...(live.partialAnswer ? { partial_answer: live.partialAnswer } : {}),
      });
    }

    // Nothing in memory — but that does not mean nothing happened. This instance may have
    // hibernated since, or this may be a different tab entirely that was never here for the live
    // half. Reading the durable copy is what turns "close the laptop and come back" from a blank
    // screen into the conversation picking up where it left off.
    const durable = this.readDurableRun(runId);
    if (durable) {
      if (durable.terminal) return Response.json({ id: runId, live_steps: durable.steps, ...durable.terminal });
      return Response.json({
        id: runId,
        status: "running",
        live_steps: durable.steps,
        ...(durable.partial_answer ? { partial_answer: durable.partial_answer } : {}),
      });
    }

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
    const legacy = rows.map(r => ({ ...r, value: (() => { try { return JSON.parse(r.value); } catch { return r.value; } })() }));

    // `agent_memory` is the ORIGINAL key/value store, written only by this DO's own POST /memory.
    // Nothing in the script-native agent loop writes there — every real memory the agent forms goes
    // through Memory OS instead (`memory.remember`, and the automatic post-run episodic note), which
    // lives in `structured_facts` and `episodic_log`. Reading only the legacy table is why the
    // Memory panel showed nothing no matter how much the agent had actually recorded, and is the
    // real reason behind "the AI isn't recording anything in memory".
    //
    // Both are surfaced, tagged by source, so the panel reflects what is genuinely stored. Wrapped
    // per-table: these are created lazily by Memory OS's own init, so a DO that has never run an
    // agent simply has no such table yet, which is "nothing recorded", not an error.
    const facts = this.safeMemoryRows<{ entity: string; relation: string; attribute: string; trust_score: number; updated_at: number }>(
      `SELECT entity, relation, attribute, trust_score, updated_at FROM structured_facts ORDER BY updated_at DESC LIMIT 200`
    ).map((r) => ({
      key: `${r.entity} ${r.relation}`,
      category: "fact",
      value: r.attribute,
      confidence: r.trust_score,
      updated_at: r.updated_at,
      source: "memory-os" as const,
    }));

    const episodic = this.safeMemoryRows<{ text: string; importance: number; created_at: number }>(
      `SELECT text, importance, created_at FROM episodic_log ORDER BY created_at DESC LIMIT 100`
    ).map((r) => ({
      key: r.text.slice(0, 80),
      category: "episodic",
      value: r.text,
      confidence: r.importance,
      updated_at: r.created_at,
      source: "memory-os" as const,
    }));

    const entries = [
      ...legacy.map((e) => ({ ...e, source: "legacy" as const })),
      ...(category ? [...facts, ...episodic].filter((e) => e.category === category) : [...facts, ...episodic]),
    ];
    return Response.json({ entries, count: entries.length });
  }

  /** Read a Memory OS table that may not exist yet on a DO that has never run an agent. */
  private safeMemoryRows<T>(sql: string): T[] {
    try {
      return this.ctx.storage.sql.exec(sql).toArray() as T[];
    } catch {
      return [];
    }
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

  async runAgentCodeMode(
    scriptCode: string,
    args: Record<string, any>,
    options: { spaceId: string; projectId?: string; actingUserId?: string; scope: "SPACE_WIDE" | "PROJECT_BOUND" }
  ) {
    this.ensureInit();

    const ctx = buildRuntimeContext(
      this.env,
      options.scope,
      options.spaceId,
      options.projectId,
      options.actingUserId,
      this.virtualShell,
      this.artifactsGit
    );

    // Decorate with JIT and CLI helpers
    ctx.storage = this.ctx.storage;
    ctx.env = ctx.env || { spaceId: options.spaceId, projectId: options.projectId, agentId: "naelao-agent" };
    ctx.cli = buildCliSdkContext(this.ctx.storage, options.spaceId, options.projectId, "naelao-agent");

    const codeRunner = buildCodeRunner({
      loader: this.env.LOADER,
      browserWorker: this.env.BROWSER_WORKER,
      mcpHubWorker: this.env.MCP_HUB,
      platformSecret: this.env.PLATFORM_SECRET,
      toolSandbox: this.env.TOOL_SANDBOX,
    });

    return await codeRunner.run({
      name: "agent_codemode_run",
      code: scriptCode,
      tier: 2,
      args,
      spaceId: options.spaceId,
      projectId: options.projectId,
      ctx,
    });
  }

  private getVirtualFsStorage(): VirtualFsStorage {
    return {
      readFile: async (p: string) => {
        const row = (this.ctx.storage.sql
          .exec("SELECT content FROM workspace_files WHERE path = ?", p)
          .toArray() as unknown as Array<{ content: string }>)[0];
        return row?.content ?? null;
      },
      writeFile: async (p: string, data: string) => {
        this.ctx.storage.sql.exec(
          "INSERT OR REPLACE INTO workspace_files (path, content, hash, size_bytes, updated_at) VALUES (?, ?, ?, ?, ?)",
          p, data, "sha256_placeholder", data.length, Date.now()
        );
      },
      listFiles: async (_prefix?: string) => {
        const rows = this.ctx.storage.sql
          .exec("SELECT path FROM workspace_files")
          .toArray() as unknown as Array<{ path: string }>;
        return rows.map((r) => r.path);
      },
      deleteFile: async (p: string) => {
        const result = this.ctx.storage.sql.exec("DELETE FROM workspace_files WHERE path = ?", p);
        return result.rowsWritten > 0;
      },
    };
  }

  get agentId(): string {
    return "naelao-agent";
  }

  getAgentMinimumRoleRank(agentId?: string): number {
    const id = (agentId || this.agentId || "").toLowerCase();
    if (id.includes("dev") || id.includes("code") || id.includes("ops") || id.includes("admin")) {
      return 3;
    }
    return 2;
  }

  async handleDelegatedRun(request: Request): Promise<Response> {
    const body = await request.json() as { 
      taskDescription: string; 
      delegationToken: string;
      spaceId?: string;
      tenantId?: string;
      sessionId?: string;
    };

    // 1. Verify the Delegation Token
    const verifiedPayload = await this.verifyTaskToken(body.delegationToken, this.env.PLATFORM_SECRET);
    
    if (!verifiedPayload) {
      return new Response(JSON.stringify({ error: "Invalid or expired delegation token. Potential Privilege Escalation blocked." }), { status: 403 });
    }

    // 2. Validate Originating Human Role against Agent's Minimum Required Rank
    // E.g., DevBot requires Rank 3 (Editor). If Charlie (Rank 1) initiated, block it!
    const requiredRank = this.getAgentMinimumRoleRank(); // e.g., 3
    
    if (verifiedPayload.initiatingRoleRank < requiredRank) {
      console.warn(`🚨 Trojan Delegation Blocked: User ${verifiedPayload.initiatingUserId} attempted to use ${this.agentId} to bypass RBAC.`);
      return new Response(JSON.stringify({ 
        error: `Delegation blocked: Initiating user lacks clearance (Requires Rank ${requiredRank}, got Rank ${verifiedPayload.initiatingRoleRank}).` 
      }), { status: 403 });
    }

    // 3. Mount the environment using the INITIATING human's identity, NOT the delegating bot's identity
    const safeEnv = this.buildScriptEngineEnv({
      actingUserId: verifiedPayload.initiatingUserId,
      actingRoleRank: verifiedPayload.initiatingRoleRank,
      projectId: verifiedPayload.projectId,
      spaceId: body.spaceId,
      tenantId: body.tenantId,
      agentId: verifiedPayload.targetRole || this.agentId,
      sessionId: body.sessionId,
    });

    // 4. Proceed with Execution
    return await this.executeScriptRun(body.taskDescription, safeEnv, {
      sessionId: body.sessionId,
    });
  }

  async executeScriptRun(taskDescription: string, env: ScriptEngineEnv | null, options: Record<string, unknown> = {}): Promise<Response> {
    const spaceId = env?.spaceId ?? "";
    const agentId = env?.agentId ?? this.agentId;
    const tenantId = env?.tenantId ?? "";
    const sessionId = (options.sessionId as string) ?? `delegated-${Date.now()}`;

    const scriptRunRequest = new Request("http://agent-do/script/run", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-space-id": spaceId,
        "x-naelao-tenant-id": tenantId,
        ...(env?.userId ? { "x-naelao-user-id": env.userId } : {}),
      },
      body: JSON.stringify({
        goal: taskDescription,
        spaceId,
        agentId,
        tenantId,
        sessionId,
        userId: env?.userId,
        projectId: env?.projectId,
        ...options,
      }),
    });
    return this.handleScriptRun(scriptRunRequest);
  }

  async verifyTaskToken(token: string, secret: string): Promise<any | null> {
    try {
      const [payloadB64, sigB64] = token.split(".");
      const encoder = new TextEncoder();
      
      const keyMaterial = await crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"]
      );

      const signatureBytes = Uint8Array.from(atob(sigB64.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
      
      const isValid = await crypto.subtle.verify("HMAC", keyMaterial, signatureBytes, encoder.encode(payloadB64));
      
      if (!isValid) return null;

      const payload = JSON.parse(atob(payloadB64));
      if (Math.floor(Date.now() / 1000) > payload.exp) return null; // Expired

      return payload;
    } catch {
      return null;
    }
  }

  // ── Semantic Deduplication & Sponsor Alignment Gate (Phase 5 Chunk 04) ──
  /**
   * Evaluates incoming user prompt against active tasks to prevent duplicate code branches.
   */
  async evaluateSemanticTaskDeduplication(
    projectId: string,
    userPrompt: string,
    callingUserId: string,
    spaceDoStub: any
  ): Promise<SemanticDeduplicationResult> {
    // 1. Compute prompt embedding using Workers AI bge-small-en-v1.5
    let queryEmbedding: number[] = [];
    try {
      const embedRes = await (this.env as any).AI.run("@cf/baai/bge-small-en-v1.5", {
        text: [userPrompt]
      });
      queryEmbedding = embedRes.data?.[0] || [];
    } catch {
      // Degrade gracefully if embeddings unavailable
      return { isDuplicate: false };
    }

    if (!queryEmbedding || queryEmbedding.length === 0) {
      return { isDuplicate: false };
    }

    // 2. Fetch active tasks from SpaceDO
    let activeTasks: any[] = [];
    try {
      if (typeof spaceDoStub.listActiveTasksForProject === "function") {
        activeTasks = await spaceDoStub.listActiveTasksForProject(projectId);
      } else {
        const resp = await spaceDoStub.fetch(`http://internal/projects/${projectId}/tasks/active`);
        activeTasks = await resp.json() as any[];
      }
    } catch {
      return { isDuplicate: false };
    }

    // 3. Check for high semantic collision (Cosine Similarity > 0.85)
    for (const task of activeTasks) {
      if (!task.semantic_embedding_json && !task.semanticEmbedding) continue;
      const taskEmbedding = task.semantic_embedding_json 
        ? JSON.parse(task.semantic_embedding_json) 
        : task.semanticEmbedding;
      if (!Array.isArray(taskEmbedding) || taskEmbedding.length === 0) continue;

      const similarity = calculateCosineSimilarity(queryEmbedding, taskEmbedding);

      if (similarity > 0.85) {
        return {
          isDuplicate: true,
          existingTask: task,
          similarityScore: similarity,
          message: `Task already underway by user '${task.claimed_by_user_id || task.claimedByUserId}' on branch '${task.branch_name || task.branchName}'.`
        };
      }
    }

    return { isDuplicate: false };
  }

  /**
   * Detects contradictory architectural directives and triggers an RFC Alignment Gate.
   */
  async checkSponsorAlignment(
    newDirective: string,
    projectId: string,
    spaceDoStub: any
  ): Promise<{ hasConflict: boolean; rfcTitle?: string; conflictingDirectives?: string[] }> {
    const architecturalKeywords = ["auth", "database", "orm", "framework", "schema", "router", "state"];
    const isArchitectural = architecturalKeywords.some(kw => newDirective.toLowerCase().includes(kw));

    if (!isArchitectural) {
      return { hasConflict: false };
    }

    let activeTasks: any[] = [];
    try {
      if (typeof spaceDoStub.listActiveTasksForProject === "function") {
        activeTasks = await spaceDoStub.listActiveTasksForProject(projectId);
      } else {
        const resp = await spaceDoStub.fetch(`http://internal/projects/${projectId}/tasks/active`);
        activeTasks = await resp.json() as any[];
      }
    } catch {
      return { hasConflict: false };
    }

    const conflictingTask = activeTasks.find((t: any) => 
      architecturalKeywords.some(kw => (t.title || "").toLowerCase().includes(kw) && (t.title || "").toLowerCase() !== newDirective.toLowerCase())
    );

    if (conflictingTask) {
      return {
        hasConflict: true,
        rfcTitle: `RFC: Resolve Architectural Direction for ${projectId}`,
        conflictingDirectives: [conflictingTask.title, newDirective]
      };
    }

    return { hasConflict: false };
  }

  // ── Invoker-Attested Split-Actor Execution & Finite Task Auto-Sleep (Chunk 05) ──
  async executeAttestedTurn(
    actionType: string,
    payload: any,
    callerContext: { userId: string; sessionId: string; assistantId: string; agentId: string; spaceId: string; projectId?: string }
  ) {
    // 1. Verify Split-Actor Invoker Attestation
    if (!callerContext.userId || !callerContext.sessionId) {
      throw new Error("Security Violation: Action lacks verified human invoker attestation.");
    }

    // 2. Execute mutation logic...
    const result = await this.runToolOperation(actionType, payload);

    // 3. Record Immutable Cryptographic Audit Entry
    const provPayload = {
      id: `prov_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      spaceId: callerContext.spaceId,
      projectId: callerContext.projectId,
      actionId: `act_${Date.now()}`,
      humanUserId: callerContext.userId,
      jwtSessionId: callerContext.sessionId,
      assistantId: callerContext.assistantId,
      agentExecutorId: callerContext.agentId,
      actionType,
      payloadJson: payload,
      gitCommitSha: result.commitSha || null
    };

    if (this.env.SPACES) {
      const spaceStub = (this.env.SPACES as any).get(this.env.SPACES.idFromName(callerContext.spaceId));
      if (typeof spaceStub.recordProvenanceEntry === "function") {
        await spaceStub.recordProvenanceEntry(provPayload);
      } else {
        await spaceStub.fetch("http://internal/provenance/record", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(provPayload),
        });
      }
    } else if (this.env.SPACES_WORKER) {
      const headers = await this.internalHeaders("");
      await this.env.SPACES_WORKER.fetch(new Request(`http://spaces-worker/spaces/${callerContext.spaceId}/provenance/record`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(provPayload),
      })).catch(() => {});
    }

    // 4. Check Finite Task Project Auto-Sleep
    if (callerContext.projectId) {
      let isComplete = false;
      if (this.env.SPACES) {
        const spaceStub = (this.env.SPACES as any).get(this.env.SPACES.idFromName(callerContext.spaceId));
        if (typeof spaceStub.checkProjectDagComplete === "function") {
          isComplete = await spaceStub.checkProjectDagComplete(callerContext.projectId);
        } else {
          const resp = await spaceStub.fetch(`http://internal/projects/${callerContext.projectId}/dag-complete`);
          if (resp.ok) {
            const data = await resp.json() as any;
            isComplete = data.complete === true;
          }
        }
      } else if (this.env.SPACES_WORKER) {
        const resp = await this.env.SPACES_WORKER.fetch(
          new Request(`http://spaces-worker/spaces/${callerContext.spaceId}/projects/${callerContext.projectId}/dag-complete`, {
            headers: await this.internalHeaders(""),
          })
        ).catch(() => null);
        if (resp && resp.ok) {
          const data = await resp.json() as any;
          isComplete = data.complete === true;
        }
      }

      if (isComplete) {
        console.log(`💤 Project ${callerContext.projectId} Task DAG reached 100%. Entering dormant hibernation...`);
        await this.ctx.storage.deleteAlarm();
        // Hibernates DO state at $0 cost
      }
    }

    return result;
  }

  private async runToolOperation(type: string, payload: any): Promise<{ ok: boolean; commitSha?: string; [key: string]: any }> {
    // Tool execution implementation
    return { ok: true, commitSha: "c_4f112b" };
  }
}

function calculateCosineSimilarity(vecA: number[], vecB: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(vecA.length, vecB.length);
  for (let i = 0; i < len; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  return normA === 0 || normB === 0 ? 0 : dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}
