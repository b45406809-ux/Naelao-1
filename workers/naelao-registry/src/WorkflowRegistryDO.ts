import { DurableObject } from 'cloudflare:workers';

interface Env {
  NAELAO_CONFIG_KV: KVNamespace;
  NAELAO_WORKFLOW_DISPATCH: Queue;
  NAELAO_ANALYTICS: AnalyticsEngineDataset;
}

function parseNextRun(schedule: string, timezone: string, after?: Date): Date {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('invalid_cron: ' + schedule);

  const [minPart, hourPart, domPart, monPart, dowPart] = parts as [string, string, string, string, string];

  const base = after ?? new Date();
  let current = new Date(base.getTime() + 60_000);
  current.setSeconds(0, 0);

  const parseField = (f: string, min: number, max: number): number[] | null => {
    if (f === '*') return null;
    const result: number[] = [];
    for (const part of f.split(',')) {
      if (part.includes('/')) {
        const [, step] = part.split('/');
        for (let i = min; i <= max; i += parseInt(step!)) result.push(i);
      } else if (part.includes('-')) {
        const [lo, hi] = part.split('-').map(Number);
        for (let i = lo!; i <= hi!; i++) result.push(i);
      } else {
        result.push(parseInt(part));
      }
    }
    return result;
  };

  const mins = parseField(minPart, 0, 59);
  const hours = parseField(hourPart, 0, 23);
  const doms = parseField(domPart, 1, 31);
  const months = parseField(monPart, 1, 12);
  const dows = parseField(dowPart, 0, 6);

  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    minute: 'numeric', hour: 'numeric', day: 'numeric', month: 'numeric', year: 'numeric', weekday: 'narrow',
  });

  const oneYear = Date.now() + 365 * 86400_000;
  while (current.getTime() < oneYear) {
    const parts = fmt.formatToParts(current);
    const get = (type: string) => parseInt(parts.find(p => p.type === type)?.value ?? '0');
    const min = get('minute');
    const hour = get('hour') % 24;
    const dom = get('day');
    const mon = get('month');
    const dow = new Date(current).getDay();

    if (
      (!mins || mins.includes(min)) &&
      (!hours || hours.includes(hour)) &&
      (!doms || doms.includes(dom)) &&
      (!months || months.includes(mon)) &&
      (!dows || dows.includes(dow))
    ) {
      return current;
    }
    current = new Date(current.getTime() + 60_000);
  }
  throw new Error('invalid_cron: ' + schedule);
}

export class WorkflowRegistryDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.sql = state.storage.sql;
    state.blockConcurrencyWhile(() => this.initSchema());
  }

  private initSchema(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY DEFAULT 0)`);
    this.sql.exec(`INSERT OR IGNORE INTO schema_version VALUES (0)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY, space_id TEXT, name TEXT, code_r2_key TEXT,
      schedule TEXT, timezone TEXT DEFAULT 'UTC', next_run_at TEXT,
      status TEXT DEFAULT 'active', created_at TEXT
    )`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_workflows_space ON workflows(space_id)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_workflows_next_run ON workflows(next_run_at, status)`);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === '/workflows/register' && request.method === 'POST') return this.handleRegister(request);
      if (path.startsWith('/workflows/') && !path.endsWith('/trigger') && request.method === 'GET') return this.handleList(path);
      if (path.startsWith('/workflows/') && request.method === 'DELETE') return this.handleDelete(path);
      if (path.endsWith('/trigger') && request.method === 'POST') return this.handleTrigger(path);
      return Response.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, { status: 404 });
    } catch (e) {
      return Response.json({ error: { code: 'INTERNAL_ERROR', message: String(e) } }, { status: 500 });
    }
  }

  private async handleRegister(request: Request): Promise<Response> {
    const { id, spaceId, name, codeR2Key, schedule, timezone = 'UTC' } = await request.json<{
      id: string; spaceId: string; name: string; codeR2Key: string;
      schedule: string; timezone?: string;
    }>();

    let nextRun: Date;
    try {
      nextRun = parseNextRun(schedule, timezone);
    } catch (e) {
      return Response.json({ error: { code: 'INVALID_CRON', message: String(e) } }, { status: 400 });
    }

    const oneYear = Date.now() + 365 * 86400_000;
    if (nextRun.getTime() > oneYear) {
      return Response.json({ error: { code: 'INVALID_CRON', message: 'Next run is more than 1 year away' } }, { status: 400 });
    }

    const now = new Date().toISOString();
    this.sql.exec(
      `INSERT OR REPLACE INTO workflows (id, space_id, name, code_r2_key, schedule, timezone, next_run_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id, spaceId, name, codeR2Key, schedule, timezone, nextRun.toISOString(), now
    );

    const existing = await this.ctx.storage.getAlarm();
    if (!existing) await this.ctx.storage.setAlarm(Date.now() + 60_000);

    return Response.json({ data: { nextRunAt: nextRun.toISOString() } });
  }

  private handleList(path: string): Response {
    const spaceId = path.split('/')[2] ?? '';
    const rows = [...this.sql.exec<Record<string, unknown>>(
      `SELECT * FROM workflows WHERE space_id = ? ORDER BY next_run_at ASC`, spaceId
    )];
    return Response.json({ data: { workflows: rows } });
  }

  private handleDelete(path: string): Response {
    const id = path.split('/')[2] ?? '';
    this.sql.exec(`DELETE FROM workflows WHERE id = ?`, id);
    return Response.json({ data: { ok: true } });
  }

  private async handleTrigger(path: string): Promise<Response> {
    const id = path.split('/')[2] ?? '';
    const wf = [...this.sql.exec<{ id: string; space_id: string }>(
      `SELECT id, space_id FROM workflows WHERE id = ?`, id
    )][0];
    if (!wf) return Response.json({ error: { code: 'NOT_FOUND', message: 'Workflow not found' } }, { status: 404 });
    await this.env.NAELAO_WORKFLOW_DISPATCH.send({ workflowId: wf.id, spaceId: wf.space_id, triggeredBy: 'manual' });
    return Response.json({ data: { queued: true } });
  }

  async alarm(): Promise<void> {
    const due = [...this.sql.exec<{ id: string; space_id: string; schedule: string; timezone: string }>(
      `SELECT id, space_id, schedule, timezone FROM workflows WHERE next_run_at <= datetime('now') AND status = 'active'`
    )];

    await Promise.all(due.map(wf => this.env.NAELAO_WORKFLOW_DISPATCH.send({
      workflowId: wf.id,
      spaceId: wf.space_id,
      triggeredBy: 'schedule',
    })));

    for (const wf of due) {
      try {
        const nextRun = parseNextRun(wf.schedule, wf.timezone);
        this.sql.exec(`UPDATE workflows SET next_run_at = ? WHERE id = ?`, nextRun.toISOString(), wf.id);
      } catch {
        this.sql.exec(`UPDATE workflows SET status = 'error' WHERE id = ?`, wf.id);
      }
    }

    await this.ctx.storage.setAlarm(Date.now() + 60_000);
  }
}
