import { DurableObject } from 'cloudflare:workers';
import { createWALEntry, markWALRunning, markWALComplete, markWALFailed, getPendingWALEntries, cleanOldWALEntries } from './wal';
import { createFiber, updateFiberStatus, isTerminal, hasToolBudget, truncateMessages } from './fiber';
import { runRemoteLoop, type ChatMessage } from './remote-loop';
import { executeTool, type RunContext } from './tool-executor';

interface Env {
  NAELAO_SPACE_DO: DurableObjectNamespace;
  NAELAO_WALLET_DO: DurableObjectNamespace;
  NAELAO_CONCURRENCY_DO: DurableObjectNamespace;
  NAELAO_THREADS_DO: DurableObjectNamespace;
  NAELAO_MCP_HUB: Fetcher;
  NAELAO_KNOWLEDGE: Fetcher;
  NAELAO_CREDENTIALS: Fetcher;
  NAELAO_ANALYTICS: AnalyticsEngineDataset;
  NAELAO_WORKFLOW_DISPATCH: Queue;
  NAELAO_JWT_SECRET: string;
  NAELAO_TOGETHER_AI: Fetcher;
  PLATFORM_DAILY_CREDIT_CEILING: string;
  NAELAO_CONFIG_KV: KVNamespace;
  NAELAO_WORKSPACE: R2Bucket;
  NAELAO_CIRCUIT_KV: KVNamespace;
}

export class NaelaoAgentDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.sql = state.storage.sql;
    state.blockConcurrencyWhile(() => this.initSchema());
  }

  private initSchema(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY DEFAULT 0)`);
    this.sql.exec(`INSERT OR IGNORE INTO schema_version VALUES (0)`);

    this.sql.exec(`CREATE TABLE IF NOT EXISTS fibers (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      status TEXT,
      agent_id TEXT,
      space_id TEXT,
      thread_id TEXT,
      model TEXT,
      system_prompt TEXT,
      tool_budget INTEGER DEFAULT 50,
      tools_used INTEGER DEFAULT 0,
      token_buffer_watermark INTEGER DEFAULT 0,
      created_at TEXT,
      updated_at TEXT
    )`);

    this.sql.exec(`CREATE TABLE IF NOT EXISTS run_wal (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      tool_name TEXT,
      tool_args TEXT,
      tool_result TEXT,
      status TEXT,
      started_at TEXT,
      completed_at TEXT,
      error TEXT
    )`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_wal_run_status ON run_wal(run_id, status)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_wal_started ON run_wal(started_at)`);

    this.sql.exec(`CREATE TABLE IF NOT EXISTS token_buffer (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      delta TEXT NOT NULL,
      created_at INTEGER DEFAULT (unixepoch()*1000)
    )`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_tbuf_run ON token_buffer(run_id, id)`);

    this.sql.exec(`CREATE TABLE IF NOT EXISTS active_websockets (
      run_id TEXT PRIMARY KEY,
      connected_at TEXT
    )`);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/runs/start' && request.method === 'POST') return this.handleStart(request);
      if (path === '/runs/cancel' && request.method === 'POST') return this.handleCancel(request);
      if (path.startsWith('/runs/') && path.endsWith('/tool-result') && request.method === 'POST') {
        return this.handleToolResult(request, path);
      }
      if (path.startsWith('/runs/') && request.method === 'GET') return this.handleGetRun(path);
      if (path === '/ws') return this.handleWebSocketUpgrade(request);
      if (path === '/status') return this.handleStatus();
      if (path === '/cancel' && request.method === 'POST') return this.handleCancelSelf();
      if (path === '/init' && request.method === 'POST') return this.handleInit(request);
      if (path === '/' && request.method === 'DELETE') return this.handleDelete();
      return Response.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, { status: 404 });
    } catch (e) {
      return Response.json({ error: { code: 'INTERNAL_ERROR', message: String(e) } }, { status: 500 });
    }
  }

  private async handleInit(request: Request): Promise<Response> {
    const { spaceId, nodeId, userId, instructions, model, runId } = await request.json<{
      spaceId: string; nodeId?: string; userId: string; instructions: string; model?: string; runId: string;
    }>();

    const fiber = createFiber({
      runId,
      spaceId,
      agentId: nodeId ?? 'default',
      model: model ?? 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      systemPrompt: instructions,
    });

    const now = new Date().toISOString();
    this.sql.exec(
      `INSERT OR REPLACE INTO fibers (id, run_id, status, agent_id, space_id, model, system_prompt, tool_budget, tools_used, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      fiber.id, runId, 'idle', fiber.agentId, spaceId, fiber.model, instructions, 50, 0, now, now
    );

    this.ctx.waitUntil(this.runAgentLoop(runId, fiber.spaceId, fiber.model, instructions));

    return Response.json({ data: { runId, fiberId: fiber.id } });
  }

  private async handleStart(request: Request): Promise<Response> {
    const { threadId, model, systemPrompt, tools, spaceId, agentId } = await request.json<{
      threadId: string; model: string; systemPrompt: string; tools: unknown[]; spaceId: string; agentId: string;
    }>();

    const runId = crypto.randomUUID();
    const fiber = createFiber({ runId, spaceId, agentId, threadId, model, systemPrompt });
    const now = new Date().toISOString();

    this.sql.exec(
      `INSERT INTO fibers (id, run_id, status, agent_id, space_id, thread_id, model, system_prompt, tool_budget, tools_used, created_at, updated_at)
       VALUES (?, ?, 'idle', ?, ?, ?, ?, ?, 50, 0, ?, ?)`,
      fiber.id, runId, agentId, spaceId, threadId, model, systemPrompt, now, now
    );

    this.ctx.waitUntil(this.runAgentLoop(runId, spaceId, model, systemPrompt));

    return Response.json({ data: { runId } });
  }

  private async handleCancel(request: Request): Promise<Response> {
    const { runId } = await request.json<{ runId: string }>();
    this.sql.exec(`UPDATE fibers SET status = 'error', updated_at = ? WHERE run_id = ?`, new Date().toISOString(), runId);
    return Response.json({ data: { ok: true } });
  }

  private handleCancelSelf(): Response {
    this.sql.exec(`UPDATE fibers SET status = 'error', updated_at = ?`, new Date().toISOString());
    return Response.json({ data: { ok: true } });
  }

  private handleGetRun(path: string): Response {
    const runId = path.split('/')[2] ?? '';
    const fiber = [...this.sql.exec<Record<string, unknown>>(`SELECT * FROM fibers WHERE run_id = ?`, runId)][0];
    if (!fiber) return Response.json({ error: { code: 'NOT_FOUND', message: 'Run not found' } }, { status: 404 });
    return Response.json({ data: { run: fiber } });
  }

  private async handleToolResult(request: Request, path: string): Promise<Response> {
    const runId = path.split('/')[2] ?? '';
    const { callId, output, error } = await request.json<{ callId: string; output?: unknown; error?: string }>();
    if (error) {
      markWALFailed(this.sql, callId, error);
    } else {
      markWALComplete(this.sql, callId, output);
    }
    return Response.json({ data: { ok: true } });
  }

  private handleWebSocketUpgrade(request: Request): Response {
    const { 0: client, 1: server } = new WebSocketPair();
    const url = new URL(request.url);
    const runId = url.searchParams.get('runId') ?? 'unknown';
    const spaceId = url.searchParams.get('spaceId') ?? 'unknown';
    this.ctx.acceptWebSocket(server, [spaceId, runId]);
    this.sql.exec(`INSERT OR REPLACE INTO active_websockets (run_id, connected_at) VALUES (?, ?)`, runId, new Date().toISOString());
    return new Response(null, { status: 101, webSocket: client });
  }

  private handleStatus(): Response {
    const fiber = [...this.sql.exec<Record<string, unknown>>(`SELECT * FROM fibers LIMIT 1`)][0];
    return Response.json({ data: fiber ?? null });
  }

  private handleDelete(): Response {
    cleanOldWALEntries(this.sql);
    this.sql.exec(`DELETE FROM token_buffer`);
    this.sql.exec(`DELETE FROM active_websockets`);
    return Response.json({ data: { deleted: true } });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    try {
      if (typeof message !== 'string') {
        ws.send(JSON.stringify({ type: 'error', message: 'binary not supported' }));
        return;
      }
      const data = JSON.parse(message) as { type: string; runId?: string };
      if (data.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      } else if (data.type === 'cancel' && data.runId) {
        this.sql.exec(`UPDATE fibers SET status = 'error', updated_at = ? WHERE run_id = ?`, new Date().toISOString(), data.runId);
        ws.send(JSON.stringify({ type: 'cancelled', runId: data.runId }));
      }
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'invalid json' }));
    }
  }

  webSocketClose(ws: WebSocket, _code: number, _reason: string): void {
    const tags = this.ctx.getTags(ws);
    const runId = tags[1];
    if (runId) {
      this.sql.exec(`DELETE FROM active_websockets WHERE run_id = ?`, runId);
    }
  }

  private broadcastToRun(runId: string, message: object): void {
    const wss = this.ctx.getWebSockets();
    for (const ws of wss) {
      const tags = this.ctx.getTags(ws);
      if (tags[1] === runId) {
        try { ws.send(JSON.stringify(message)); } catch { /* ws closed */ }
      }
    }
  }

  private async runAgentLoop(runId: string, spaceId: string, model: string, systemPrompt: string): Promise<void> {
    const killSwitch = await this.env.NAELAO_CONFIG_KV.get('emergency:kill-all-agents');
    if (killSwitch) {
      this.sql.exec(`UPDATE fibers SET status = 'error', updated_at = ? WHERE run_id = ?`, new Date().toISOString(), runId);
      return;
    }

    this.sql.exec(`UPDATE fibers SET status = 'running', updated_at = ? WHERE run_id = ?`, new Date().toISOString(), runId);

    const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }];
    let maxIterations = 20;

    while (maxIterations-- > 0) {
      const fiberRow = [...this.sql.exec<{ status: string; tools_used: number; tool_budget: number }>(
        `SELECT status, tools_used, tool_budget FROM fibers WHERE run_id = ?`, runId
      )][0];

      if (!fiberRow || fiberRow.status === 'error') break;
      if (fiberRow.tools_used >= fiberRow.tool_budget) break;

      let assistantContent = '';
      let finishReason: string = 'stop';

      const finish = await runRemoteLoop(
        {
          model,
          messages,
          spaceId,
          runId,
          togetherAiService: this.env.NAELAO_TOGETHER_AI,
        },
        (chunk) => {
          if (chunk.delta) {
            assistantContent += chunk.delta;
            this.sql.exec(
              `INSERT INTO token_buffer (run_id, delta) VALUES (?, ?)`,
              runId, chunk.delta
            );
            this.broadcastToRun(runId, { type: 'delta', delta: chunk.delta });
          }
          if (chunk.finishReason) finishReason = chunk.finishReason;
        }
      );

      this.sql.exec(
        `DELETE FROM token_buffer WHERE run_id = ? AND id NOT IN (
          SELECT id FROM token_buffer WHERE run_id = ? ORDER BY id DESC LIMIT 500
        )`,
        runId, runId
      );

      if (assistantContent) {
        messages.push({ role: 'assistant', content: assistantContent });
      }

      if (finish !== 'tool_calls') {
        this.sql.exec(`UPDATE fibers SET status = 'done', updated_at = ? WHERE run_id = ?`, new Date().toISOString(), runId);
        this.broadcastToRun(runId, { type: 'done', runId });
        break;
      }

      if (finish === 'timeout') {
        this.sql.exec(`UPDATE fibers SET status = 'error', updated_at = ? WHERE run_id = ?`, new Date().toISOString(), runId);
        break;
      }
    }

    this.sql.exec(
      `UPDATE fibers SET status = CASE WHEN status = 'running' THEN 'done' ELSE status END, updated_at = ? WHERE run_id = ?`,
      new Date().toISOString(), runId
    );
  }
}
