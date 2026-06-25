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
}
