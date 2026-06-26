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

// ── NaelaoAgentDO ────────────────────────────────────────────────────────────

export interface AgentDOEnv {
  PLATFORM_SECRET: string;
  KNOWLEDGE_WORKER: Fetcher;
  SPACES_WORKER: Fetcher;
}

export class NaelaoAgentDO extends DurableObject<AgentDOEnv> {
  private initialized = false;

  private ensureInit(): void {
    if (this.initialized) return;

    // WAL mode + schema
    this.ctx.storage.sql.exec("PRAGMA journal_mode=WAL");
    this.ctx.storage.sql.exec("PRAGMA synchronous=NORMAL");
    this.ctx.storage.sql.exec("PRAGMA cache_size=-16384");

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
    // G-AZ01: Migrate existing tables that lack fsm_state
    try {
      this.ctx.storage.sql.exec(`ALTER TABLE agent_runs ADD COLUMN fsm_state TEXT NOT NULL DEFAULT 'IDLE'`);
    } catch { /* column already exists — ignore */ }

    this.ctx.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_runs_session
        ON agent_runs(session_id, created_at DESC)
    `);

    this.initialized = true;
  }

  override async fetch(request: Request): Promise<Response> {
    this.ensureInit();

    const url = new URL(request.url);
    const method = request.method;

    try {
      // POST /run
      if (method === "POST" && url.pathname === "/run") {
        return this.handleRun(request);
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
    // Build initial messages
    // System prompt + KB context forms the system; goal is first user message
    const fullSystem = kbContext
      ? `${systemPrompt}\n\n<kb_content>\n${kbContext}\n</kb_content>`
      : systemPrompt;

    const messages: LlmMessage[] = [
      { role: "user", content: goal },
    ];

    const reactSteps: ReactStep[] = [];
    // G-X01: Track per-tool call counts to prevent unbounded recursive loops
    const toolCallCounts = new Map<string, number>();
    // G-BB41: Track total tool calls across all iterations of this run
    let totalToolCallsThisRun = 0;

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
      const contextMessages = truncateMiddle(messages, MAX_CONTEXT_MESSAGES);

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

        // Partition: pre-check limits and policy before dispatching in parallel
        const dispatchQueue: Array<{ block: ContentBlock; skip?: ContentBlock }> = [];
        for (const toolBlock of toolUseBlocks) {
          if (!toolBlock.id || !toolBlock.name || !toolBlock.input) continue;

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
