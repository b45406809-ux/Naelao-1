import { DurableObject } from 'cloudflare:workers';

interface Env {
  NAELAO_SPACE_DO: DurableObjectNamespace;
  NAELAO_WALLET_DO: DurableObjectNamespace;
  NAELAO_CONCURRENCY_DO: DurableObjectNamespace;
  NAELAO_BUILDER_DO: DurableObjectNamespace;
  NAELAO_CONFIG_KV: KVNamespace;
  NAELAO_ANALYTICS: AnalyticsEngineDataset;
  NAELAO_JWT_SECRET: string;
  ENVIRONMENT: string;
}

interface MemberCacheEntry {
  result: boolean;
  role?: string;
  expires: number;
}

export class SpaceDO extends DurableObject<Env> {
  private sql: SqlStorage;
  private authCache = new Map<string, MemberCacheEntry>();

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.sql = state.storage.sql;
    state.blockConcurrencyWhile(() => this.initSchema());
  }

  private initSchema(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY DEFAULT 0)`);
    this.sql.exec(`INSERT OR IGNORE INTO schema_version VALUES (0)`);

    this.sql.exec(`CREATE TABLE IF NOT EXISTS spaces (
      id TEXT PRIMARY KEY,
      root_space_id TEXT NOT NULL,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      status TEXT DEFAULT 'active',
      billing_provider TEXT DEFAULT 'lemon_squeezy',
      billing_subscription_id TEXT,
      billing_portal_url TEXT,
      billing_customer_id TEXT,
      space_type TEXT,
      metadata TEXT DEFAULT '{}',
      created_at TEXT,
      updated_at TEXT
    )`);

    this.sql.exec(`CREATE TABLE IF NOT EXISTS space_members (
      space_id TEXT,
      user_id TEXT,
      role TEXT,
      joined_at TEXT,
      PRIMARY KEY(space_id, user_id)
    )`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_members_user ON space_members(user_id)`);

    this.sql.exec(`CREATE TABLE IF NOT EXISTS space_credits (
      space_id TEXT PRIMARY KEY,
      balance_credits INTEGER DEFAULT 0,
      daily_spent_credits INTEGER DEFAULT 0,
      daily_reset_at TEXT,
      monthly_budget_credits INTEGER,
      platform_daily_ceiling INTEGER,
      updated_at TEXT
    )`);

    this.sql.exec(`CREATE TABLE IF NOT EXISTS token_usage (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      run_id TEXT,
      model_id TEXT,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      credits_charged INTEGER DEFAULT 0,
      created_at TEXT
    )`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_usage_space ON token_usage(space_id, created_at)`);

    this.sql.exec(`CREATE TABLE IF NOT EXISTS device_tokens (
      user_id TEXT,
      token TEXT,
      platform TEXT,
      registered_at TEXT,
      PRIMARY KEY(user_id, token)
    )`);

    this.sql.exec(`CREATE TABLE IF NOT EXISTS processed_billing_events (
      event_id TEXT PRIMARY KEY,
      processed_at TEXT
    )`);

    this.sql.exec(`CREATE TABLE IF NOT EXISTS knowledge_docs (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      project_id TEXT,
      title TEXT NOT NULL,
      status TEXT DEFAULT 'queued',
      chunk_count INTEGER DEFAULT 0,
      error_message TEXT,
      created_at TEXT
    )`);

    this.sql.exec(`CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      user_id TEXT,
      agent_id TEXT,
      status TEXT,
      model TEXT,
      thread_id TEXT,
      started_at TEXT,
      completed_at TEXT,
      credits_charged INTEGER DEFAULT 0
    )`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_runs_space ON agent_runs(space_id, started_at DESC)`);

    this.runMigrations();
  }

  private runMigrations(): void {
    const vRow = [...this.sql.exec<{ version: number }>('SELECT version FROM schema_version')][0];
    let v = vRow?.version ?? 0;

    if (v < 1) {
      try { this.sql.exec('ALTER TABLE spaces ADD COLUMN billing_portal_url TEXT'); } catch { /* exists */ }
      this.sql.exec('UPDATE schema_version SET version = 1');
      v = 1;
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/meta' && request.method === 'GET') return this.handleMeta();
      if (path === '/init' && request.method === 'POST') return this.handleInit(request);
      if (path === '/members/check' && request.method === 'POST') return this.handleMemberCheck(request);
      if (path === '/members/add' && request.method === 'POST') return this.handleMemberAdd(request);
      if (path === '/members/remove' && request.method === 'POST') return this.handleMemberRemove(request);
      if (path === '/members/list' && request.method === 'GET') return this.handleMemberList();
      if (path === '/members/role' && request.method === 'PATCH') return this.handleMemberRole(request);
      if (path === '/credits/deduct' && request.method === 'POST') return this.handleCreditsDeduct(request);
      if (path === '/credits/add' && request.method === 'POST') return this.handleCreditsAdd(request);
      if (path === '/credits/balance' && request.method === 'GET') return this.handleCreditsBalance();
      if (path === '/credits/record-usage' && request.method === 'POST') return this.handleRecordUsage(request);
      if (path === '/device-tokens' && request.method === 'GET') return this.handleDeviceTokens(url);
      if (path === '/device-tokens/upsert' && request.method === 'POST') return this.handleDeviceTokenUpsert(request);
      if (path === '/billing/update' && request.method === 'POST') return this.handleBillingUpdate(request);
      if (path === '/billing/event-check' && request.method === 'POST') return this.handleBillingEventCheck(request);
      if (path === '/billing/event-mark' && request.method === 'POST') return this.handleBillingEventMark(request);
      if (path === '/agents/runs/list' && request.method === 'GET') return this.handleAgentRunsList(url);
      if (path === '/purge' && request.method === 'POST') return this.handlePurge();
      if (path.startsWith('/knowledge/docs')) return this.handleKnowledgeDocs(request, url, path);
      if (path === '/agent-run/record' && request.method === 'POST') return this.handleAgentRunRecord(request);

      return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Route not found' } }), { status: 404 });
    } catch (e) {
      return new Response(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: String(e) } }), { status: 500 });
    }
  }

  private handleMeta(): Response {
    const row = [...this.sql.exec<Record<string, unknown>>('SELECT * FROM spaces LIMIT 1')][0];
    return Response.json({ data: row ?? null });
  }

  private async handleInit(request: Request): Promise<Response> {
    const { id, rootSpaceId, name, slug, spaceType, ownerId } = await request.json<{
      id: string; rootSpaceId: string; name: string; slug: string; spaceType?: string; ownerId: string;
    }>();
    const now = new Date().toISOString();
    this.sql.exec(
      `INSERT OR IGNORE INTO spaces (id, root_space_id, name, slug, space_type, status, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', '{}', ?, ?)`,
      id, rootSpaceId, name, slug, spaceType ?? 'standard', now, now
    );
    this.sql.exec(
      `INSERT OR IGNORE INTO space_credits (space_id, balance_credits, daily_spent_credits, daily_reset_at, updated_at)
       VALUES (?, 0, 0, ?, ?)`,
      id, now, now
    );
    this.sql.exec(
      `INSERT OR IGNORE INTO space_members (space_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)`,
      id, ownerId, now
    );
    return Response.json({ data: { ok: true } });
  }

  private async handleMemberCheck(request: Request): Promise<Response> {
    const { userId } = await request.json<{ userId: string }>();
    const spaceRow = [...this.sql.exec<{ id: string }>('SELECT id FROM spaces LIMIT 1')][0];
    if (!spaceRow) return Response.json({ data: { allowed: false } });

    const spaceId = spaceRow.id;
    const cacheKey = `${userId}:${spaceId}`;
    const cached = this.authCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) {
      return Response.json({ data: { allowed: cached.result, role: cached.role } });
    }

    const row = [...this.sql.exec<{ role: string }>(
      `SELECT role FROM space_members WHERE space_id = ? AND user_id = ?`, spaceId, userId
    )][0];

    const result = !!row;
    const role = row?.role;
    const expires = Date.now() + (result ? 300_000 : 30_000);
    this.authCache.set(cacheKey, { result, role, expires });

    return Response.json({ data: { allowed: result, role } });
  }

  private async handleMemberAdd(request: Request): Promise<Response> {
    const { userId, role } = await request.json<{ userId: string; role: string }>();
    const spaceRow = [...this.sql.exec<{ id: string }>('SELECT id FROM spaces LIMIT 1')][0];
    if (!spaceRow) return Response.json({ error: { code: 'SPACE_NOT_FOUND', message: 'Space not found' } }, { status: 404 });

    const spaceId = spaceRow.id;
    this.sql.exec(
      `INSERT OR REPLACE INTO space_members (space_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)`,
      spaceId, userId, role, new Date().toISOString()
    );
    this.authCache.delete(`${userId}:${spaceId}`);
    return Response.json({ data: { ok: true } });
  }

  private async handleMemberRemove(request: Request): Promise<Response> {
    const { userId } = await request.json<{ userId: string }>();
    const spaceRow = [...this.sql.exec<{ id: string }>('SELECT id FROM spaces LIMIT 1')][0];
    if (!spaceRow) return Response.json({ error: { code: 'SPACE_NOT_FOUND', message: 'Space not found' } }, { status: 404 });
    const spaceId = spaceRow.id;
    this.sql.exec(`DELETE FROM space_members WHERE space_id = ? AND user_id = ?`, spaceId, userId);
    this.authCache.delete(`${userId}:${spaceId}`);
    return Response.json({ data: { ok: true } });
  }

  private handleMemberList(): Response {
    const spaceRow = [...this.sql.exec<{ id: string }>('SELECT id FROM spaces LIMIT 1')][0];
    if (!spaceRow) return Response.json({ data: { members: [] } });
    const members = [...this.sql.exec<{ user_id: string; role: string; joined_at: string }>(
      `SELECT user_id, role, joined_at FROM space_members WHERE space_id = ?`, spaceRow.id
    )];
    return Response.json({ data: { members } });
  }

  private async handleMemberRole(request: Request): Promise<Response> {
    const { userId, role } = await request.json<{ userId: string; role: string }>();
    const spaceRow = [...this.sql.exec<{ id: string }>('SELECT id FROM spaces LIMIT 1')][0];
    if (!spaceRow) return Response.json({ error: { code: 'SPACE_NOT_FOUND', message: 'Space not found' } }, { status: 404 });
    const spaceId = spaceRow.id;
    this.sql.exec(`UPDATE space_members SET role = ? WHERE space_id = ? AND user_id = ?`, role, spaceId, userId);
    this.authCache.delete(`${userId}:${spaceId}`);
    return Response.json({ data: { ok: true } });
  }

  private async handleCreditsDeduct(request: Request): Promise<Response> {
    const { amount, reason, runId } = await request.json<{ amount: number; reason: string; runId?: string }>();
    const spaceRow = [...this.sql.exec<{ id: string }>('SELECT id FROM spaces LIMIT 1')][0];
    if (!spaceRow) return Response.json({ data: { success: false, balance: 0 } });
    const spaceId = spaceRow.id;

    const credits = [...this.sql.exec<{
      balance_credits: number;
      daily_spent_credits: number;
      daily_reset_at: string;
      platform_daily_ceiling: number | null;
    }>(`SELECT * FROM space_credits WHERE space_id = ?`, spaceId)][0];

    if (!credits) return Response.json({ data: { success: false, balance: 0 } });

    const today = new Date().toISOString().split('T')[0];
    const resetDay = credits.daily_reset_at?.split('T')[0];
    if (resetDay && resetDay < today!) {
      this.sql.exec(`UPDATE space_credits SET daily_spent_credits = 0, daily_reset_at = ? WHERE space_id = ?`,
        new Date().toISOString(), spaceId);
    }

    if (credits.platform_daily_ceiling !== null && credits.daily_spent_credits + amount > credits.platform_daily_ceiling) {
      return Response.json({ data: { success: false, balance: credits.balance_credits, reason: 'platform_daily_limit_exceeded' } });
    }

    this.sql.exec(
      `UPDATE space_credits SET balance_credits = balance_credits - ?, daily_spent_credits = daily_spent_credits + ?, updated_at = ?
       WHERE space_id = ? AND balance_credits >= ?`,
      amount, amount, new Date().toISOString(), spaceId, amount
    );

    const updated = [...this.sql.exec<{ balance_credits: number }>(`SELECT balance_credits FROM space_credits WHERE space_id = ?`, spaceId)][0];
    const success = (updated?.balance_credits ?? credits.balance_credits) < credits.balance_credits;

    return Response.json({ data: { success, balance: updated?.balance_credits ?? credits.balance_credits } });
  }

  private async handleCreditsAdd(request: Request): Promise<Response> {
    const { amount, reason, billingEventId } = await request.json<{ amount: number; reason: string; billingEventId: string }>();
    const spaceRow = [...this.sql.exec<{ id: string }>('SELECT id FROM spaces LIMIT 1')][0];
    if (!spaceRow) return Response.json({ error: { code: 'SPACE_NOT_FOUND', message: 'Space not found' } }, { status: 404 });
    const spaceId = spaceRow.id;

    this.sql.exec(
      `UPDATE space_credits SET balance_credits = balance_credits + ?, updated_at = ? WHERE space_id = ?`,
      amount, new Date().toISOString(), spaceId
    );
    const updated = [...this.sql.exec<{ balance_credits: number }>(`SELECT balance_credits FROM space_credits WHERE space_id = ?`, spaceId)][0];
    return Response.json({ data: { balance: updated?.balance_credits ?? 0 } });
  }

  private handleCreditsBalance(): Response {
    const spaceRow = [...this.sql.exec<{ id: string }>('SELECT id FROM spaces LIMIT 1')][0];
    if (!spaceRow) return Response.json({ data: { balance: 0, dailySpent: 0 } });
    const credits = [...this.sql.exec<{ balance_credits: number; daily_spent_credits: number }>(
      `SELECT balance_credits, daily_spent_credits FROM space_credits WHERE space_id = ?`, spaceRow.id
    )][0];
    return Response.json({ data: { balance: credits?.balance_credits ?? 0, dailySpent: credits?.daily_spent_credits ?? 0 } });
  }

  private async handleRecordUsage(request: Request): Promise<Response> {
    const { runId, modelId, inputTokens, outputTokens, creditsCharged } = await request.json<{
      runId: string; modelId: string; inputTokens: number; outputTokens: number; creditsCharged: number;
    }>();
    const spaceRow = [...this.sql.exec<{ id: string }>('SELECT id FROM spaces LIMIT 1')][0];
    if (!spaceRow) return Response.json({ data: { ok: true } });
    this.sql.exec(
      `INSERT INTO token_usage (id, space_id, run_id, model_id, input_tokens, output_tokens, credits_charged, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      crypto.randomUUID(), spaceRow.id, runId, modelId, inputTokens, outputTokens, creditsCharged, new Date().toISOString()
    );
    return Response.json({ data: { ok: true } });
  }

  private handleDeviceTokens(url: URL): Response {
    const userId = url.searchParams.get('userId') ?? '';
    const tokens = [...this.sql.exec<{ token: string; platform: string; registered_at: string }>(
      `SELECT token, platform, registered_at FROM device_tokens WHERE user_id = ?`, userId
    )];
    return Response.json({ data: { tokens } });
  }

  private async handleDeviceTokenUpsert(request: Request): Promise<Response> {
    const { userId, token, platform } = await request.json<{ userId: string; token: string; platform: string }>();
    this.sql.exec(
      `INSERT OR REPLACE INTO device_tokens (user_id, token, platform, registered_at) VALUES (?, ?, ?, ?)`,
      userId, token, platform, new Date().toISOString()
    );
    return Response.json({ data: { ok: true } });
  }

  private async handleBillingUpdate(request: Request): Promise<Response> {
    const update = await request.json<{ subscriptionId?: string; portalUrl?: string; status?: string; provider?: string }>();
    const now = new Date().toISOString();
    if (update.subscriptionId) this.sql.exec(`UPDATE spaces SET billing_subscription_id = ?, updated_at = ?`, update.subscriptionId, now);
    if (update.portalUrl) this.sql.exec(`UPDATE spaces SET billing_portal_url = ?, updated_at = ?`, update.portalUrl, now);
    if (update.status) this.sql.exec(`UPDATE spaces SET status = ?, updated_at = ?`, update.status, now);
    if (update.provider) this.sql.exec(`UPDATE spaces SET billing_provider = ?, updated_at = ?`, update.provider, now);
    return Response.json({ data: { ok: true } });
  }

  private async handleBillingEventCheck(request: Request): Promise<Response> {
    const { eventId } = await request.json<{ eventId: string }>();
    const row = [...this.sql.exec<{ event_id: string }>(`SELECT event_id FROM processed_billing_events WHERE event_id = ?`, eventId)][0];
    return Response.json({ data: { processed: !!row } });
  }

  private async handleBillingEventMark(request: Request): Promise<Response> {
    const { eventId } = await request.json<{ eventId: string }>();
    this.sql.exec(
      `INSERT OR IGNORE INTO processed_billing_events (event_id, processed_at) VALUES (?, ?)`,
      eventId, new Date().toISOString()
    );
    return Response.json({ data: { ok: true } });
  }

  private handleAgentRunsList(url: URL): Response {
    const spaceId = url.searchParams.get('spaceId') ?? '';
    const limit = parseInt(url.searchParams.get('limit') ?? '20', 10);
    const cursor = url.searchParams.get('cursor');
    let query = `SELECT * FROM agent_runs WHERE space_id = ?`;
    const params: unknown[] = [spaceId];
    if (cursor) { query += ` AND id < ?`; params.push(cursor); }
    query += ` ORDER BY started_at DESC LIMIT ?`;
    params.push(limit);
    const runs = [...this.sql.exec<Record<string, unknown>>(query, ...params)];
    const nextCursor = runs.length === limit ? (runs[runs.length - 1]?.['id'] as string | undefined) : undefined;
    return Response.json({ data: { runs, nextCursor } });
  }

  private handlePurge(): Response {
    this.sql.exec(`DELETE FROM space_members`);
    this.sql.exec(`DELETE FROM space_credits`);
    this.sql.exec(`DELETE FROM token_usage`);
    this.sql.exec(`DELETE FROM device_tokens`);
    this.sql.exec(`DELETE FROM processed_billing_events`);
    this.sql.exec(`DELETE FROM knowledge_docs`);
    this.sql.exec(`DELETE FROM agent_runs`);
    this.sql.exec(`DELETE FROM spaces`);
    return Response.json({ data: { ok: true } });
  }

  private async handleKnowledgeDocs(request: Request, url: URL, path: string): Promise<Response> {
    const spaceRow = [...this.sql.exec<{ id: string }>('SELECT id FROM spaces LIMIT 1')][0];
    const spaceId = spaceRow?.id ?? '';

    if (request.method === 'GET' && path === '/knowledge/docs') {
      const docs = [...this.sql.exec<Record<string, unknown>>(
        `SELECT * FROM knowledge_docs WHERE space_id = ? ORDER BY created_at DESC`, spaceId
      )];
      return Response.json({ data: { docs } });
    }

    if (request.method === 'POST' && path === '/knowledge/docs/create') {
      const { id, title, projectId, mimeType } = await request.json<{ id: string; title: string; projectId?: string; mimeType?: string }>();
      this.sql.exec(
        `INSERT INTO knowledge_docs (id, space_id, project_id, title, status, created_at) VALUES (?, ?, ?, ?, 'queued', ?)`,
        id, spaceId, projectId ?? null, title, new Date().toISOString()
      );
      return Response.json({ data: { ok: true } });
    }

    if (request.method === 'POST' && path.endsWith('/status')) {
      const { status, chunkCount, errorMessage } = await request.json<{ status: string; chunkCount?: number; errorMessage?: string }>();
      const docId = path.split('/')[3];
      this.sql.exec(
        `UPDATE knowledge_docs SET status = ?, chunk_count = ?, error_message = ? WHERE id = ?`,
        status, chunkCount ?? 0, errorMessage ?? null, docId
      );
      return Response.json({ data: { ok: true } });
    }

    if (request.method === 'GET' && path.includes('/status')) {
      const docId = path.split('/')[3];
      const doc = [...this.sql.exec<{ status: string; error_message: string | null }>(
        `SELECT status, error_message FROM knowledge_docs WHERE id = ?`, docId
      )][0];
      return Response.json({ data: doc ?? null });
    }

    if (request.method === 'DELETE') {
      const docId = path.split('/').pop() ?? '';
      this.sql.exec(`DELETE FROM knowledge_docs WHERE id = ?`, docId);
      return Response.json({ data: { ok: true } });
    }

    return Response.json({ data: { docs: [] } });
  }

  private async handleAgentRunRecord(request: Request): Promise<Response> {
    const run = await request.json<{
      id: string; spaceId: string; userId?: string; agentId?: string; status: string;
      model?: string; threadId?: string; startedAt: string;
    }>();
    this.sql.exec(
      `INSERT OR REPLACE INTO agent_runs (id, space_id, user_id, agent_id, status, model, thread_id, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      run.id, run.spaceId, run.userId ?? null, run.agentId ?? null, run.status, run.model ?? null, run.threadId ?? null, run.startedAt
    );
    return Response.json({ data: { ok: true } });
  }
}
