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
import { callLlm, moderateInput } from "@naelao/llm-gateway";

// ── SQLite row types ─────────────────────────────────────────────────────────

interface AgentRunRow {
  id: string;
  session_id: string;
  space_id: string;
  tenant_id: string;
  status: string;
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
const MAX_TOOL_OUTPUT_BYTES = 100 * 1024; // 100KB
const TIMEOUT_MS = 30_000; // 30 seconds
const TIMEOUT_QUERY_THRESHOLD_S = 25; // flag runs older than 25s

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

        return { output: `HTTP ${resp.status}\n${truncated}` };
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

        const results = data.data
          .map((r, i) => `[${i + 1}] ${r.content}`)
          .join("\n\n---\n\n");

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
        goal         TEXT NOT NULL,
        react_steps  TEXT NOT NULL DEFAULT '[]',
        final_answer TEXT,
        error        TEXT,
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

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

    // Create run record
    this.ctx.storage.sql.exec(
      `INSERT INTO agent_runs (id, session_id, space_id, tenant_id, status, goal, react_steps, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'running', ?, '[]', ?, ?)`,
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

      this.ctx.storage.sql.exec(
        `UPDATE agent_runs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`,
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

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      // Check if current run has been cancelled
      const runRow = (this.ctx.storage.sql
        .exec(`SELECT status FROM agent_runs WHERE id = ?`, runId)
        .toArray() as { status: string }[])[0];

      if (!runRow || runRow.status === "cancelled") {
        throw new Error("Agent run was cancelled");
      }

      // Call LLM
      const llmResponse = await callLlm(apiKey, {
        model,
        system: fullSystem,
        messages,
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

      // Check if this is a final answer (no tool use)
      if (llmResponse.stop_reason === "end_turn") {
        const answerText = llmResponse.content
          .filter((b) => b.type === "text")
          .map((b) => b.text ?? "")
          .join("\n")
          .trim();

        step.finalAnswer = answerText;
        reactSteps.push(step);

        // Persist steps
        this.persistReactSteps(runId, reactSteps);

        return answerText;
      }

      // Handle tool use
      if (llmResponse.stop_reason === "tool_use") {
        const toolUseBlocks = llmResponse.content.filter(
          (b) => b.type === "tool_use"
        );

        // Append assistant message with all content
        messages.push({
          role: "assistant",
          content: llmResponse.content,
        });

        // Execute each tool and collect results
        const toolResults: ContentBlock[] = [];

        for (const toolBlock of toolUseBlocks) {
          if (
            !toolBlock.id ||
            !toolBlock.name ||
            !toolBlock.input
          ) {
            continue;
          }

          step.action = {
            toolName: toolBlock.name,
            toolInput: toolBlock.input,
            toolUseId: toolBlock.id,
          };

          const result = await dispatchTool(
            toolBlock.name,
            toolBlock.input,
            allowedDomains,
            services
          );

          const observation = result.error
            ? `Error: ${result.error}`
            : result.output;

          step.observation = observation;

          toolResults.push({
            type: "tool_result",
            tool_use_id: toolBlock.id,
            content: observation,
          });
        }

        reactSteps.push(step);
        this.persistReactSteps(runId, reactSteps);

        // Append tool results as a user message
        messages.push({
          role: "user",
          content: toolResults,
        });

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
