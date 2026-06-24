import { DurableObject } from 'cloudflare:workers';

interface Env {}

export class LocalTunnelDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.sql = state.storage.sql;
    state.blockConcurrencyWhile(() => this.initSchema());
  }

  private initSchema(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS pending_calls (
      call_id TEXT PRIMARY KEY,
      agent_run_id TEXT,
      tool_name TEXT,
      tool_args TEXT,
      started_at INTEGER,
      timeout_ms INTEGER DEFAULT 30000
    )`);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === '/ws' && request.headers.get('Upgrade') === 'websocket') {
        return this.handleWebSocketUpgrade();
      }
      if (path === '/exec' && request.method === 'POST') return this.handleExec(request);
      if (path.startsWith('/result/') && request.method === 'GET') return this.handleGetResult(path);
      if (path === '/result' && request.method === 'POST') return this.handlePostResult(request);
      return Response.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, { status: 404 });
    } catch (e) {
      return Response.json({ error: { code: 'INTERNAL_ERROR', message: String(e) } }, { status: 500 });
    }
  }

  private handleWebSocketUpgrade(): Response {
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, ['local-agent']);
    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleExec(request: Request): Promise<Response> {
    const { callId, toolName, toolArgs, agentRunId, timeoutMs } = await request.json<{
      callId: string; toolName: string; toolArgs: unknown; agentRunId: string; timeoutMs?: number;
    }>();

    const now = Date.now();
    this.sql.exec(
      `INSERT OR REPLACE INTO pending_calls (call_id, agent_run_id, tool_name, tool_args, started_at, timeout_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
      callId, agentRunId, toolName, JSON.stringify(toolArgs), now, timeoutMs ?? 30000
    );

    const wss = this.ctx.getWebSockets('local-agent');
    const message = JSON.stringify({ type: 'tool_call', callId, toolName, toolArgs, agentRunId });
    for (const ws of wss) {
      ws.send(message);
    }

    const existingAlarm = await this.ctx.storage.getAlarm();
    if (!existingAlarm) {
      await this.ctx.storage.setAlarm(Date.now() + (timeoutMs ?? 30000));
    }

    return Response.json({ data: { callId } });
  }

  private async handleGetResult(path: string): Promise<Response> {
    const callId = path.split('/').pop() ?? '';
    const stored = await this.ctx.storage.get<{ result: unknown; error?: string }>('result:' + callId);

    if (stored) {
      await this.ctx.storage.delete('result:' + callId);
      return Response.json({ data: stored });
    }

    const pending = [...this.sql.exec<{ call_id: string }>(
      `SELECT call_id FROM pending_calls WHERE call_id = ?`, callId
    )][0];

    if (pending) {
      return new Response(JSON.stringify({ data: { pending: true } }), { status: 202 });
    }

    return Response.json(
      { error: { code: 'NOT_FOUND', message: 'not_found_or_expired' } },
      { status: 404 }
    );
  }

  private async handlePostResult(request: Request): Promise<Response> {
    const { callId, result, error } = await request.json<{ callId: string; result?: unknown; error?: string }>();
    await this.ctx.storage.put('result:' + callId, { result, error });
    this.sql.exec(`DELETE FROM pending_calls WHERE call_id = ?`, callId);
    return Response.json({ data: { ok: true } });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    try {
      if (typeof message !== 'string') return;
      const data = JSON.parse(message) as { type: string; callId: string; result?: unknown; error?: string };
      if (data.type === 'result' && data.callId) {
        this.ctx.storage.put('result:' + data.callId, { result: data.result, error: data.error });
        this.sql.exec(`DELETE FROM pending_calls WHERE call_id = ?`, data.callId);
      }
    } catch {
      // ignore malformed messages
    }
  }

  webSocketClose(_ws: WebSocket, _code: number, _reason: string): void {
    // connection closed; pending calls will timeout via alarm
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const expired = [...this.sql.exec<{ call_id: string; started_at: number; timeout_ms: number }>(
      `SELECT call_id, started_at, timeout_ms FROM pending_calls`
    )].filter(r => r.started_at + r.timeout_ms < now);

    for (const call of expired) {
      await this.ctx.storage.put('result:' + call.call_id, { error: 'timeout' });
      this.sql.exec(`DELETE FROM pending_calls WHERE call_id = ?`, call.call_id);
    }

    const remaining = [...this.sql.exec<{ count: number }>(`SELECT COUNT(*) as count FROM pending_calls`)][0]?.count ?? 0;
    if (remaining > 0) {
      await this.ctx.storage.setAlarm(Date.now() + 30_000);
    }
  }
}
