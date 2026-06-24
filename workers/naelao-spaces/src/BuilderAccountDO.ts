import { DurableObject } from 'cloudflare:workers';

interface Env {}

type BuilderPlan = 'free' | 'starter' | 'pro' | 'team' | 'enterprise';

const PLAN_FEATURES: Record<BuilderPlan, string[]> = {
  free: ['basic_agents', 'community_support'],
  starter: ['basic_agents', 'email_support', 'custom_tools'],
  pro: ['basic_agents', 'priority_support', 'custom_tools', 'analytics'],
  team: ['unlimited_agents', 'priority_support', 'custom_tools', 'analytics', 'team_management'],
  enterprise: ['unlimited_agents', 'dedicated_support', 'custom_tools', 'analytics', 'team_management', 'sso', 'audit_logs'],
};

const PLAN_RATE_LIMITS: Record<BuilderPlan, number> = {
  free: 60,
  starter: 120,
  pro: 300,
  team: 600,
  enterprise: 1000,
};

export class BuilderAccountDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.sql = state.storage.sql;
    state.blockConcurrencyWhile(() => this.initSchema());
  }

  private initSchema(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY DEFAULT 0)`);
    this.sql.exec(`INSERT OR IGNORE INTO schema_version VALUES (0)`);

    this.sql.exec(`CREATE TABLE IF NOT EXISTS builders (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      plan TEXT NOT NULL DEFAULT 'free',
      credit_cents INTEGER NOT NULL DEFAULT 0,
      api_key_hash TEXT,
      rate_limit_rpm INTEGER NOT NULL DEFAULT 60,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now')),
      trial_ends_at TEXT,
      stripe_customer_id TEXT,
      lemon_squeezy_customer_id TEXT,
      billing_provider TEXT DEFAULT 'lemon_squeezy'
    )`);

    this.sql.exec(`CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      builder_id TEXT,
      key_hash TEXT UNIQUE,
      name TEXT,
      created_at TEXT,
      last_used_at TEXT,
      expires_at TEXT
    )`);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/init' && request.method === 'POST') return this.handleInit(request);
      if (url.pathname === '/account' && request.method === 'GET') return this.handleGetAccount();
      if (url.pathname === '/account' && request.method === 'PATCH') return this.handleUpdateAccount(request);
      if (url.pathname === '/plan' && request.method === 'GET') return this.handleGetPlan();
      if (url.pathname === '/api-keys/create' && request.method === 'POST') return this.handleCreateApiKey(request);
      if (url.pathname === '/api-keys' && request.method === 'GET') return this.handleListApiKeys();
      if (url.pathname.startsWith('/api-keys/') && request.method === 'DELETE') return this.handleDeleteApiKey(url);
      if (url.pathname === '/verify-api-key' && request.method === 'POST') return this.handleVerifyApiKey(request);
      return Response.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, { status: 404 });
    } catch (e) {
      return Response.json({ error: { code: 'INTERNAL_ERROR', message: String(e) } }, { status: 500 });
    }
  }

  private async handleInit(request: Request): Promise<Response> {
    const { id, email, name } = await request.json<{ id: string; email: string; name: string }>();
    this.sql.exec(
      `INSERT OR IGNORE INTO builders (id, email, name, plan, status) VALUES (?, ?, ?, 'free', 'active')`,
      id, email, name
    );
    return Response.json({ data: { ok: true } });
  }

  private handleGetAccount(): Response {
    const row = [...this.sql.exec<Record<string, unknown>>(`SELECT * FROM builders LIMIT 1`)][0];
    if (!row) return Response.json({ error: { code: 'NOT_FOUND', message: 'Account not found' } }, { status: 404 });
    return Response.json({ data: row });
  }

  private async handleUpdateAccount(request: Request): Promise<Response> {
    const update = await request.json<{ name?: string; plan?: string; status?: string }>();
    if (update.name) this.sql.exec(`UPDATE builders SET name = ? LIMIT 1`, update.name);
    if (update.plan) this.sql.exec(`UPDATE builders SET plan = ? LIMIT 1`, update.plan);
    if (update.status) this.sql.exec(`UPDATE builders SET status = ? LIMIT 1`, update.status);
    const updated = [...this.sql.exec<Record<string, unknown>>(`SELECT * FROM builders LIMIT 1`)][0];
    return Response.json({ data: updated });
  }

  private handleGetPlan(): Response {
    const row = [...this.sql.exec<{ plan: BuilderPlan; rate_limit_rpm: number }>(
      `SELECT plan, rate_limit_rpm FROM builders LIMIT 1`
    )][0];
    if (!row) return Response.json({ error: { code: 'NOT_FOUND', message: 'Account not found' } }, { status: 404 });
    const plan = row.plan;
    const isEnterprise = plan === 'enterprise' || plan === 'team';
    return Response.json({
      data: {
        plan,
        rateLimitRpm: PLAN_RATE_LIMITS[plan] ?? 60,
        isEnterprise,
        features: PLAN_FEATURES[plan] ?? [],
      }
    });
  }

  private async handleCreateApiKey(request: Request): Promise<Response> {
    const { name } = await request.json<{ name: string }>();
    const builder = [...this.sql.exec<{ id: string }>(`SELECT id FROM builders LIMIT 1`)][0];
    if (!builder) return Response.json({ error: { code: 'NOT_FOUND', message: 'Account not found' } }, { status: 404 });

    const keyId = crypto.randomUUID();
    const rawKey = 'nk_' + crypto.randomUUID().replace(/-/g, '');

    const keyHashBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawKey));
    const keyHash = [...new Uint8Array(keyHashBytes)].map(b => b.toString(16).padStart(2, '0')).join('');

    const now = new Date().toISOString();
    this.sql.exec(
      `INSERT INTO api_keys (id, builder_id, key_hash, name, created_at) VALUES (?, ?, ?, ?, ?)`,
      keyId, builder.id, keyHash, name, now
    );

    return Response.json({ data: { key: rawKey, id: keyId } });
  }

  private handleListApiKeys(): Response {
    const keys = [...this.sql.exec<{ id: string; name: string; created_at: string; last_used_at: string | null }>(
      `SELECT id, name, created_at, last_used_at FROM api_keys`
    )];
    return Response.json({ data: { keys } });
  }

  private handleDeleteApiKey(url: URL): Response {
    const id = url.pathname.split('/').pop() ?? '';
    this.sql.exec(`DELETE FROM api_keys WHERE id = ?`, id);
    return Response.json({ data: { ok: true } });
  }

  private async handleVerifyApiKey(request: Request): Promise<Response> {
    const { keyHash } = await request.json<{ keyHash: string }>();
    const key = [...this.sql.exec<{ builder_id: string }>(
      `SELECT builder_id FROM api_keys WHERE key_hash = ?`, keyHash
    )][0];

    if (!key) return Response.json({ data: { valid: false } });

    this.sql.exec(`UPDATE api_keys SET last_used_at = ? WHERE key_hash = ?`, new Date().toISOString(), keyHash);

    return Response.json({ data: { valid: true, builderId: key.builder_id } });
  }
}
