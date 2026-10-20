// Three-Tier Platform Model (spec "Three-Tier Platform Model" / Journey 1B), Phase 2
// (docs/spec-appendix/A1-script-agents-and-space-assistants.md §A1.17). ONE INSTANCE PER
// (productId, endUserId) — addressed getDOName("produser", `${productId}:${endUserId}`, tenantId,
// PLATFORM_SECRET). This is the platform's FIRST persistent, signed-in end-user concept: today a
// Launchpad end user is an anonymous session id with no durable identity, credit balance, or
// preferences. A Product end user is fully isolated even across products — the same human logging
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
// Credit ledger is a LEDGER, not a second source of truth for token→credit conversion: callers
// pass already-converted credits (the agent runtime owns tokensToCredits(), billing-core's single
// conversion point — CLAUDE.md #12). This DO only debits/credits and reports the running balance.

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

interface LedgerRow {
  id: string;
  delta_credits: number;
  reason: string;
  model: string | null;
  balance_after: number;
  created_at: string;
}

const SESSION_TTL_MS = 30 * 86_400_000; // 30 days, refreshed on each verify

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
    // Phase E (§A1.17): credit-pack purchases grant credits via a Lemon Squeezy webhook, which
    // can retry — without a dedupe key, a retry would double-grant. `launchpad_orders` has the
    // same problem solved with a `provider_event_id` unique partial index (D1); this is the
    // per-DO-SQLite equivalent for ProductUserDO's own credit_ledger.
    version: 2,
    description: "add idempotency_key to credit_ledger for webhook-safe grants",
    up: `
      ALTER TABLE credit_ledger ADD COLUMN idempotency_key TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_ledger_idempotency
        ON credit_ledger(idempotency_key) WHERE idempotency_key IS NOT NULL;
    `,
  },
  {
    // Phase 4 (money): the end user's own personal-plan tier — gates how many businesses THEY can
    // own under this product (business-create.ts's maxBusinessesPerEndUser combines with this) and
    // whether others may accept an invite into a business they own. Deliberately NOT stored in the
    // general-purpose `preferences` key-value table: preferences is end-user-writable through an
    // ordinary session-authenticated route, and plan_tier must only ever change via a real checkout
    // (or the internal grant route a webhook calls) — a separate, protected table makes that
    // impossible to conflate. Singleton row (id always 1, CHECK-enforced) — one tier per DO
    // instance, which is already exactly one (productId, endUserId) pair.
    version: 3,
    description: "add plan_state for the end user's own personal-plan tier",
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
];

export class ProductUserDO extends DurableObject {
  private initialized = false;

  private ensureInit(): void {
    if (this.initialized) return;
    applyMigrations(this.ctx.storage as never, MIGRATIONS);
    this.initialized = true;
  }

  /** Current balance = SUM of every ledger delta (the ledger is the source of truth). */
  private currentBalance(): number {
    const rows = this.ctx.storage.sql
      .exec("SELECT COALESCE(SUM(delta_credits), 0) AS bal FROM credit_ledger")
      .toArray() as unknown as { bal: number }[];
    return rows[0]?.bal ?? 0;
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
      const body = await request.json<{ auth_provider?: string }>().catch(() => ({} as { auth_provider?: string }));
      const sessionId = crypto.randomUUID();
      const rawToken = `nps_${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "")}`;
      const tokenHash = await sha256Hex(rawToken);
      const now = new Date();
      const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
      this.ctx.storage.sql.exec(
        `INSERT INTO session_state (session_id, token_hash, auth_provider, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
        sessionId, tokenHash, body.auth_provider ?? "naelao-native", now.toISOString(), expiresAt
      );
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
      if (!body.session_token) return Response.json({ valid: false }, { status: 400 });
      const tokenHash = await sha256Hex(body.session_token);
      const rows = this.ctx.storage.sql
        .exec(
          "SELECT session_id, expires_at, revoked_at FROM session_state WHERE token_hash = ?",
          tokenHash
        )
        .toArray() as unknown as { session_id: string; expires_at: string; revoked_at: string | null }[];
      const row = rows[0];
      if (!row || row.revoked_at) return Response.json({ valid: false });
      if (new Date(row.expires_at) < new Date()) return Response.json({ valid: false });
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

    // ── Credits ───────────────────────────────────────────────────────────────
    // GET /credits/balance
    if (method === "GET" && url.pathname === "/credits/balance") {
      return Response.json({ balance_credits: this.currentBalance() });
    }

    if (method === "POST" && url.pathname === "/credits/reservations") {
      const body = await request.json<{ action?: string; reservation_id?: string; run_id?: string; credits?: number }>().catch(() => ({} as any));
      const action = body.action, runId = body.run_id ?? "", now = new Date().toISOString();
      if (!runId || runId.length > 128) return Response.json({ error_code: "reservation_invalid" }, { status: 400 });
      const sql = this.ctx.storage.sql;
      if (action === "reserve") {
        const reservationId = body.reservation_id ?? "", credits = body.credits;
        if (!reservationId || reservationId.length > 200 || !Number.isSafeInteger(credits) || (credits ?? 0) <= 0) return Response.json({ error_code: "reservation_invalid" }, { status: 400 });
        const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
        const result = this.ctx.storage.transactionSync(() => {
          sql.exec("UPDATE credit_reservations SET status='expired',updated_at=? WHERE status='held' AND expires_at<=?", now, now);
          const prior = sql.exec("SELECT run_id,credits,status FROM credit_reservations WHERE reservation_id=?", reservationId).toArray() as Array<{ run_id: string; credits: number; status: string }>;
          if (prior[0]) return prior[0].run_id === runId && prior[0].credits === credits && prior[0].status === "held" ? { ok: true, deduplicated: true } : { ok: false, conflict: true };
          const held = sql.exec("SELECT COALESCE(SUM(credits),0) AS credits FROM credit_reservations WHERE status='held' AND expires_at>?", now).toArray() as Array<{ credits: number }>;
          const available = this.currentBalance() - (held[0]?.credits ?? 0);
          if (available < (credits as number)) return { ok: false, insufficient: true, available };
          sql.exec("INSERT INTO credit_reservations (reservation_id,run_id,credits,status,expires_at,created_at,updated_at) VALUES (?,?,?,'held',?,?,?)", reservationId, runId, credits, expiresAt, now, now);
          return { ok: true, deduplicated: false, expires_at: expiresAt };
        });
        if ("conflict" in result) return Response.json({ error_code: "reservation_id_conflict" }, { status: 409 });
        if (!result.ok) return Response.json({ error_code: "insufficient_credits", available_credits: result.available }, { status: 402 });
        return Response.json(result);
      }
      if (action === "release_run") {
        const released = this.ctx.storage.transactionSync(() => sql.exec("UPDATE credit_reservations SET status='released',updated_at=? WHERE run_id=? AND status='held'", now, runId).rowsWritten);
        return Response.json({ run_id: runId, released });
      }
      if (action === "settle_run") {
        const actual = body.credits;
        if (!Number.isSafeInteger(actual) || (actual ?? -1) < 0) return Response.json({ error_code: "settlement_invalid" }, { status: 400 });
        const result = this.ctx.storage.transactionSync(() => {
          const settled = sql.exec("SELECT actual_credits FROM credit_run_settlements WHERE run_id=?", runId).toArray() as Array<{ actual_credits: number }>;
          if (settled[0]) return { ok: true, deduplicated: true, actual_credits: settled[0].actual_credits };
          sql.exec("UPDATE credit_reservations SET status='expired',updated_at=? WHERE status='held' AND expires_at<=?", now, now);
          const other = sql.exec("SELECT COALESCE(SUM(credits),0) AS credits FROM credit_reservations WHERE status='held' AND run_id!=? AND expires_at>?", runId, now).toArray() as Array<{ credits: number }>;
          if ((actual as number) > this.currentBalance() - (other[0]?.credits ?? 0)) return { ok: false, insufficient: true };
          sql.exec("UPDATE credit_reservations SET status='settled',updated_at=? WHERE run_id=? AND status='held'", now, runId);
          if ((actual as number) > 0) {
            const balanceAfter = this.currentBalance() - (actual as number);
            sql.exec("INSERT INTO credit_ledger (id,delta_credits,reason,model,balance_after,idempotency_key) VALUES (?,?,?,NULL,?,?)", crypto.randomUUID(), -(actual as number), "agent_run", balanceAfter, `run:${runId}`);
          }
          sql.exec("INSERT INTO credit_run_settlements (run_id,actual_credits,settled_at) VALUES (?,?,?)", runId, actual, now);
          return { ok: true, deduplicated: false, actual_credits: actual, balance_credits: this.currentBalance() };
        });
        if (!result.ok) return Response.json({ error_code: "insufficient_credits" }, { status: 402 });
        return Response.json(result);
      }
      return Response.json({ error_code: "reservation_action_invalid" }, { status: 400 });
    }

    // GET /plan-tier — Phase 4 (money): the end user's own personal-plan tier. No auth inside the
    // DO itself (matches this class's own established convention — every route here trusts its
    // caller, and it's the wrapping workers/spaces/src/index.ts route that gates who can reach
    // it). Defaults to 'free' when the singleton row hasn't been written yet (a brand-new DO).
    if (method === "GET" && url.pathname === "/plan-tier") {
      const row = this.ctx.storage.sql
        .exec("SELECT plan_tier FROM plan_state WHERE id = 1")
        .toArray() as unknown as { plan_tier: string }[];
      return Response.json({ plan_tier: row[0]?.plan_tier ?? "free" });
    }

    // POST /plan-tier/set — internal-only settor. The ONLY caller that should ever reach this is
    // the spaces worker's HMAC-gated /internal/personal-plan/grant route (after a real checkout,
    // mirroring /credits/grant's own webhook-driven precedent) — there is deliberately no
    // end-user-reachable "set my own tier" route anywhere, since that would let anyone grant
    // themselves the paid tier for free.
    if (method === "POST" && url.pathname === "/plan-tier/set") {
      const body = await request.json<{ plan_tier: string }>();
      if (body.plan_tier !== "free" && body.plan_tier !== "plus") {
        return Response.json({ error: "plan_tier must be 'free' or 'plus'" }, { status: 400 });
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO plan_state (id, plan_tier, updated_at) VALUES (1, ?, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET plan_tier = excluded.plan_tier, updated_at = excluded.updated_at`,
        body.plan_tier
      );
      return Response.json({ plan_tier: body.plan_tier });
    }

    // POST /credits/grant — top-up / initial allocation (positive delta). `idempotency_key` is
    // optional (internal callers with no retry risk can omit it) but REQUIRED for anything driven
    // by a webhook that Lemon Squeezy may redeliver (Phase E credit-pack purchases) — a repeat
    // call with the same key is a no-op, returning the balance as of the original grant.
    if (method === "POST" && url.pathname === "/credits/grant") {
      const body = await request.json<{ credits: number; reason?: string; idempotency_key?: string }>();
      if (!Number.isFinite(body.credits) || body.credits <= 0) {
        return Response.json({ error: "credits must be a positive number" }, { status: 400 });
      }
      if (body.idempotency_key) {
        const existing = this.ctx.storage.sql
          .exec("SELECT balance_after FROM credit_ledger WHERE idempotency_key = ?", body.idempotency_key)
          .toArray() as unknown as { balance_after: number }[];
        if (existing[0]) {
          return Response.json({ balance_credits: existing[0].balance_after, deduplicated: true }, { status: 200 });
        }
      }
      const balanceAfter = this.currentBalance() + Math.floor(body.credits);
      this.ctx.storage.sql.exec(
        `INSERT INTO credit_ledger (id, delta_credits, reason, balance_after, idempotency_key) VALUES (?, ?, ?, ?, ?)`,
        crypto.randomUUID(), Math.floor(body.credits), body.reason ?? "grant", balanceAfter, body.idempotency_key ?? null
      );
      return Response.json({ balance_credits: balanceAfter }, { status: 201 });
    }

    // POST /credits/deduct — debit already-converted credits (caller ran tokensToCredits). Fails
    // CLOSED: an over-draw is rejected, not silently allowed to go negative.
    // S0.6: `idempotency_key` is optional (mirrors /credits/grant above) but should be supplied
    // by any caller that might retry the same debit — NaelaoAgentDO.debitEndUserCredits passes
    // its runId, so a retried post-run debit (e.g. after a transient network error on the first
    // attempt got a response back late) is a no-op reusing the original ledger entry, not a
    // second charge for the same run. Shares the one credit_ledger.idempotency_key unique index
    // with /credits/grant — callers must use a distinctly-namespaced key (grant keys are already
    // prefixed e.g. "credit_pack:...."; deduct keys are prefixed "run:") so the two can never
    // collide with each other.
    if (method === "POST" && url.pathname === "/credits/deduct") {
      const body = await request.json<{ credits: number; reason?: string; model?: string; idempotency_key?: string }>();
      if (!Number.isFinite(body.credits) || body.credits <= 0) {
        return Response.json({ error: "credits must be a positive number" }, { status: 400 });
      }
      if (body.idempotency_key) {
        const existing = this.ctx.storage.sql
          .exec("SELECT balance_after FROM credit_ledger WHERE idempotency_key = ?", body.idempotency_key)
          .toArray() as unknown as { balance_after: number }[];
        if (existing[0]) {
          return Response.json({ balance_credits: existing[0].balance_after, deduplicated: true }, { status: 200 });
        }
      }
      const debit = Math.ceil(body.credits);
      const balance = this.currentBalance();
      const held = this.ctx.storage.sql.exec("SELECT COALESCE(SUM(credits),0) AS credits FROM credit_reservations WHERE status='held' AND expires_at>?", new Date().toISOString()).toArray() as Array<{ credits: number }>;
      if (debit > balance - (held[0]?.credits ?? 0)) {
        return Response.json({ error: "insufficient_credits", balance_credits: balance, reserved_credits: held[0]?.credits ?? 0 }, { status: 402 });
      }
      const balanceAfter = balance - debit;
      // F-47/F-50: the SELECT-then-INSERT above is already atomic within a single DO instance
      // (DO SQLite .exec is synchronous and there is no `await` between the dedup SELECT and this
      // INSERT, and a DO processes one request to completion before the next), so the audited
      // TOCTOU can't actually interleave here. As defense-in-depth against the unique-index path
      // (and any future refactor that introduces an await), catch a duplicate-key violation and
      // return the already-recorded balance instead of surfacing an error / double-debiting.
      try {
        this.ctx.storage.sql.exec(
          `INSERT INTO credit_ledger (id, delta_credits, reason, model, balance_after, idempotency_key) VALUES (?, ?, ?, ?, ?, ?)`,
          crypto.randomUUID(), -debit, body.reason ?? "agent_run", body.model ?? null, balanceAfter, body.idempotency_key ?? null
        );
      } catch (err) {
        if (body.idempotency_key) {
          const raced = this.ctx.storage.sql
            .exec("SELECT balance_after FROM credit_ledger WHERE idempotency_key = ?", body.idempotency_key)
            .toArray() as unknown as { balance_after: number }[];
          if (raced[0]) return Response.json({ balance_credits: raced[0].balance_after, deduplicated: true }, { status: 200 });
        }
        throw err;
      }
      return Response.json({ balance_credits: balanceAfter }, { status: 201 });
    }

    // POST /credits/clawback — F-29: reverse a refunded credit-pack grant. Unlike /credits/deduct
    // this does NOT fail closed on insufficient balance: if the buyer already spent some of the
    // refunded credits, the balance goes negative (they were refunded the money, so they genuinely
    // owe the value) rather than leaving free credits behind. Idempotent on idempotency_key.
    if (method === "POST" && url.pathname === "/credits/clawback") {
      const body = await request.json<{ credits: number; reason?: string; idempotency_key: string }>();
      if (!Number.isFinite(body.credits) || body.credits <= 0 || !body.idempotency_key) {
        return Response.json({ error: "credits (positive) and idempotency_key are required" }, { status: 400 });
      }
      const existing = this.ctx.storage.sql
        .exec("SELECT balance_after FROM credit_ledger WHERE idempotency_key = ?", body.idempotency_key)
        .toArray() as unknown as { balance_after: number }[];
      if (existing[0]) {
        return Response.json({ balance_credits: existing[0].balance_after, deduplicated: true }, { status: 200 });
      }
      const balanceAfter = this.currentBalance() - Math.ceil(body.credits);
      this.ctx.storage.sql.exec(
        `INSERT INTO credit_ledger (id, delta_credits, reason, balance_after, idempotency_key) VALUES (?, ?, ?, ?, ?)`,
        crypto.randomUUID(), -Math.ceil(body.credits), body.reason ?? "refund_clawback", balanceAfter, body.idempotency_key
      );
      return Response.json({ balance_credits: balanceAfter }, { status: 201 });
    }

    // ── Conversation refs (metadata only — the builder's gated conversation access reads these) ──
    if (method === "POST" && url.pathname === "/conversation-refs") {
      const body = await request.json<{ thread_id: string; space_id: string; session_id?: string; title?: string }>();
      if (!body.thread_id || !body.space_id) {
        return Response.json({ error: "thread_id and space_id are required" }, { status: 400 });
      }
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO conversation_refs (thread_id, space_id, session_id, title, created_at)
         VALUES (?, ?, ?, ?, COALESCE((SELECT created_at FROM conversation_refs WHERE space_id = ? AND thread_id = ?), datetime('now')))`,
        body.thread_id, body.space_id, body.session_id ?? null, body.title ?? null, body.space_id, body.thread_id
      );
      return Response.json({ ok: true }, { status: 201 });
    }
    if (method === "GET" && url.pathname === "/conversation-refs") {
      const rows = this.ctx.storage.sql
        .exec("SELECT thread_id, space_id, session_id, title, created_at FROM conversation_refs ORDER BY created_at DESC")
        .toArray();
      return Response.json({ data: rows });
    }

    // ── Preferences ─────────────────────────────────────────────────────────────
    if (method === "PUT" && url.pathname === "/preferences") {
      const body = await request.json<{ key: string; value: unknown }>();
      if (!body.key) return Response.json({ error: "key is required" }, { status: 400 });
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO preferences (key, value, updated_at) VALUES (?, ?, datetime('now'))",
        body.key, JSON.stringify(body.value ?? null)
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
      const body = await request.json<{ payload: unknown }>();
      this.ctx.storage.sql.exec(
        "INSERT INTO notification_queue (id, payload) VALUES (?, ?)",
        crypto.randomUUID(), JSON.stringify(body.payload ?? {})
      );
      return Response.json({ ok: true }, { status: 201 });
    }
    if (method === "GET" && url.pathname === "/notifications") {
      const rows = this.ctx.storage.sql
        .exec("SELECT id, payload, status, created_at FROM notification_queue WHERE status = 'pending' ORDER BY created_at ASC")
        .toArray() as unknown as { id: string; payload: string; status: string; created_at: string }[];
      return Response.json({ data: rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) as unknown })) });
    }

    // ── GDPR Art. 20 — data portability. Full machine-readable dump of everything this DO holds
    // for this end user (mirrors the SpaceDO /me/export pattern, but for the product-user record). ──
    if (method === "GET" && url.pathname === "/export") {
      const sessions = this.ctx.storage.sql
        .exec("SELECT session_id, auth_provider, created_at, expires_at, revoked_at FROM session_state")
        .toArray();
      const ledger = this.ctx.storage.sql
        .exec("SELECT delta_credits, reason, model, balance_after, created_at FROM credit_ledger ORDER BY created_at ASC")
        .toArray() as unknown as LedgerRow[];
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
        credit_ledger: ledger,
        credit_balance: this.currentBalance(),
        conversations,
        preferences,
      });
    }

    // ── GDPR Art. 17 — right to erasure. The direct inverse of /export above: wipes exactly the
    // personal/behavioral data /export reports (sessions, conversation links, preferences).
    // credit_ledger is deliberately KEPT — it holds no PII (just delta_credits/reason/model/
    // balance_after/timestamps), and a financial/audit trail has its own legitimate-interest
    // retention basis distinct from "personal data" under Art. 17(3). This DO has no knowledge of
    // the caller's real email/display_name — those live in product_end_users (D1), anonymized by
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
export type { SessionRow, LedgerRow };
