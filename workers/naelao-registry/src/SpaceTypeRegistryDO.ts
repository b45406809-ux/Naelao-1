import { DurableObject } from 'cloudflare:workers';

interface Env {
  NAELAO_CONFIG_KV: KVNamespace;
  NAELAO_ANALYTICS: AnalyticsEngineDataset;
}

export class SpaceTypeRegistryDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.sql = state.storage.sql;
    state.blockConcurrencyWhile(() => this.initSchema());
  }

  private initSchema(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY DEFAULT 0)`);
    this.sql.exec(`INSERT OR IGNORE INTO schema_version VALUES (0)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS space_types (
      id TEXT PRIMARY KEY, name TEXT, description TEXT, manifest TEXT,
      current_version TEXT, published_at TEXT, publisher_id TEXT, status TEXT DEFAULT 'active'
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS versions (
      id TEXT PRIMARY KEY, type_id TEXT, version TEXT, change_type TEXT, manifest TEXT,
      canary_pct INTEGER DEFAULT 0, canary_sample_count INTEGER DEFAULT 0,
      error_rate REAL DEFAULT 0, published_at TEXT, promoted_at TEXT
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS instances (
      space_id TEXT PRIMARY KEY, type_id TEXT, version TEXT, created_at TEXT
    )`);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === '/types/register' && request.method === 'POST') return this.handleRegister(request);
      if (path.startsWith('/types/') && path !== '/types' && request.method === 'GET') return this.handleGetType(path);
      if (path === '/types' && request.method === 'GET') return this.handleListTypes(url);
      if (path === '/canary/check' && request.method === 'POST') return this.handleCanaryCheck(request);
      if (path === '/canary/process' && request.method === 'POST') return this.handleCanaryProcess();
      return Response.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, { status: 404 });
    } catch (e) {
      return Response.json({ error: { code: 'INTERNAL_ERROR', message: String(e) } }, { status: 500 });
    }
  }

  private async handleRegister(request: Request): Promise<Response> {
    const { id, name, description, manifest, changeType, publisherId } = await request.json<{
      id: string; name: string; description: string; manifest: string; changeType: string; publisherId: string;
    }>();

    const version = crypto.randomUUID().slice(0, 8);
    const now = new Date().toISOString();

    this.sql.exec(
      `INSERT OR REPLACE INTO space_types (id, name, description, manifest, current_version, published_at, publisher_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id, name, description, manifest, version, now, publisherId
    );
    this.sql.exec(
      `INSERT INTO versions (id, type_id, version, change_type, manifest, published_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      crypto.randomUUID(), id, version, changeType, manifest, now
    );

    return Response.json({ data: { version } });
  }

  private async handleGetType(path: string): Promise<Response> {
    const typeId = path.split('/')[2] ?? '';
    const cacheKey = 'space-type:' + typeId;
    const staleKey = 'space-type-stale:' + typeId;

    const cached = await this.env.NAELAO_CONFIG_KV.get(cacheKey);
    const staleAt = await this.env.NAELAO_CONFIG_KV.get(staleKey);

    if (cached) {
      const isStale = staleAt && Date.now() > parseInt(staleAt);
      if (!isStale) {
        return Response.json({ data: JSON.parse(cached) });
      }
    }

    const row = [...this.sql.exec<Record<string, unknown>>(`SELECT * FROM space_types WHERE id = ?`, typeId)][0];
    if (!row) return Response.json({ error: { code: 'NOT_FOUND', message: 'Type not found' } }, { status: 404 });

    const ttl = 86400;
    const staleAfter = Date.now() + 3600 * 1000;
    await this.env.NAELAO_CONFIG_KV.put(cacheKey, JSON.stringify(row), { expirationTtl: ttl });
    await this.env.NAELAO_CONFIG_KV.put(staleKey, String(staleAfter), { expirationTtl: ttl });

    return Response.json({ data: row });
  }

  private handleListTypes(url: URL): Response {
    const cursor = parseInt(url.searchParams.get('cursor') ?? '0');
    const limit = parseInt(url.searchParams.get('limit') ?? '20');
    const rows = [...this.sql.exec<Record<string, unknown>>(
      `SELECT * FROM space_types ORDER BY published_at DESC LIMIT ? OFFSET ?`, limit, cursor
    )];
    return Response.json({ data: { items: rows, nextCursor: cursor + rows.length } });
  }

  private async handleCanaryCheck(request: Request): Promise<Response> {
    const { typeId, spaceId } = await request.json<{ typeId: string; spaceId: string }>();
    const type = [...this.sql.exec<{ current_version: string }>(`SELECT current_version FROM space_types WHERE id = ?`, typeId)][0];
    if (!type) return Response.json({ error: { code: 'NOT_FOUND', message: 'Type not found' } }, { status: 404 });

    const canary = [...this.sql.exec<{ version: string; canary_pct: number }>(
      `SELECT version, canary_pct FROM versions WHERE type_id = ? AND canary_pct < 100 ORDER BY published_at DESC LIMIT 1`, typeId
    )][0];

    if (canary && Math.random() * 100 < canary.canary_pct) {
      this.sql.exec(
        `UPDATE versions SET canary_sample_count = canary_sample_count + 1 WHERE type_id = ? AND version = ?`,
        typeId, canary.version
      );
      return Response.json({ data: { version: canary.version } });
    }

    return Response.json({ data: { version: type.current_version } });
  }

  private async handleCanaryProcess(): Promise<Response> {
    await this.processCanaryRollouts();
    return Response.json({ data: { ok: true } });
  }

  async alarm(): Promise<void> {
    await this.processCanaryRollouts();
    await this.ctx.storage.setAlarm(Date.now() + 3600_000);
  }

  private async processCanaryRollouts(): Promise<void> {
    const versions = [...this.sql.exec<{
      id: string; type_id: string; version: string; canary_pct: number;
      canary_sample_count: number; error_rate: number; published_at: string;
    }>(`SELECT * FROM versions WHERE canary_pct < 100 AND canary_pct > 0`)];

    for (const v of versions) {
      if (v.canary_sample_count < 50) continue;

      const publishedAt = new Date(v.published_at).getTime();
      const hoursSince = (Date.now() - publishedAt) / 3600000;
      if (hoursSince < 48) continue;

      if (v.error_rate >= 0.05) {
        this.sql.exec(`UPDATE versions SET canary_pct = 0 WHERE id = ?`, v.id);
        this.rollbackInstances(v.type_id, v.version);
      } else {
        const nextPct = v.canary_pct < 5 ? 5 : v.canary_pct < 20 ? 20 : v.canary_pct < 50 ? 50 : 100;
        if (nextPct === 100) {
          this.sql.exec(
            `UPDATE versions SET canary_pct = 100, promoted_at = ? WHERE id = ?`,
            new Date().toISOString(), v.id
          );
          this.sql.exec(`UPDATE space_types SET current_version = ? WHERE id = ?`, v.version, v.type_id);
        } else {
          this.sql.exec(`UPDATE versions SET canary_pct = ? WHERE id = ?`, nextPct, v.id);
        }
      }
    }
  }

  private rollbackInstances(typeId: string, badVersion: string): void {
    const stable = [...this.sql.exec<{ version: string }>(
      `SELECT version FROM versions WHERE type_id = ? AND canary_pct = 100 AND promoted_at IS NOT NULL
       ORDER BY promoted_at DESC LIMIT 1`, typeId
    )][0];
    if (stable) {
      this.sql.exec(
        `UPDATE instances SET version = ? WHERE type_id = ? AND version = ?`,
        stable.version, typeId, badVersion
      );
    }
  }
}
