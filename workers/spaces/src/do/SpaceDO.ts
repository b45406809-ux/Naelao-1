import { DurableObject } from "cloudflare:workers";
import { applyMigrations, queryAll, queryOne, execute } from "@naelao/db";
import type { Migration } from "@naelao/db";
import type { MessageRole } from "@naelao/types";

// ── Schema migrations ────────────────────────────────────────────────────────
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: "initial schema",
    up: `
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=NORMAL;
      PRAGMA cache_size=-32768;

      CREATE TABLE IF NOT EXISTS sessions (
        id          TEXT PRIMARY KEY,
        space_id    TEXT NOT NULL,
        tenant_id   TEXT NOT NULL,
        end_user_id TEXT,
        status      TEXT NOT NULL DEFAULT 'active',
        metadata    TEXT NOT NULL DEFAULT '{}',
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS messages (
        id           TEXT PRIMARY KEY,
        session_id   TEXT NOT NULL REFERENCES sessions(id),
        role         TEXT NOT NULL,
        content      TEXT NOT NULL,
        tool_call_id TEXT,
        tool_name    TEXT,
        token_count  INTEGER,
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS agent_state (
        session_id        TEXT PRIMARY KEY REFERENCES sessions(id),
        current_fsm_state TEXT NOT NULL DEFAULT 'IDLE',
        goal_stack        TEXT NOT NULL DEFAULT '[]',
        context_json      TEXT NOT NULL DEFAULT '{}',
        updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS kb_documents (
        id           TEXT PRIMARY KEY,
        space_id     TEXT NOT NULL,
        title        TEXT NOT NULL,
        source_url   TEXT,
        content_type TEXT NOT NULL DEFAULT 'text',
        status       TEXT NOT NULL DEFAULT 'pending',
        chunk_count  INTEGER NOT NULL DEFAULT 0,
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_space ON sessions(space_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_tenant ON sessions(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
      CREATE INDEX IF NOT EXISTS idx_kb_space ON kb_documents(space_id);
    `,
  },
  {
    version: 2,
    description: "FTS5 for message search",
    up: `
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content,
        content=messages,
        content_rowid=rowid
      );
    `,
  },
  {
    version: 3,
    // G-D01: composite index ensures ORDER BY (session_id, created_at, id) uses an index scan
    description: "composite message ordering index",
    up: `CREATE INDEX IF NOT EXISTS idx_messages_session_time ON messages(session_id, created_at, id);`,
  },
  {
    version: 4,
    // G-AO30/G-AO31: index for per-user GDPR export and erasure queries
    description: "end_user_id index on sessions for GDPR",
    up: `CREATE INDEX IF NOT EXISTS idx_sessions_end_user ON sessions(end_user_id);`,
  },
  {
    version: 5,
    // G-AO17: track injection attempts per user for runtime rate-limiting
    description: "injection_attempts table",
    up: `
      CREATE TABLE IF NOT EXISTS injection_attempts (
        id          TEXT PRIMARY KEY,
        space_id    TEXT NOT NULL,
        end_user_id TEXT NOT NULL,
        detected_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_injection_user ON injection_attempts(end_user_id, detected_at);
    `,
  },
  {
    version: 6,
    // G-AX13: per-user token bucket for message rate limiting within a Space
    description: "user_rate_limits token bucket table",
    up: `
      CREATE TABLE IF NOT EXISTS user_rate_limits (
        user_id        TEXT PRIMARY KEY,
        tokens         REAL NOT NULL DEFAULT 10,
        last_refill_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
        capacity       REAL NOT NULL DEFAULT 10,
        rate_per_sec   REAL NOT NULL DEFAULT 0.1667
      );
    `,
  },
  {
    version: 7,
    // SpaceDO owns agent_definitions per spec §11 / CLAUDE.md direction.
    // Each definition is the config for one installed agent (system_prompt, model, skills, triggers).
    description: "agent_definitions table",
    up: `
      CREATE TABLE IF NOT EXISTS agent_definitions (
        id               TEXT PRIMARY KEY,
        space_id         TEXT NOT NULL,
        name             TEXT NOT NULL,
        description      TEXT NOT NULL DEFAULT '',
        config_json      TEXT NOT NULL DEFAULT '{}',
        version          INTEGER NOT NULL DEFAULT 1,
        enabled          INTEGER NOT NULL DEFAULT 1,
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_agent_defs_space ON agent_definitions(space_id);
    `,
  },
  {
    version: 8,
    // threads and space_members: spec-canonical tables (SpaceDO owns threads + members).
    // threads replaces the earlier "sessions" concept in the full spec; both coexist here.
    description: "threads and space_members tables",
    up: `
      CREATE TABLE IF NOT EXISTS threads (
        id         TEXT PRIMARY KEY,
        space_id   TEXT NOT NULL,
        user_id    TEXT,
        project_id TEXT,
        title      TEXT,
        status     TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_threads_space ON threads(space_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_threads_project ON threads(project_id) WHERE project_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS space_members (
        space_id   TEXT NOT NULL,
        user_id    TEXT NOT NULL,
        role       TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','editor','member','viewer')),
        joined_at  TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (space_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_members_user ON space_members(user_id);
    `,
  },
  {
    version: 9,
    // billing credits table — SpaceDO owns per-space credit balance (spec §51 / CLAUDE.md)
    description: "space_credits billing table",
    up: `
      CREATE TABLE IF NOT EXISTS space_credits (
        space_id          TEXT PRIMARY KEY,
        balance_credits   INTEGER NOT NULL DEFAULT 0,
        daily_spent       INTEGER NOT NULL DEFAULT 0,
        daily_limit       INTEGER NOT NULL DEFAULT 0,
        last_reset_date   TEXT NOT NULL DEFAULT (date('now')),
        updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
  {
    version: 10,
    // Space hierarchy registry (spec §10 SpaceDO schema + §49 Sub-Space Architecture,
    // G-Y15/G-Y16). This DO is one product's complete database; the `spaces` table is
    // the product's space registry: the root space (depth 0) plus its in-DO sub-spaces
    // (departments, depth 1-2) for tenancy_mode='team'. Sub-spaces share this SQLite and
    // are isolated by the space_id column already carried on threads/messages — no RLS,
    // because the DO instance boundary is the product boundary.
    //
    // For tenancy_mode='saas' the per-end-user business is its OWN SpaceDO (own SQLite),
    // so it has its OWN `spaces` registry rooted at that business; cross-business isolation
    // is structural. cross_space_grants records explicit cross-sub-space access within a
    // product (e.g. Litigation may read M&A's knowledge) — checkCrossSpacePermission()
    // defaults to DENIED on any error and never silently permits.
    description: "spaces registry + cross_space_grants (hierarchy + tenancy)",
    up: `
      CREATE TABLE IF NOT EXISTS spaces (
        id            TEXT PRIMARY KEY,
        parent_id     TEXT REFERENCES spaces(id),
        name          TEXT NOT NULL,
        space_type    TEXT NOT NULL,
        tenancy_mode  TEXT NOT NULL DEFAULT 'team'
                        CHECK (tenancy_mode IN ('single','team','saas')),
        agency_shell  INTEGER NOT NULL DEFAULT 0,
        depth         INTEGER NOT NULL DEFAULT 0 CHECK (depth <= 2),
        scenario_type TEXT,
        status        TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','suspended','deleted')),
        settings      TEXT NOT NULL DEFAULT '{}',
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_spaces_parent ON spaces(parent_id);

      CREATE TABLE IF NOT EXISTS cross_space_grants (
        id                 TEXT PRIMARY KEY,
        granting_space_id  TEXT NOT NULL,
        receiving_space_id TEXT NOT NULL,
        grant_type         TEXT NOT NULL
                             CHECK (grant_type IN ('read-knowledge','read-threads','full-access')),
        granted_by         TEXT NOT NULL,
        granted_at         TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at         TEXT,
        revoked_at         TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_csg_receiving ON cross_space_grants(receiving_space_id);
      CREATE INDEX IF NOT EXISTS idx_csg_granting ON cross_space_grants(granting_space_id);
    `,
  },
  {
    version: 11,
    // Projects — "a project is a grouping of threads within a space" (CLAUDE.md). Threads
    // already carry project_id; this is the registry the bootstrap/onboarding creates on first
    // run (e.g. Whop-seller → Members / Support / Content). Not a sub-space (own DO/structure) —
    // just a labelled grouping inside this space's DO.
    description: "projects registry (thread grouping)",
    up: `
      CREATE TABLE IF NOT EXISTS projects (
        id          TEXT PRIMARY KEY,
        space_id    TEXT NOT NULL,
        name        TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_projects_space ON projects(space_id, created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_space_name ON projects(space_id, name);
    `,
  },
];

export interface SpaceDOEnv {
  PLATFORM_SECRET: string;
}

// Row types for internal use
interface SessionRow {
  id: string;
  space_id: string;
  tenant_id: string;
  end_user_id: string | null;
  status: string;
  metadata: string;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  tool_call_id: string | null;
  tool_name: string | null;
  token_count: number | null;
  created_at: string;
}

interface AgentStateRow {
  session_id: string;
  current_fsm_state: string;
  goal_stack: string;
  context_json: string;
}

interface SpaceRow {
  id: string;
  parent_id: string | null;
  name: string;
  space_type: string;
  tenancy_mode: string;
  agency_shell: number;
  depth: number;
  scenario_type: string | null;
  status: string;
  settings: string;
  created_at: string;
}

interface CrossSpaceGrantRow {
  id: string;
  granting_space_id: string;
  receiving_space_id: string;
  grant_type: string;
  granted_by: string;
  granted_at: string;
  expires_at: string | null;
  revoked_at: string | null;
}

// ── G-F03: Negative auth result cache ────────────────────────────────────────
// Key: deny:{userId}:{spaceId} → expiry timestamp ms
// In-memory only; intentionally lost on DO hibernation (acceptable for 30s TTL).
const DENY_CACHE_TTL_MS = 30_000;

// ── SpaceDO ──────────────────────────────────────────────────────────────────
export class SpaceDO extends DurableObject<SpaceDOEnv> {
  private initialized = false;
  // G-F03: Negative auth cache — maps deny:{userId}:{spaceId} to expiry timestamp
  private readonly denyCache = new Map<string, number>();

  private isDenied(userId: string, spaceId: string): boolean {
    const key = `deny:${userId}:${spaceId}`;
    const expiry = this.denyCache.get(key);
    if (expiry === undefined) return false;
    if (Date.now() > expiry) {
      this.denyCache.delete(key);
      return false;
    }
    return true;
  }

  private cacheDeny(userId: string, spaceId: string): void {
    this.denyCache.set(`deny:${userId}:${spaceId}`, Date.now() + DENY_CACHE_TTL_MS);
  }

  private invalidateUserCache(userId: string, spaceId: string): void {
    this.denyCache.delete(`deny:${userId}:${spaceId}`);
  }

  private ensureInit(): void {
    if (this.initialized) return;
    applyMigrations(this.ctx.storage.sql as never, MIGRATIONS);
    this.initialized = true;
  }

  override async fetch(request: Request): Promise<Response> {
    this.ensureInit();
    const url = new URL(request.url);
    const method = request.method;

    try {
      // POST /sessions
      if (method === "POST" && url.pathname === "/sessions") {
        return this.createSession(request);
      }
      // GET /sessions/:id
      const sessionMatch = url.pathname.match(/^\/sessions\/([^/]+)$/);
      if (method === "GET" && sessionMatch?.[1]) {
        return this.getSession(sessionMatch[1]);
      }
      // POST /sessions/:id/messages
      const msgMatch = url.pathname.match(/^\/sessions\/([^/]+)\/messages$/);
      if (method === "POST" && msgMatch?.[1]) {
        return this.appendMessage(request, msgMatch[1]);
      }
      // GET /sessions/:id/messages
      if (method === "GET" && msgMatch?.[1]) {
        return this.getMessages(msgMatch[1], url.searchParams);
      }
      // PATCH /sessions/:id — update status
      if (method === "PATCH" && sessionMatch?.[1]) {
        return this.updateSession(request, sessionMatch[1]);
      }
      // GET /sessions/:id/state — agent state
      const stateMatch = url.pathname.match(/^\/sessions\/([^/]+)\/state$/);
      if (method === "GET" && stateMatch?.[1]) {
        return this.getAgentState(stateMatch[1]);
      }
      if (method === "PUT" && stateMatch?.[1]) {
        return this.putAgentState(request, stateMatch[1]);
      }

      // POST /invalidate-user — G-F03: clear deny-cache entries for a user+space pair
      if (method === "POST" && url.pathname === "/invalidate-user") {
        return this.handleInvalidateUser(request);
      }

      // GET /me/messages?user_id=xxx — G-AO30: fetch all messages for GDPR export
      if (method === "GET" && url.pathname === "/me/messages") {
        return this.getUserMessages(url.searchParams);
      }

      // DELETE /me/data?user_id=xxx — G-AO31: erase all user data within space
      if (method === "DELETE" && url.pathname === "/me/data") {
        return this.eraseUserData(url.searchParams);
      }

      // POST /me/injection — G-AO17: record an injection attempt, return rate-limited status
      if (method === "POST" && url.pathname === "/me/injection") {
        return this.recordInjectionAttempt(request);
      }

      // ── agent_definitions endpoints ───────────────────────────────────────────
      // GET /agent-definitions?space_id=
      if (method === "GET" && url.pathname === "/agent-definitions") {
        return this.listAgentDefinitions(url.searchParams);
      }
      // POST /agent-definitions
      if (method === "POST" && url.pathname === "/agent-definitions") {
        return this.createAgentDefinition(request);
      }
      // GET /agent-definitions/:id
      const agentDefGetMatch = url.pathname.match(/^\/agent-definitions\/([^/]+)$/);
      if (method === "GET" && agentDefGetMatch?.[1]) {
        return this.getAgentDefinition(agentDefGetMatch[1]);
      }
      // PATCH /agent-definitions/:id
      if (method === "PATCH" && agentDefGetMatch?.[1]) {
        return this.updateAgentDefinition(agentDefGetMatch[1], request);
      }
      // DELETE /agent-definitions/:id
      if (method === "DELETE" && agentDefGetMatch?.[1]) {
        return this.deleteAgentDefinition(agentDefGetMatch[1]);
      }

      // ── space_members endpoints ───────────────────────────────────────────────
      // GET /members?space_id=
      if (method === "GET" && url.pathname === "/members") {
        return this.listMembers(url.searchParams);
      }
      // POST /members
      if (method === "POST" && url.pathname === "/members") {
        return this.addMember(request);
      }
      // DELETE /members/:userId
      const memberMatch = url.pathname.match(/^\/members\/([^/]+)$/);
      if (method === "DELETE" && memberMatch?.[1]) {
        return this.removeMember(memberMatch[1]);
      }

      // ── space registry / hierarchy endpoints ──────────────────────────────────
      // POST /spaces — register the root space row (idempotent; provisioner calls this)
      if (method === "POST" && url.pathname === "/spaces") {
        return this.upsertRootSpace(request);
      }
      // GET /spaces — list all spaces in this product registry (root + sub-spaces)
      if (method === "GET" && url.pathname === "/spaces") {
        return this.listSpaceRows();
      }
      // POST /sub-spaces — create an in-DO sub-space (department) under a parent
      if (method === "POST" && url.pathname === "/sub-spaces") {
        return this.createSubSpaceRow(request);
      }
      // GET /spaces/:id — fetch a single space row (meta)
      const spaceRowMatch = url.pathname.match(/^\/spaces\/([^/]+)$/);
      if (method === "GET" && spaceRowMatch?.[1]) {
        return this.getSpaceRow(spaceRowMatch[1]);
      }
      // PATCH /spaces/:id — update status / settings (suspend a department, etc.)
      if (method === "PATCH" && spaceRowMatch?.[1]) {
        return this.updateSpaceRow(spaceRowMatch[1], request);
      }

      // ── projects (thread grouping) ────────────────────────────────────────────
      // GET /projects?space_id= — list projects
      if (method === "GET" && url.pathname === "/projects") {
        return this.listProjects(url.searchParams);
      }
      // POST /projects — create a project (idempotent on (space_id, name))
      if (method === "POST" && url.pathname === "/projects") {
        return this.createProject(request);
      }

      // ── cross-space access grants (spec §49 checkPermission path) ─────────────
      // POST /cross-space-grants
      if (method === "POST" && url.pathname === "/cross-space-grants") {
        return this.grantCrossSpace(request);
      }
      // GET /cross-space-grants?space_id= — grants visible to a space
      if (method === "GET" && url.pathname === "/cross-space-grants") {
        return this.listCrossSpaceGrants(url.searchParams);
      }
      // DELETE /cross-space-grants/:id
      const grantMatch = url.pathname.match(/^\/cross-space-grants\/([^/]+)$/);
      if (method === "DELETE" && grantMatch?.[1]) {
        return this.revokeCrossSpace(grantMatch[1]);
      }
      // GET /cross-space-check?user_id=&requesting_space_id=&target_space_id=&grant_type=
      if (method === "GET" && url.pathname === "/cross-space-check") {
        return this.checkCrossSpace(url.searchParams);
      }

      return Response.json(
        { error_code: "not_found", message: "Unknown DO route" },
        { status: 404 }
      );
    } catch (err) {
      console.error("SpaceDO error:", err);
      return Response.json(
        { error_code: "internal_error", message: String(err) },
        { status: 500 }
      );
    }
  }

  private async createSession(request: Request): Promise<Response> {
    const body = await request.json<{
      space_id: string;
      tenant_id: string;
      end_user_id?: string;
      metadata?: Record<string, unknown>;
    }>();

    // G-F03: Fast-path deny for recently banned/blocked users before touching SQLite
    if (body.end_user_id && this.isDenied(body.end_user_id, body.space_id)) {
      return Response.json(
        { error_code: "forbidden", message: "Access denied" },
        { status: 403 }
      );
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    execute(
      this.ctx.storage.sql as never,
      `INSERT INTO sessions (id, space_id, tenant_id, end_user_id, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      body.space_id,
      body.tenant_id,
      body.end_user_id ?? null,
      JSON.stringify(body.metadata ?? {}),
      now,
      now
    );

    execute(
      this.ctx.storage.sql as never,
      `INSERT INTO agent_state (session_id, current_fsm_state, goal_stack, context_json, updated_at)
       VALUES (?, 'IDLE', '[]', '{}', ?)`,
      id,
      now
    );

    return Response.json(
      { id, space_id: body.space_id, status: "active", created_at: now },
      { status: 201 }
    );
  }

  private getSession(sessionId: string): Response {
    const session = queryOne<SessionRow>(
      this.ctx.storage.sql as never,
      "SELECT * FROM sessions WHERE id = ?",
      sessionId
    );
    if (!session) {
      return Response.json(
        { error_code: "not_found", message: "Session not found" },
        { status: 404 }
      );
    }
    return Response.json(session);
  }

  // G-D02: 128 KB hard cap on message content to prevent OOM in DO SQLite
  private static readonly MAX_MESSAGE_CONTENT_BYTES = 131_072;

  // G-AX13: Token bucket rate limit check for a given end_user_id (10 msg/min default)
  private checkUserRateLimit(userId: string): { allowed: boolean; retryAfterMs: number } {
    const MSG_PER_MIN = 10;
    const capacity = MSG_PER_MIN;
    const ratePerSec = MSG_PER_MIN / 60;
    const nowMs = Date.now();

    interface RateLimitRow {
      tokens: number;
      last_refill_at: number;
      capacity: number;
      rate_per_sec: number;
    }

    const rows = queryAll<RateLimitRow>(
      this.ctx.storage.sql as never,
      "SELECT tokens, last_refill_at, capacity, rate_per_sec FROM user_rate_limits WHERE user_id = ?",
      userId
    );
    const row = rows[0];

    const currentTokens = row?.tokens ?? capacity;
    const lastRefill = row?.last_refill_at ?? nowMs;
    const elapsedSec = Math.max(0, (nowMs - lastRefill) / 1000);
    const refilled = Math.min(capacity, currentTokens + elapsedSec * ratePerSec);

    if (refilled < 1) {
      execute(
        this.ctx.storage.sql as never,
        `INSERT OR REPLACE INTO user_rate_limits (user_id, tokens, last_refill_at, capacity, rate_per_sec)
         VALUES (?, ?, ?, ?, ?)`,
        userId, refilled, nowMs, capacity, ratePerSec
      );
      return { allowed: false, retryAfterMs: Math.ceil((1 - refilled) / ratePerSec * 1000) };
    }

    execute(
      this.ctx.storage.sql as never,
      `INSERT OR REPLACE INTO user_rate_limits (user_id, tokens, last_refill_at, capacity, rate_per_sec)
       VALUES (?, ?, ?, ?, ?)`,
      userId, refilled - 1, nowMs, capacity, ratePerSec
    );
    return { allowed: true, retryAfterMs: 0 };
  }

  private async appendMessage(request: Request, sessionId: string): Promise<Response> {
    const body = await request.json<{
      role: MessageRole;
      content: string;
      tool_call_id?: string;
      tool_name?: string;
      token_count?: number;
      end_user_id?: string;
    }>();

    // G-D02: Reject oversized messages before writing to SQLite
    const contentBytes = new TextEncoder().encode(body.content ?? "").length;
    if (contentBytes > SpaceDO.MAX_MESSAGE_CONTENT_BYTES) {
      return Response.json(
        { error_code: "payload_too_large", message: `Message content exceeds ${SpaceDO.MAX_MESSAGE_CONTENT_BYTES} byte limit` },
        { status: 413 }
      );
    }

    // G-AX13: Per-user rate limiting — only for end-user "user" role messages
    if (body.role === "user" && body.end_user_id) {
      const rl = this.checkUserRateLimit(body.end_user_id);
      if (!rl.allowed) {
        return Response.json(
          { error_code: "rate_limited", message: "Too many messages — please slow down", retry_after_ms: rl.retryAfterMs },
          { status: 429 }
        );
      }
    }

    const session = queryOne<{ id: string }>(
      this.ctx.storage.sql as never,
      "SELECT id FROM sessions WHERE id = ?",
      sessionId
    );
    if (!session) {
      return Response.json(
        { error_code: "not_found", message: "Session not found" },
        { status: 404 }
      );
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    execute(
      this.ctx.storage.sql as never,
      `INSERT INTO messages (id, session_id, role, content, tool_call_id, tool_name, token_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      sessionId,
      body.role,
      body.content,
      body.tool_call_id ?? null,
      body.tool_name ?? null,
      body.token_count ?? null,
      now
    );

    // Update session updated_at
    execute(
      this.ctx.storage.sql as never,
      "UPDATE sessions SET updated_at = ? WHERE id = ?",
      now,
      sessionId
    );

    return Response.json(
      { id, session_id: sessionId, role: body.role, created_at: now },
      { status: 201 }
    );
  }

  private getMessages(sessionId: string, params: URLSearchParams): Response {
    const limit = Math.min(parseInt(params.get("limit") ?? "50"), 200);
    const before = params.get("before");

    // G-D01: id as tie-breaker ensures stable ordering when messages share a timestamp
    const rows = before
      ? queryAll<MessageRow>(
          this.ctx.storage.sql as never,
          `SELECT * FROM messages WHERE session_id = ? AND created_at < ?
           ORDER BY created_at DESC, id DESC LIMIT ?`,
          sessionId,
          before,
          limit
        )
      : queryAll<MessageRow>(
          this.ctx.storage.sql as never,
          `SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC, id ASC LIMIT ?`,
          sessionId,
          limit
        );

    return Response.json({ data: rows, count: rows.length });
  }

  private async updateSession(request: Request, sessionId: string): Promise<Response> {
    const body = await request.json<{
      status?: string;
      metadata?: Record<string, unknown>;
    }>();
    const now = new Date().toISOString();

    if (body.status) {
      execute(
        this.ctx.storage.sql as never,
        "UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?",
        body.status,
        now,
        sessionId
      );
    }
    if (body.metadata) {
      execute(
        this.ctx.storage.sql as never,
        "UPDATE sessions SET metadata = ?, updated_at = ? WHERE id = ?",
        JSON.stringify(body.metadata),
        now,
        sessionId
      );
    }
    return Response.json({ id: sessionId, updated_at: now });
  }

  private getAgentState(sessionId: string): Response {
    const state = queryOne<AgentStateRow>(
      this.ctx.storage.sql as never,
      "SELECT * FROM agent_state WHERE session_id = ?",
      sessionId
    );
    if (!state) {
      return Response.json(
        { error_code: "not_found", message: "State not found" },
        { status: 404 }
      );
    }
    return Response.json({
      session_id: state.session_id,
      current_fsm_state: state.current_fsm_state,
      goal_stack: JSON.parse(state.goal_stack) as unknown[],
      context: JSON.parse(state.context_json) as unknown,
    });
  }

  private async putAgentState(request: Request, sessionId: string): Promise<Response> {
    const body = await request.json<{
      current_fsm_state?: string;
      goal_stack?: unknown[];
      context?: Record<string, unknown>;
    }>();
    const now = new Date().toISOString();

    execute(
      this.ctx.storage.sql as never,
      `UPDATE agent_state
       SET current_fsm_state = COALESCE(?, current_fsm_state),
           goal_stack = COALESCE(?, goal_stack),
           context_json = COALESCE(?, context_json),
           updated_at = ?
       WHERE session_id = ?`,
      body.current_fsm_state ?? null,
      body.goal_stack ? JSON.stringify(body.goal_stack) : null,
      body.context ? JSON.stringify(body.context) : null,
      now,
      sessionId
    );
    return Response.json({ session_id: sessionId, updated_at: now });
  }

  // G-F03: POST /invalidate-user — clear both positive and negative deny-cache entries
  private async handleInvalidateUser(request: Request): Promise<Response> {
    const body = await request.json<{ user_id: string; space_id: string }>();
    if (!body.user_id || !body.space_id) {
      return Response.json(
        { error_code: "bad_request", message: "user_id and space_id are required" },
        { status: 400 }
      );
    }
    this.invalidateUserCache(body.user_id, body.space_id);
    return Response.json({ invalidated: true });
  }

  // G-F03: Block a user — add to deny cache and optionally mark in SQLite
  denyUser(userId: string, spaceId: string): void {
    this.cacheDeny(userId, spaceId);
  }

  // G-AO30: Return all messages for a given end_user_id across all sessions in this space.
  // Used by the spaces worker to build a GDPR Art. 15 data export package.
  private getUserMessages(params: URLSearchParams): Response {
    const userId = params.get("user_id");
    if (!userId) {
      return Response.json({ error_code: "bad_request", message: "user_id is required" }, { status: 400 });
    }

    const sessions = queryAll<{ id: string }>(
      this.ctx.storage.sql as never,
      "SELECT id FROM sessions WHERE end_user_id = ?",
      userId
    );

    if (sessions.length === 0) {
      return Response.json({ messages: [], sessions: [] });
    }

    const sessionIds = sessions.map((s) => s.id);
    // Fetch all messages across all user sessions; use positional placeholders
    const placeholders = sessionIds.map(() => "?").join(",");
    const messages = queryAll<MessageRow>(
      this.ctx.storage.sql as never,
      `SELECT m.* FROM messages m WHERE m.session_id IN (${placeholders}) ORDER BY m.created_at ASC, m.id ASC`,
      ...sessionIds
    );

    return Response.json({ messages, sessions: sessionIds });
  }

  // G-AO31: Delete all sessions and messages for a given end_user_id within this space.
  // Returns counts of deleted rows for the audit trail.
  private eraseUserData(params: URLSearchParams): Response {
    const userId = params.get("user_id");
    if (!userId) {
      return Response.json({ error_code: "bad_request", message: "user_id is required" }, { status: 400 });
    }

    const sessions = queryAll<{ id: string }>(
      this.ctx.storage.sql as never,
      "SELECT id FROM sessions WHERE end_user_id = ?",
      userId
    );

    let messagesDeleted = 0;
    let sessionsDeleted = 0;

    for (const session of sessions) {
      // Delete messages first (FK constraint)
      execute(
        this.ctx.storage.sql as never,
        "DELETE FROM messages WHERE session_id = ?",
        session.id
      );
      messagesDeleted++;

      execute(
        this.ctx.storage.sql as never,
        "DELETE FROM agent_state WHERE session_id = ?",
        session.id
      );
      execute(
        this.ctx.storage.sql as never,
        "DELETE FROM sessions WHERE id = ?",
        session.id
      );
      sessionsDeleted++;
    }

    // Also remove injection attempt records for this user
    execute(
      this.ctx.storage.sql as never,
      "DELETE FROM injection_attempts WHERE end_user_id = ?",
      userId
    );

    const erasedAt = new Date().toISOString();
    console.log(`[gdpr][erasure] user=${userId} sessions=${sessionsDeleted} messages=${messagesDeleted} at=${erasedAt}`);

    return Response.json({ erased: true, sessions_deleted: sessionsDeleted, messages_deleted: messagesDeleted, erased_at: erasedAt });
  }

  // ── agent_definitions methods ────────────────────────────────────────────────

  private listAgentDefinitions(params: URLSearchParams): Response {
    const spaceId = params.get("space_id");
    interface AgentDefRow {
      id: string; space_id: string; name: string; description: string;
      config_json: string; version: number; enabled: number; created_at: string; updated_at: string;
    }
    const rows = spaceId
      ? queryAll<AgentDefRow>(
          this.ctx.storage.sql as never,
          "SELECT * FROM agent_definitions WHERE space_id = ? ORDER BY created_at ASC",
          spaceId
        )
      : queryAll<AgentDefRow>(
          this.ctx.storage.sql as never,
          "SELECT * FROM agent_definitions ORDER BY created_at ASC"
        );
    return Response.json({ data: rows.map(r => ({ ...r, config: JSON.parse(r.config_json) as unknown })) });
  }

  private async createAgentDefinition(request: Request): Promise<Response> {
    const body = await request.json<{
      id?: string;
      space_id: string;
      name: string;
      description?: string;
      config: Record<string, unknown>;
    }>();
    if (!body.space_id || !body.name || !body.config) {
      return Response.json(
        { error_code: "bad_request", message: "space_id, name, and config are required" },
        { status: 400 }
      );
    }
    const id = body.id ?? crypto.randomUUID();
    const now = new Date().toISOString();
    execute(
      this.ctx.storage.sql as never,
      `INSERT INTO agent_definitions (id, space_id, name, description, config_json, version, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         description = excluded.description,
         config_json = excluded.config_json,
         version = agent_definitions.version + 1,
         updated_at = excluded.updated_at`,
      id,
      body.space_id,
      body.name,
      body.description ?? "",
      JSON.stringify(body.config),
      now,
      now
    );
    return Response.json({ id, space_id: body.space_id, name: body.name, created_at: now }, { status: 201 });
  }

  private getAgentDefinition(id: string): Response {
    interface AgentDefRow {
      id: string; space_id: string; name: string; description: string;
      config_json: string; version: number; enabled: number; created_at: string; updated_at: string;
    }
    const row = queryOne<AgentDefRow>(
      this.ctx.storage.sql as never,
      "SELECT * FROM agent_definitions WHERE id = ?",
      id
    );
    if (!row) {
      return Response.json({ error_code: "not_found", message: "Agent definition not found" }, { status: 404 });
    }
    return Response.json({ ...row, config: JSON.parse(row.config_json) as unknown });
  }

  private async updateAgentDefinition(id: string, request: Request): Promise<Response> {
    const body = await request.json<{
      name?: string;
      description?: string;
      config?: Record<string, unknown>;
      enabled?: boolean;
    }>();
    const now = new Date().toISOString();
    execute(
      this.ctx.storage.sql as never,
      `UPDATE agent_definitions SET
         name        = COALESCE(?, name),
         description = COALESCE(?, description),
         config_json = COALESCE(?, config_json),
         enabled     = COALESCE(?, enabled),
         version     = version + 1,
         updated_at  = ?
       WHERE id = ?`,
      body.name ?? null,
      body.description ?? null,
      body.config ? JSON.stringify(body.config) : null,
      body.enabled !== undefined ? (body.enabled ? 1 : 0) : null,
      now,
      id
    );
    return Response.json({ id, updated_at: now });
  }

  private deleteAgentDefinition(id: string): Response {
    execute(this.ctx.storage.sql as never, "DELETE FROM agent_definitions WHERE id = ?", id);
    return Response.json({ deleted: true, id });
  }

  // ── space_members methods ────────────────────────────────────────────────────

  private listMembers(params: URLSearchParams): Response {
    const spaceId = params.get("space_id");
    interface MemberRow { space_id: string; user_id: string; role: string; joined_at: string; }
    const rows = spaceId
      ? queryAll<MemberRow>(
          this.ctx.storage.sql as never,
          "SELECT * FROM space_members WHERE space_id = ? ORDER BY joined_at ASC",
          spaceId
        )
      : [];
    return Response.json({ data: rows });
  }

  private async addMember(request: Request): Promise<Response> {
    const body = await request.json<{ space_id: string; user_id: string; role?: string }>();
    if (!body.space_id || !body.user_id) {
      return Response.json(
        { error_code: "bad_request", message: "space_id and user_id are required" },
        { status: 400 }
      );
    }
    const now = new Date().toISOString();
    execute(
      this.ctx.storage.sql as never,
      `INSERT INTO space_members (space_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(space_id, user_id) DO UPDATE SET role = excluded.role`,
      body.space_id,
      body.user_id,
      body.role ?? "member",
      now
    );
    return Response.json({ space_id: body.space_id, user_id: body.user_id, role: body.role ?? "member" }, { status: 201 });
  }

  private removeMember(userId: string): Response {
    execute(this.ctx.storage.sql as never, "DELETE FROM space_members WHERE user_id = ?", userId);
    return Response.json({ deleted: true, user_id: userId });
  }

  // ── Projects (thread grouping) ──────────────────────────────────────────────
  private listProjects(params: URLSearchParams): Response {
    const spaceId = params.get("space_id") ?? "";
    const rows = queryAll<{ id: string; space_id: string; name: string; description: string; status: string; created_at: string }>(
      this.ctx.storage.sql as never,
      "SELECT id, space_id, name, description, status, created_at FROM projects WHERE space_id = ? AND status != 'archived' ORDER BY created_at",
      spaceId
    );
    return Response.json({ data: rows, count: rows.length });
  }

  private async createProject(request: Request): Promise<Response> {
    const body = await request.json<{ space_id: string; name: string; description?: string }>();
    if (!body.space_id || !body.name) {
      return Response.json({ error_code: "bad_request", message: "space_id and name are required" }, { status: 400 });
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    // Idempotent on (space_id, name) so re-running bootstrap doesn't duplicate projects.
    execute(
      this.ctx.storage.sql as never,
      `INSERT INTO projects (id, space_id, name, description, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)
       ON CONFLICT(space_id, name) DO NOTHING`,
      id, body.space_id, body.name, body.description ?? "", now
    );
    const row = queryOne<{ id: string; name: string; status: string; created_at: string }>(
      this.ctx.storage.sql as never,
      "SELECT id, name, status, created_at FROM projects WHERE space_id = ? AND name = ?",
      body.space_id, body.name
    );
    return Response.json(row ?? { id, name: body.name, status: "active", created_at: now }, { status: 201 });
  }

  // G-AO17: Record a prompt injection attempt for a user and check if they are now rate-limited.
  // Rate limit: 3 attempts within 1 hour triggers block.
  private async recordInjectionAttempt(request: Request): Promise<Response> {
    const body = await request.json<{ end_user_id: string; space_id: string }>();
    if (!body.end_user_id) {
      return Response.json({ error_code: "bad_request", message: "end_user_id is required" }, { status: 400 });
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    execute(
      this.ctx.storage.sql as never,
      "INSERT INTO injection_attempts (id, space_id, end_user_id, detected_at) VALUES (?, ?, ?, ?)",
      id,
      body.space_id ?? "",
      body.end_user_id,
      now
    );

    // Count attempts within the last 1 hour
    const oneHourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const row = queryOne<{ cnt: number }>(
      this.ctx.storage.sql as never,
      "SELECT COUNT(*) as cnt FROM injection_attempts WHERE end_user_id = ? AND detected_at > ?",
      body.end_user_id,
      oneHourAgo
    );
    const count = row?.cnt ?? 0;
    const rateLimited = count >= 3;

    if (rateLimited) {
      // Cache the deny to fast-path future requests
      this.cacheDeny(body.end_user_id, body.space_id ?? "");
    }

    return Response.json({ recorded: true, attempts_last_hour: count, rate_limited: rateLimited });
  }

  // ── space registry / hierarchy methods (spec §10 SpaceDO + §49) ──────────────

  // POST /spaces — register/refresh the root space row. Idempotent: the provisioner
  // calls this at step N so the SpaceDO knows its own tenancy + agency_shell. depth=0.
  private async upsertRootSpace(request: Request): Promise<Response> {
    const body = await request.json<{
      id: string;
      name: string;
      space_type: string;
      tenancy_mode?: "single" | "team" | "saas";
      agency_shell?: boolean;
      settings?: Record<string, unknown>;
    }>();
    if (!body.id || !body.name || !body.space_type) {
      return Response.json({ error_code: "bad_request", message: "id, name, space_type are required" }, { status: 400 });
    }
    execute(
      this.ctx.storage.sql as never,
      `INSERT INTO spaces (id, parent_id, name, space_type, tenancy_mode, agency_shell, depth, scenario_type, status, settings, created_at)
       VALUES (?, NULL, ?, ?, ?, ?, 0, NULL, 'active', ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         space_type = excluded.space_type,
         tenancy_mode = excluded.tenancy_mode,
         agency_shell = excluded.agency_shell,
         settings = excluded.settings`,
      body.id,
      body.name,
      body.space_type,
      body.tenancy_mode ?? "team",
      body.agency_shell ? 1 : 0,
      JSON.stringify(body.settings ?? {}),
      new Date().toISOString()
    );
    return Response.json({ id: body.id, depth: 0, status: "active" }, { status: 201 });
  }

  private listSpaceRows(): Response {
    const rows = queryAll<SpaceRow>(
      this.ctx.storage.sql as never,
      "SELECT * FROM spaces WHERE status != 'deleted' ORDER BY depth ASC, created_at ASC"
    );
    return Response.json({ data: rows.map(this.serializeSpaceRow) });
  }

  // POST /sub-spaces — create an in-DO sub-space (department) for tenancy_mode='team'.
  // Enforces: parent exists, depth <= 2, mixed space_type only when parent.agency_shell,
  // end-user sessions (forceParentType=true) always inherit the parent's space_type.
  private async createSubSpaceRow(request: Request): Promise<Response> {
    const body = await request.json<{
      id?: string;
      parent_id: string;
      name: string;
      space_type?: string;
      scenario_type?: "organizational" | "agency-child" | "user-workspace";
      force_parent_type?: boolean;
      settings?: Record<string, unknown>;
    }>();
    if (!body.parent_id || !body.name) {
      return Response.json({ error_code: "bad_request", message: "parent_id and name are required" }, { status: 400 });
    }

    const parent = queryOne<SpaceRow>(
      this.ctx.storage.sql as never,
      "SELECT * FROM spaces WHERE id = ? AND status != 'deleted'",
      body.parent_id
    );
    if (!parent) {
      return Response.json({ error_code: "not_found", message: "Parent space not found" }, { status: 404 });
    }

    // Depth: platform reserves depth 3; sub-spaces cannot nest more than 2 levels (§49).
    if (parent.depth >= 2) {
      return Response.json(
        { error_code: "max_depth_exceeded", message: "Sub-spaces cannot be nested more than 2 levels deep." },
        { status: 400 }
      );
    }

    // Mixed-type rule (§49): only an agency_shell parent may host a different space_type.
    // End-user-originated requests can never select a type and never create agency shells.
    let effectiveType: string;
    if (body.force_parent_type) {
      effectiveType = parent.space_type;
    } else if (body.space_type && body.space_type !== parent.space_type) {
      if (!parent.agency_shell) {
        return Response.json({
          error_code: "mixed_space_type_not_permitted",
          message: `Mixed space types are only permitted when the parent space is an agency shell. ` +
                   `Parent ${parent.id} is type '${parent.space_type}'.`,
        }, { status: 400 });
      }
      effectiveType = body.space_type;
    } else {
      effectiveType = parent.space_type;
    }

    const id = body.id ?? crypto.randomUUID();
    const depth = parent.depth + 1;
    const scenario = body.scenario_type ?? (parent.agency_shell ? "agency-child" : "organizational");
    const now = new Date().toISOString();
    execute(
      this.ctx.storage.sql as never,
      `INSERT INTO spaces (id, parent_id, name, space_type, tenancy_mode, agency_shell, depth, scenario_type, status, settings, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, 'active', ?, ?)`,
      id,
      parent.id,
      body.name,
      effectiveType,
      parent.tenancy_mode,
      depth,
      scenario,
      JSON.stringify(body.settings ?? {}),
      now
    );
    return Response.json(
      { id, parent_id: parent.id, name: body.name, space_type: effectiveType, depth, scenario_type: scenario, status: "active", created_at: now },
      { status: 201 }
    );
  }

  private getSpaceRow(id: string): Response {
    const row = queryOne<SpaceRow>(
      this.ctx.storage.sql as never,
      "SELECT * FROM spaces WHERE id = ?",
      id
    );
    if (!row) return Response.json({ error_code: "not_found", message: "Space not found" }, { status: 404 });
    return Response.json(this.serializeSpaceRow(row));
  }

  private async updateSpaceRow(id: string, request: Request): Promise<Response> {
    const body = await request.json<{ status?: string; name?: string; settings?: Record<string, unknown> }>();
    if (body.status && !["active", "suspended", "deleted"].includes(body.status)) {
      return Response.json({ error_code: "bad_request", message: "Invalid status" }, { status: 400 });
    }
    execute(
      this.ctx.storage.sql as never,
      `UPDATE spaces SET
         status   = COALESCE(?, status),
         name     = COALESCE(?, name),
         settings = COALESCE(?, settings)
       WHERE id = ?`,
      body.status ?? null,
      body.name ?? null,
      body.settings ? JSON.stringify(body.settings) : null,
      id
    );
    return Response.json({ id, updated: true });
  }

  private serializeSpaceRow(row: SpaceRow): Record<string, unknown> {
    return {
      ...row,
      agency_shell: row.agency_shell === 1,
      settings: (() => { try { return JSON.parse(row.settings) as unknown; } catch { return {}; } })(),
    };
  }

  // ── cross-space grants (§49 checkPermission — fail closed) ───────────────────

  private async grantCrossSpace(request: Request): Promise<Response> {
    const body = await request.json<{
      granting_space_id: string;
      receiving_space_id: string;
      grant_type: "read-knowledge" | "read-threads" | "full-access";
      granted_by: string;
      expires_at?: string;
    }>();
    if (!body.granting_space_id || !body.receiving_space_id || !body.grant_type || !body.granted_by) {
      return Response.json({ error_code: "bad_request", message: "granting_space_id, receiving_space_id, grant_type, granted_by are required" }, { status: 400 });
    }
    if (body.granting_space_id === body.receiving_space_id) {
      return Response.json({ error_code: "bad_request", message: "Cannot grant a space access to itself" }, { status: 400 });
    }
    const id = crypto.randomUUID();
    execute(
      this.ctx.storage.sql as never,
      `INSERT INTO cross_space_grants (id, granting_space_id, receiving_space_id, grant_type, granted_by, granted_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id, body.granting_space_id, body.receiving_space_id, body.grant_type, body.granted_by, new Date().toISOString(), body.expires_at ?? null
    );
    return Response.json({ id, grant_type: body.grant_type }, { status: 201 });
  }

  private listCrossSpaceGrants(params: URLSearchParams): Response {
    const spaceId = params.get("space_id");
    const rows = spaceId
      ? queryAll<CrossSpaceGrantRow>(
          this.ctx.storage.sql as never,
          `SELECT * FROM cross_space_grants
           WHERE (granting_space_id = ? OR receiving_space_id = ?) AND revoked_at IS NULL
           ORDER BY granted_at DESC`,
          spaceId, spaceId
        )
      : queryAll<CrossSpaceGrantRow>(
          this.ctx.storage.sql as never,
          "SELECT * FROM cross_space_grants WHERE revoked_at IS NULL ORDER BY granted_at DESC"
        );
    return Response.json({ data: rows });
  }

  private revokeCrossSpace(id: string): Response {
    execute(
      this.ctx.storage.sql as never,
      "UPDATE cross_space_grants SET revoked_at = ? WHERE id = ?",
      new Date().toISOString(), id
    );
    return Response.json({ revoked: true, id });
  }

  // GET /cross-space-check — THE CRITICAL PATH (§49). Default DENIED on any error.
  // A user gets access if they are a direct member of the target space, OR a valid
  // (unexpired, unrevoked) grant exists from the requesting space to the target.
  private checkCrossSpace(params: URLSearchParams): Response {
    const userId = params.get("user_id") ?? "";
    const requestingSpaceId = params.get("requesting_space_id") ?? "";
    const targetSpaceId = params.get("target_space_id") ?? "";
    const grantType = params.get("grant_type") ?? "read-knowledge";

    try {
      if (!userId || !targetSpaceId) {
        return Response.json({ permitted: false, reason: "user_id and target_space_id are required", grant_type: null }, { status: 400 });
      }

      // Direct membership of the target space → permitted.
      const member = queryOne<{ role: string }>(
        this.ctx.storage.sql as never,
        "SELECT role FROM space_members WHERE space_id = ? AND user_id = ?",
        targetSpaceId, userId
      );
      if (member) {
        return Response.json({ permitted: true, reason: `Direct member with role '${member.role}'.`, grant_type: null });
      }

      // Valid cross-space grant from requesting → target.
      const now = new Date().toISOString();
      const grant = queryOne<{ id: string; grant_type: string }>(
        this.ctx.storage.sql as never,
        `SELECT id, grant_type FROM cross_space_grants
         WHERE granting_space_id = ? AND receiving_space_id = ?
           AND (grant_type = ? OR grant_type = 'full-access')
           AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
         LIMIT 1`,
        targetSpaceId, requestingSpaceId, grantType, now
      );
      if (!grant) {
        return Response.json({
          permitted: false,
          reason: `User ${userId} is not a member of ${targetSpaceId} and no '${grantType}' grant exists from ${requestingSpaceId}.`,
          grant_type: null,
        });
      }
      return Response.json({ permitted: true, reason: `Cross-space grant '${grant.grant_type}' applies.`, grant_type: grant.grant_type });
    } catch (err) {
      // ANY unexpected error → DENIED. Never permit on error.
      console.error("[SpaceDO] checkCrossSpace UNEXPECTED ERROR — defaulting to DENIED", err);
      return Response.json({ permitted: false, reason: "Permission check failed; access denied as a safety default.", grant_type: null });
    }
  }
}
