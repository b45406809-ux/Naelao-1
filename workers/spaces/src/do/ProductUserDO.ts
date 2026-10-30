// Three-Tier Platform Model (spec "Three-Tier Platform Model" / Journey 1B), Phase 2
// (docs/spec-appendix/A1-script-agents-and-space-assistants.md §A1.17). ONE INSTANCE PER
// (productId, endUserId) — addressed getDOName("produser", `${productId}:${endUserId}`, tenantId,
// PLATFORM_SECRET). This stores product-scoped login sessions, preferences, and conversation
// references for people using a published Space Template. A Product end user is fully isolated
// even across products — the same human logging
// into two different builders' products gets two independent ProductUserDO instances (spec: end
// users' data is never shared across products, and never with Naelao's own platform users).
//
// AUTH MODEL (the open design decision the plan flagged, resolved here — do not re-infer):
// end users authenticate through the PRODUCT'S configured auth_provider (naelao-native / Clerk /
// custom-OIDC / SAML), which yields a stable end_user_id; this DO then mints a PRODUCT-SCOPED
// session token stored (hashed) in session_state. That token is validated against THIS DO, never
// against the platform-wide builder JWT. Builder-side actors (owners/admins/Team collaborators)
// keep using the existing JWT + space_members path — they are a structurally different population
// (same reasoning as CLAUDE.md #23's Bucket A/B split). This directly closes the currently-broken
// end-user chat-auth gap CLAUDE.md #23 flagged (widget/portal attach no credential today).
//
// The DO is intentionally auth-provider-agnostic: it never sees Clerk/OIDC/SAML secrets. The
// caller (Phase 3 router/portal wrapper) verifies the provider assertion, derives end_user_id,
// then asks this DO to open a session. Provider secrets live in the credentials vault.
//
import { DurableObject } from "cloudflare:workers";
import { readBoundedRequestBytes, RequestBodyTooLargeError } from "@naelao/http";
import { applyMigrations, type Migration } from "@naelao/db";

interface SessionRow {
  session_id: string;
  token_hash: string;
  auth_provider: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
}

const SESSION_TTL_MS = 30 * 86_400_000; // 30 days, refreshed on each verify
const MAX_ACTIVE_SESSIONS = 100;
const MAX_CONVERSATION_REFS = 10_000;
const MAX_PREFERENCES = 500;
const MAX_PENDING_NOTIFICATIONS = 1_000;

function validOptionalText(value: unknown, maxLength: number): value is string | undefined {
  return value === undefined || (typeof value === "string" && value.length > 0 && value.length <= maxLength);
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: "initial schema",
    // Do NOT run PRAGMA journal_mode here — Cloudflare's SQLite-backed DO storage manages its
    // own journal mode and rejects this PRAGMA with "not authorized: SQLITE_AUTH" (confirmed via
    // a live wrangler tail session against a real deployment; see SpaceDO.ts's identical fix).
    up: `
      CREATE TABLE IF NOT EXISTS session_state (
        session_id     TEXT PRIMARY KEY,
        token_hash     TEXT NOT NULL,
        auth_provider  TEXT NOT NULL DEFAULT 'naelao-native',
        created_at     TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at     TEXT NOT NULL,
        revoked_at     TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_session_token ON session_state(token_hash);

      -- Retained only as a historical schema step; migration 6 removes this retired table.
      CREATE TABLE IF NOT EXISTS credit_ledger (
        id             TEXT PRIMARY KEY,
        delta_credits  INTEGER NOT NULL,
        reason         TEXT NOT NULL,
        model          TEXT,
        balance_after  INTEGER NOT NULL,
        created_at     TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS conversation_refs (
        thread_id      TEXT NOT NULL,
        space_id       TEXT NOT NULL,
        session_id     TEXT,
        title          TEXT,
        created_at     TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (space_id, thread_id)
      );

      CREATE TABLE IF NOT EXISTS preferences (
        key            TEXT PRIMARY KEY,
        value          TEXT NOT NULL,
        updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS notification_queue (
        id             TEXT PRIMARY KEY,
        payload        TEXT NOT NULL,
        status         TEXT NOT NULL DEFAULT 'pending',
        created_at     TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
  {
    // Historical schema version retained so deployed Durable Objects can advance in order.
    version: 2,
    description: "historical stored-value ledger schema",
    up: `
      ALTER TABLE credit_ledger ADD COLUMN idempotency_key TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_ledger_idempotency
        ON credit_ledger(idempotency_key) WHERE idempotency_key IS NOT NULL;
    `,
  },
  {
    // Historical schema version retained so deployed Durable Objects can advance in order.
    version: 3,
    description: "historical personal entitlement schema",
    up: `
      CREATE TABLE IF NOT EXISTS plan_state (
        id         INTEGER PRIMARY KEY CHECK (id = 1),
        plan_tier  TEXT NOT NULL DEFAULT 'free',
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
  {
    version: 4,
    description: "add personal inference credit reservations",
    up: `
      CREATE TABLE credit_reservations (
        reservation_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, credits INTEGER NOT NULL CHECK (credits > 0),
        status TEXT NOT NULL CHECK (status IN ('held','settled','released','expired')),
        expires_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_credit_reservations_live ON credit_reservations(status,expires_at);
      CREATE TABLE credit_run_settlements (
        run_id TEXT PRIMARY KEY, actual_credits INTEGER NOT NULL CHECK (actual_credits >= 0), settled_at TEXT NOT NULL
      );
    `,
  },
  {
    // Historical schema version retained so deployed Durable Objects can advance in order.
    version: 5,
    description: "historical personal entitlement records",
    up: `
      CREATE TABLE personal_plan_entitlements (
        provider_event_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        subscription_id TEXT,
        plan_tier TEXT NOT NULL CHECK (plan_tier IN ('free','plus')),
        amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
        starts_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active','refunded','expired')),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_personal_plan_live ON personal_plan_entitlements(status, expires_at);
      CREATE INDEX idx_personal_plan_subscription ON personal_plan_entitlements(subscription_id, status);
    `,
  },
  {
    version: 6,
    description: "remove retired product-user stored-value wallet",
    up: `DROP TABLE IF EXISTS credit_reservations;
      DROP TABLE IF EXISTS credit_run_settlements;
      DROP TABLE IF EXISTS credit_ledger;`,
  },
  {
    version: 7,
    description: "remove retired personal business-plan entitlements",
    up: `DROP TABLE IF EXISTS personal_plan_entitlements;
      DROP TABLE IF EXISTS plan_state;`,
  },
];


export class ProductUserDO extends DurableObject {
  private initialized = false;

  private ensureInit(): void {
    if (this.initialized) return;
    applyMigrations(this.ctx.storage as never, MIGRATIONS);
    this.initialized = true;
  }



  override async fetch(request: Request): Promise<Response> {
    if (request.body && request.method !== "GET" && request.method !== "HEAD") {
      try { request = new Request(request, { body: await readBoundedRequestBytes(request, 1024 * 1024) }); }
      catch (error) {
        if (error instanceof RequestBodyTooLargeError) return Response.json({ error_code: "request_body_too_large" }, { status: 413 });
        return Response.json({ error_code: "invalid_request_body" }, { status: 400 });
      }
    }
    this.ensureInit();
    const url = new URL(request.url);
    const method = request.method;

    // ── Sessions ──────────────────────────────────────────────────────────────
    // POST /sessions — open a product-scoped session. Caller has already verified the end user's
    // identity via the product's auth_provider; this mints an opaque token, stores only its hash.
    if (method === "POST" && url.pathname === "/sessions") {
      const body = await request.json<{ auth_provider?: string }>().catch(() => null);
      if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ error_code: "session_invalid" }, { status: 400 });
      if (!validOptionalText(body.auth_provider, 64)) return Response.json({ error_code: "session_invalid" }, { status: 400 });
      const now = new Date();
      const sessionId = crypto.randomUUID();
      const rawToken = `nps_${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "")}`;
      const tokenHash = await sha256Hex(rawToken);
      const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
      // Hashing yields to concurrent requests. Keep cleanup, cap check, and insert in one
      // synchronous storage transaction so simultaneous logins cannot exceed the hard limit.
      const created = this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec("DELETE FROM session_state WHERE expires_at <= ? OR revoked_at IS NOT NULL", now.toISOString());
        const active = this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM session_state WHERE expires_at > ? AND revoked_at IS NULL", now.toISOString()).toArray() as Array<{ count: number }>;
        if ((active[0]?.count ?? 0) >= MAX_ACTIVE_SESSIONS) return false;
        this.ctx.storage.sql.exec(
          `INSERT INTO session_state (session_id, token_hash, auth_provider, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?)`,
          sessionId, tokenHash, body.auth_provider ?? "naelao-native", now.toISOString(), expiresAt
        );
        return true;
      });
      if (!created) return Response.json({ error_code: "session_limit_reached" }, { status: 429 });
      // F-48: opportunistically prune long-expired sessions (14+ days past expiry) on the mint
      // path — far rarer than verify, so this bounds the session_state table without adding a
      // cron/alarm. An expired session is already unreachable (verify rejects it); this just keeps
      // the DO's own storage from accumulating dead rows indefinitely.
      const pruneBefore = new Date(now.getTime() - 14 * 86_400_000).toISOString();
      this.ctx.storage.sql.exec("DELETE FROM session_state WHERE expires_at < ?", pruneBefore);
      return Response.json({ session_id: sessionId, session_token: rawToken, expires_at: expiresAt }, { status: 201 });
    }

    // POST /sessions/verify — resolve a session token (sliding-window refresh on success).
    if (method === "POST" && url.pathname === "/sessions/verify") {
      const body = await request.json<{ session_token: string }>().catch(() => ({ session_token: "" }));
      if (typeof body.session_token !== "string" || !body.session_token || body.session_token.length > 256) return Response.json({ valid: false }, { status: 400 });
      const tokenHash = await sha256Hex(body.session_token);
      const rows = this.ctx.storage.sql
        .exec(
          "SELECT session_id, expires_at, revoked_at FROM session_state WHERE token_hash = ?",
          tokenHash
        )
        .toArray() as unknown as { session_id: string; expires_at: string; revoked_at: string | null }[];
      const row = rows[0];
      if (!row || row.revoked_at) return Response.json({ valid: false });
      if (new Date(row.expires_at) <= new Date()) return Response.json({ valid: false });
      // Sliding-window: extend the session on active use.
      const newExpiry = new Date(Date.now() + SESSION_TTL_MS).toISOString();
      this.ctx.storage.sql.exec(
        "UPDATE session_state SET expires_at = ? WHERE session_id = ?",
        newExpiry, row.session_id
      );
      return Response.json({ valid: true, session_id: row.session_id, expires_at: newExpiry });
    }

    // POST /sessions/revoke — sign out (single session, or all when session_id omitted).
    if (method === "POST" && url.pathname === "/sessions/revoke") {
      const body = await request.json<{ session_id?: string }>().catch(() => ({} as { session_id?: string }));
      const now = new Date().toISOString();
      if (body.session_id) {
        this.ctx.storage.sql.exec(
          "UPDATE session_state SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL",
          now, body.session_id
        );
      } else {
        this.ctx.storage.sql.exec("UPDATE session_state SET revoked_at = ? WHERE revoked_at IS NULL", now);
      }
      return new Response(null, { status: 204 });
    }

    // Stored-value balances are retired. Usage is governed by Space subscription quotas.

    // ── Conversation refs (metadata only — the builder's gated conversation access reads these) ──
    if (method === "POST" && url.pathname === "/conversation-refs") {
      const body = await request.json<{ thread_id: string; space_id: string; session_id?: string; title?: string }>().catch(() => null);
      if (!body || typeof body.thread_id !== "string" || !body.thread_id || body.thread_id.length > 256 ||
          typeof body.space_id !== "string" || !body.space_id || body.space_id.length > 256 ||
          !validOptionalText(body.session_id, 256) || !validOptionalText(body.title, 512)) {
        return Response.json({ error: "conversation reference fields are invalid" }, { status: 400 });
      }
      const existing = this.ctx.storage.sql.exec("SELECT 1 AS found FROM conversation_refs WHERE space_id = ? AND thread_id = ?", body.space_id, body.thread_id).toArray();
      const count = this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM conversation_refs").toArray() as Array<{ count: number }>;
      if (!existing.length && (count[0]?.count ?? 0) >= MAX_CONVERSATION_REFS) return Response.json({ error_code: "conversation_ref_limit_reached" }, { status: 429 });
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO conversation_refs (thread_id, space_id, session_id, title, created_at)
         VALUES (?, ?, ?, ?, COALESCE((SELECT created_at FROM conversation_refs WHERE space_id = ? AND thread_id = ?), datetime('now')))`,
        body.thread_id, body.space_id, body.session_id ?? null, body.title ?? null, body.space_id, body.thread_id
      );
      return Response.json({ ok: true }, { status: 201 });
    }
    if (method === "GET" && url.pathname === "/conversation-refs") {
      const limitValue = Number(url.searchParams.get("limit") ?? "50");
      const cursor = url.searchParams.get("cursor");
      if (!Number.isInteger(limitValue) || limitValue < 1 || limitValue > 100) return Response.json({ error_code: "invalid_limit" }, { status: 400 });
      let cursorParts: string[] | null = null;
      if (cursor !== null) {
        if (cursor.length > 2048) return Response.json({ error_code: "invalid_cursor" }, { status: 400 });
        try { cursorParts = JSON.parse(decodeURIComponent(atob(cursor))) as string[]; } catch { return Response.json({ error_code: "invalid_cursor" }, { status: 400 }); }
        if (!Array.isArray(cursorParts) || cursorParts.length !== 3 || cursorParts.some((part) => typeof part !== "string" || !part)) return Response.json({ error_code: "invalid_cursor" }, { status: 400 });
      }
      const rows = (cursorParts
        ? this.ctx.storage.sql.exec("SELECT thread_id, space_id, session_id, title, created_at FROM conversation_refs WHERE created_at < ? OR (created_at = ? AND space_id < ?) OR (created_at = ? AND space_id = ? AND thread_id < ?) ORDER BY created_at DESC, space_id DESC, thread_id DESC LIMIT ?", cursorParts[0], cursorParts[0], cursorParts[1], cursorParts[0], cursorParts[1], cursorParts[2], limitValue + 1)
        : this.ctx.storage.sql.exec("SELECT thread_id, space_id, session_id, title, created_at FROM conversation_refs ORDER BY created_at DESC, space_id DESC, thread_id DESC LIMIT ?", limitValue + 1))
        .toArray() as Array<{ thread_id: string; space_id: string; session_id: string | null; title: string | null; created_at: string }>;
      const hasMore = rows.length > limitValue;
      const data = rows.slice(0, limitValue);
      const last = data[data.length - 1];
      return Response.json({ data, ...(hasMore && last ? { next_cursor: btoa(encodeURIComponent(JSON.stringify([last.created_at, last.space_id, last.thread_id]))) } : {}) });
    }

    // ── Preferences ─────────────────────────────────────────────────────────────
    if (method === "PUT" && url.pathname === "/preferences") {
      const body = await request.json<{ key: string; value: unknown }>().catch(() => null);
      if (!body || typeof body.key !== "string" || !body.key || body.key.length > 128) return Response.json({ error: "key must be a non-empty string up to 128 characters" }, { status: 400 });
      let value: string;
      try { value = JSON.stringify(body.value ?? null); } catch { return Response.json({ error: "value must be JSON serializable" }, { status: 400 }); }
      if (value.length > 16 * 1024) return Response.json({ error: "preference value is too large" }, { status: 413 });
      const exists = this.ctx.storage.sql.exec("SELECT 1 AS found FROM preferences WHERE key = ?", body.key).toArray();
      const count = this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM preferences").toArray() as Array<{ count: number }>;
      if (!exists.length && (count[0]?.count ?? 0) >= MAX_PREFERENCES) return Response.json({ error_code: "preference_limit_reached" }, { status: 429 });
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO preferences (key, value, updated_at) VALUES (?, ?, datetime('now'))",
        body.key, value
      );
      return Response.json({ ok: true });
    }
    if (method === "GET" && url.pathname === "/preferences") {
      const rows = this.ctx.storage.sql
        .exec("SELECT key, value FROM preferences")
        .toArray() as unknown as { key: string; value: string }[];
      const prefs: Record<string, unknown> = {};
      for (const r of rows) prefs[r.key] = JSON.parse(r.value) as unknown;
      return Response.json({ preferences: prefs });
    }

    // ── Notifications ─────────────────────────────────────────────────────────
    if (method === "POST" && url.pathname === "/notifications") {
      const body = await request.json<{ payload: unknown }>().catch(() => null);
      if (!body || typeof body !== "object") return Response.json({ error_code: "notification_invalid" }, { status: 400 });
      let payload: string;
      try { payload = JSON.stringify(body.payload ?? {}); } catch { return Response.json({ error_code: "notification_invalid" }, { status: 400 }); }
      if (payload.length > 64 * 1024) return Response.json({ error_code: "notification_too_large" }, { status: 413 });
      const count = this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM notification_queue WHERE status='pending'").toArray() as Array<{ count: number }>;
      if ((count[0]?.count ?? 0) >= MAX_PENDING_NOTIFICATIONS) return Response.json({ error_code: "notification_queue_full" }, { status: 429 });
      this.ctx.storage.sql.exec(
        "INSERT INTO notification_queue (id, payload) VALUES (?, ?)",
        crypto.randomUUID(), payload
      );
      return Response.json({ ok: true }, { status: 201 });
    }
    if (method === "GET" && url.pathname === "/notifications") {
      const limitValue = Number(url.searchParams.get("limit") ?? "50");
      const cursor = url.searchParams.get("cursor");
      if (!Number.isInteger(limitValue) || limitValue < 1 || limitValue > 100) return Response.json({ error_code: "invalid_limit" }, { status: 400 });
      let cursorParts: string[] | null = null;
      if (cursor !== null) {
        if (cursor.length > 2048) return Response.json({ error_code: "invalid_cursor" }, { status: 400 });
        try { cursorParts = JSON.parse(decodeURIComponent(atob(cursor))) as string[]; } catch { return Response.json({ error_code: "invalid_cursor" }, { status: 400 }); }
        if (!Array.isArray(cursorParts) || cursorParts.length !== 2 || cursorParts.some((part) => typeof part !== "string" || !part)) return Response.json({ error_code: "invalid_cursor" }, { status: 400 });
      }
      const rows = (cursorParts
        ? this.ctx.storage.sql.exec("SELECT id, payload, status, created_at FROM notification_queue WHERE status = 'pending' AND (created_at > ? OR (created_at = ? AND id > ?)) ORDER BY created_at ASC, id ASC LIMIT ?", cursorParts[0], cursorParts[0], cursorParts[1], limitValue + 1)
        : this.ctx.storage.sql.exec("SELECT id, payload, status, created_at FROM notification_queue WHERE status = 'pending' ORDER BY created_at ASC, id ASC LIMIT ?", limitValue + 1))
        .toArray() as unknown as { id: string; payload: string; status: string; created_at: string }[];
      const hasMore = rows.length > limitValue;
      const data = rows.slice(0, limitValue);
      const last = data[data.length - 1];
      return Response.json({ data: data.map((r) => ({ ...r, payload: JSON.parse(r.payload) as unknown })), ...(hasMore && last ? { next_cursor: btoa(encodeURIComponent(JSON.stringify([last.created_at, last.id]))) } : {}) });
    }

    // ── GDPR Art. 20 — data portability. Full machine-readable dump of everything this DO holds
    // for this end user (mirrors the SpaceDO /me/export pattern, but for the product-user record). ──
    if (method === "GET" && url.pathname === "/export") {
      const sessions = this.ctx.storage.sql
        .exec("SELECT session_id, auth_provider, created_at, expires_at, revoked_at FROM session_state")
        .toArray();
      const conversations = this.ctx.storage.sql
        .exec("SELECT thread_id, space_id, title, created_at FROM conversation_refs ORDER BY created_at ASC")
        .toArray();
      const prefRows = this.ctx.storage.sql
        .exec("SELECT key, value FROM preferences")
        .toArray() as unknown as { key: string; value: string }[];
      const preferences: Record<string, unknown> = {};
      for (const r of prefRows) preferences[r.key] = JSON.parse(r.value) as unknown;
      return Response.json({
        export_version: "1",
        exported_at: new Date().toISOString(),
        // Note: sessions exclude token_hash — never export credential material.
        sessions,
        conversations,
        preferences,
      });
    }

    // ── GDPR Art. 17 — right to erasure. The direct inverse of /export above: wipes exactly the
    // personal/behavioral data /export reports (sessions, conversation links, preferences).
    // This DO has no knowledge of the caller's real email/display_name — those live in
    // product_end_users (D1) and are anonymized by the caller.
    // the spaces-worker route that calls this. Idempotent: erasing twice is a no-op the second
    // time, never an error.
    if (method === "DELETE" && url.pathname === "/erase") {
      const sessionsDeleted = this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM session_state").toArray()[0] as unknown as { n: number };
      const conversationsDeleted = this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM conversation_refs").toArray()[0] as unknown as { n: number };
      this.ctx.storage.sql.exec("DELETE FROM session_state");
      this.ctx.storage.sql.exec("DELETE FROM conversation_refs");
      this.ctx.storage.sql.exec("DELETE FROM preferences");
      return Response.json({
        erased_at: new Date().toISOString(),
        sessions_deleted: sessionsDeleted?.n ?? 0,
        conversations_deleted: conversationsDeleted?.n ?? 0,
      });
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  }
}

// Type-only re-exports for consumers that want the row shapes without importing cloudflare:workers.
export type { SessionRow };
