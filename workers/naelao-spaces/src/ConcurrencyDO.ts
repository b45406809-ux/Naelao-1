import { DurableObject } from 'cloudflare:workers';

interface Env {}

export class ConcurrencyDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.sql = state.storage.sql;
    state.blockConcurrencyWhile(() => this.initSchema());
  }

  private initSchema(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS slots (
      run_id TEXT PRIMARY KEY,
      agent_id TEXT,
      space_id TEXT,
      last_heartbeat INTEGER,
      created_at INTEGER
    )`);

    this.sql.exec(`CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT
    )`);

    this.sql.exec(`CREATE TABLE IF NOT EXISTS locks (
      lock_id TEXT PRIMARY KEY,
      expires_at INTEGER
    )`);

    this.sql.exec(`INSERT OR IGNORE INTO config (key, value) VALUES ('max_concurrent', '5')`);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case '/reserve': return this.handleReserve(request);
        case '/heartbeat': return this.handleHeartbeat(request);
        case '/release': return this.handleRelease(request);
        case '/slots': return this.handleSlots();
        case '/acquire': return this.handleAcquireLock(request);
        case '/release-lock': return this.handleReleaseLock(request);
        default:
          return Response.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, { status: 404 });
      }
    } catch (e) {
      return Response.json({ error: { code: 'INTERNAL_ERROR', message: String(e) } }, { status: 500 });
    }
  }

  private async handleReserve(request: Request): Promise<Response> {
    const { runId, agentId, spaceId, maxConcurrent } = await request.json<{
      runId: string; agentId?: string; spaceId?: string; maxConcurrent?: number;
    }>();

    const maxRow = [...this.sql.exec<{ value: string }>(`SELECT value FROM config WHERE key = 'max_concurrent'`)][0];
    const max = maxConcurrent ?? parseInt(maxRow?.value ?? '5', 10);

    const currentCount = [...this.sql.exec<{ count: number }>(`SELECT COUNT(*) as count FROM slots`)][0]?.count ?? 0;

    if (currentCount >= max) {
      return Response.json({ data: { granted: false, reason: 'concurrency_limit_reached' } });
    }

    const now = Date.now();
    this.sql.exec(
      `INSERT OR REPLACE INTO slots (run_id, agent_id, space_id, last_heartbeat, created_at) VALUES (?, ?, ?, ?, ?)`,
      runId, agentId ?? null, spaceId ?? null, now, now
    );

    const existing = await this.ctx.storage.getAlarm();
    if (!existing) {
      await this.ctx.storage.setAlarm(Date.now() + 300_000);
    }

    return Response.json({ data: { granted: true } });
  }

  private async handleHeartbeat(request: Request): Promise<Response> {
    const { runId } = await request.json<{ runId: string }>();
    this.sql.exec(`UPDATE slots SET last_heartbeat = ? WHERE run_id = ?`, Date.now(), runId);
    return Response.json({ data: { ok: true } });
  }

  private async handleRelease(request: Request): Promise<Response> {
    const { runId } = await request.json<{ runId: string }>();
    this.sql.exec(`DELETE FROM slots WHERE run_id = ?`, runId);
    return Response.json({ data: { ok: true } });
  }

  private handleSlots(): Response {
    const maxRow = [...this.sql.exec<{ value: string }>(`SELECT value FROM config WHERE key = 'max_concurrent'`)][0];
    const max = parseInt(maxRow?.value ?? '5', 10);
    const runs = [...this.sql.exec<Record<string, unknown>>(`SELECT * FROM slots`)];
    return Response.json({ data: { used: runs.length, max, runs } });
  }

  private async handleAcquireLock(request: Request): Promise<Response> {
    const { lockId } = await request.json<{ lockId: string }>();
    const now = Date.now();
    const existing = [...this.sql.exec<{ lock_id: string; expires_at: number }>(
      `SELECT lock_id, expires_at FROM locks WHERE lock_id = ?`, lockId
    )][0];

    if (existing && existing.expires_at > now) {
      return Response.json({ data: { granted: false } });
    }

    this.sql.exec(
      `INSERT OR REPLACE INTO locks (lock_id, expires_at) VALUES (?, ?)`,
      lockId, now + 30_000
    );

    const existing2 = await this.ctx.storage.getAlarm();
    if (!existing2) {
      await this.ctx.storage.setAlarm(Date.now() + 30_000);
    }

    return Response.json({ data: { granted: true } });
  }

  private async handleReleaseLock(request: Request): Promise<Response> {
    const { lockId } = await request.json<{ lockId: string }>();
    this.sql.exec(`DELETE FROM locks WHERE lock_id = ?`, lockId);
    return Response.json({ data: { ok: true } });
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    this.sql.exec(`DELETE FROM slots WHERE last_heartbeat < ?`, now - 300_000);
    this.sql.exec(`DELETE FROM locks WHERE expires_at < ?`, now);

    const remaining = [...this.sql.exec<{ count: number }>(`SELECT COUNT(*) as count FROM slots`)][0]?.count ?? 0;
    const locks = [...this.sql.exec<{ count: number }>(`SELECT COUNT(*) as count FROM locks`)][0]?.count ?? 0;

    if (remaining > 0 || locks > 0) {
      await this.ctx.storage.setAlarm(Date.now() + 300_000);
    }
  }
}
