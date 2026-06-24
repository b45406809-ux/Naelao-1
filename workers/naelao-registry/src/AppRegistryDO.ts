import { DurableObject } from 'cloudflare:workers';

interface Env {
  NAELAO_CONFIG_KV: KVNamespace;
  NAELAO_ANALYTICS: AnalyticsEngineDataset;
}

function scanForPromptInjection(text: string): { safe: boolean; reason?: string } {
  const lower = text.toLowerCase();
  const patterns: Array<[RegExp, string]> = [
    [/ignore (all|previous|your) instructions/i, 'instruction override detected'],
    [/forget (everything|all|your training)/i, 'training override detected'],
    [/new (persona|role|instructions)/i, 'persona injection detected'],
    [/https?:\/\//i, 'URL in system prompt (exfiltration risk)'],
    [/\bdan\b/i, 'DAN mode pattern detected'],
  ];
  for (const [re, reason] of patterns) {
    if (re.test(lower)) return { safe: false, reason };
  }
  return { safe: true };
}

export class AppRegistryDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.sql = state.storage.sql;
    state.blockConcurrencyWhile(() => this.initSchema());
  }

  private initSchema(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY DEFAULT 0)`);
    this.sql.exec(`INSERT OR IGNORE INTO schema_version VALUES (0)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS apps (
      id TEXT PRIMARY KEY, name TEXT, description TEXT, system_prompt TEXT, ui_instructions TEXT,
      publisher_id TEXT, status TEXT DEFAULT 'pending', scan_result TEXT,
      published_at TEXT, created_at TEXT
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS installs (
      space_id TEXT, app_id TEXT, installed_at TEXT, PRIMARY KEY(space_id, app_id)
    )`);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === '/apps/publish' && request.method === 'POST') return this.handlePublish(request);
      if (path === '/apps' && request.method === 'GET') return this.handleListApps(url);
      if (path.match(/^\/apps\/[^/]+\/install$/) && request.method === 'POST') return this.handleInstall(request, path);
      if (path.startsWith('/apps/') && request.method === 'GET') return this.handleGetApp(path);
      return Response.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, { status: 404 });
    } catch (e) {
      return Response.json({ error: { code: 'INTERNAL_ERROR', message: String(e) } }, { status: 500 });
    }
  }

  private async handlePublish(request: Request): Promise<Response> {
    const { id, name, description, systemPrompt, uiInstructions, publisherId } = await request.json<{
      id: string; name: string; description: string; systemPrompt: string;
      uiInstructions: string; publisherId: string;
    }>();

    const promptScan = scanForPromptInjection(systemPrompt);
    const uiScan = scanForPromptInjection(uiInstructions);

    if (!promptScan.safe || !uiScan.safe) {
      const reason = promptScan.reason ?? uiScan.reason ?? 'injection detected';
      const now = new Date().toISOString();
      this.sql.exec(
        `INSERT OR REPLACE INTO apps (id, name, description, publisher_id, status, scan_result, created_at)
         VALUES (?, ?, ?, ?, 'rejected', ?, ?)`,
        id, name, description, publisherId, reason, now
      );
      return Response.json({ error: { code: 'REJECTED', message: 'Content rejected: ' + reason } }, { status: 422 });
    }

    const now = new Date().toISOString();
    this.sql.exec(
      `INSERT OR REPLACE INTO apps (id, name, description, system_prompt, ui_instructions,
       publisher_id, status, scan_result, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 'clean', ?)`,
      id, name, description, systemPrompt, uiInstructions, publisherId, now
    );

    return Response.json({ data: { status: 'pending', message: 'Under review' } });
  }

  private handleListApps(url: URL): Response {
    const cursor = parseInt(url.searchParams.get('cursor') ?? '0');
    const limit = parseInt(url.searchParams.get('limit') ?? '20');
    const rows = [...this.sql.exec<Record<string, unknown>>(
      `SELECT id, name, description, publisher_id, published_at FROM apps WHERE status = 'active'
       ORDER BY published_at DESC LIMIT ? OFFSET ?`, limit, cursor
    )];
    return Response.json({ data: { items: rows, nextCursor: cursor + rows.length } });
  }

  private async handleInstall(request: Request, path: string): Promise<Response> {
    const appId = path.split('/')[2] ?? '';
    const { spaceId } = await request.json<{ spaceId: string }>();
    const now = new Date().toISOString();
    this.sql.exec(
      `INSERT OR REPLACE INTO installs (space_id, app_id, installed_at) VALUES (?, ?, ?)`,
      spaceId, appId, now
    );
    return Response.json({ data: { ok: true } });
  }

  private handleGetApp(path: string): Response {
    const appId = path.split('/')[2] ?? '';
    const row = [...this.sql.exec<Record<string, unknown>>(`SELECT * FROM apps WHERE id = ?`, appId)][0];
    if (!row) return Response.json({ error: { code: 'NOT_FOUND', message: 'App not found' } }, { status: 404 });
    if (row['status'] !== 'active') {
      const { system_prompt: _sp, ui_instructions: _ui, ...safe } = row as Record<string, unknown>;
      return Response.json({ data: safe });
    }
    return Response.json({ data: row });
  }
}
