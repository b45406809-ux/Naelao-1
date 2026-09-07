/**
 * ConcurrencyDO (spec §28 "DO Deep Dive: ConcurrencyDO", byte ~551944) — "enforces how many
 * agent runs a user can have active simultaneously." This build wires it specifically to cap
 * simultaneous SUB-AGENT TREES per (spaceId, accountKey): the existing MAX_SUB_AGENTS_PER_SPAWN
 * (16) bounds the fan-out WITHIN one agent.spawn call; this bounds how many separate spawn
 * trees can be running AT THE SAME TIME across an account, so a runaway or malicious caller
 * can't fire off spawn-tree after spawn-tree and exhaust the account's execution capacity.
 * General enough to gate ordinary agent runs too later — same acquire/release contract the
 * spec describes for that case.
 *
 * Deadlock fix (spec gap "ConcurrencyDO — Deadlock Scenario", byte ~1602578): the spec's
 * described design leaves a slot held forever if the holder crashes before releasing. Every
 * acquired slot here carries its own TTL (expires_at) and a DO Alarm sweeps expired slots —
 * so a crashed/evicted holder's slot is reclaimed automatically, not leaked.
 *
 * Race fix (spec gap "ConcurrencyDO — check-then-insert race"): acquire() does its COUNT and
 * its INSERT in the same synchronous DO SQLite call sequence with no `await` between them, so
 * two concurrent acquire() calls can never both observe the same under-the-limit count and
 * both succeed — the DO's single-threaded execution model makes this atomic by construction.
 *
 * WS-7 (audit plan) — DO-naming exception, documented not normalized: callers address this DO by
 * a plain server-derived key (spaceId/accountKey), not the HMAC-SHA256(tenantId, secret):type:id
 * convention SpaceDO/NaelaoAgentDO use (G-BA01). Same rationale as TaskDO's exception (see its
 * file header): the key is never a raw client-supplied value forwarded as-is, so there's no
 * cross-tenant enumeration path through this worker's own API — only a compromised worker with
 * direct DO-binding access could enumerate names, already mitigated by workers_dev=false +
 * requireInternalHmac. Deferred, not dropped, pending a live-migration plan.
 */

import { DurableObject } from "cloudflare:workers";
import type { DurableObjectState } from "cloudflare:workers";

const SWEEP_INTERVAL_MS = 5 * 60 * 1000; // spec: "auto-release abandoned slots" via DO Alarms
const DEFAULT_TTL_MS = 30 * 60 * 1000; // a slot no one explicitly releases within 30m is stale

export interface ConcurrencyDOEnv {
  PLATFORM_SECRET?: string;
}

export interface LockAcquireRequest {
  key: string;              // e.g. "file:space_102:proj_dev:src/Header.astro"
  holderId: string;         // e.g. "thread_102_agent_dev"
  ttlMs?: number;           // Defaults to 30,000ms (30 seconds)
}

export interface LockAcquireResult {
  granted: boolean;
  key: string;
  holderId: string;
  expiresAtMs: number;
  remainingTtlMs?: number;
}

export class ConcurrencyDO extends DurableObject<ConcurrencyDOEnv> {
  private initialized = false;

  constructor(ctx: DurableObjectState, env: ConcurrencyDOEnv) {
    super(ctx, env);
    this.ensureInit();
  }

  private ensureInit(): void {
    if (this.initialized) return;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS slots (
          key         TEXT NOT NULL,
          holder_id   TEXT NOT NULL,
          acquired_at INTEGER NOT NULL,
          expires_at  INTEGER NOT NULL,
          PRIMARY KEY (key, holder_id)
        )
      `);
      this.ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS idx_slots_key ON slots(key)`);
      this.ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS idx_slots_expires ON slots(expires_at)`);

      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS distributed_locks (
          lock_key TEXT PRIMARY KEY,
          holder_id TEXT NOT NULL,
          expires_at_ms INTEGER NOT NULL,
          created_at_ms INTEGER NOT NULL
        )
      `);
      this.ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS idx_locks_expiry ON distributed_locks(expires_at_ms)`);
    });
    this.initialized = true;
  }

  async acquireLock(req: LockAcquireRequest): Promise<LockAcquireResult> {
    this.ensureInit();
    const { key, holderId, ttlMs = 30000 } = req;
    const now = Date.now();
    const expiresAt = now + ttlMs;

    const result = this.ctx.storage.transactionSync(() => {
      // 1. Fetch current lock status
      const existing = (this.ctx.storage.sql.exec(
        "SELECT lock_key, holder_id, expires_at_ms FROM distributed_locks WHERE lock_key = ?",
        key
      ).toArray() as unknown as Array<{ lock_key: string; holder_id: string; expires_at_ms: number }>)[0];

      // 2. If locked and not expired by a DIFFERENT holder -> DENIED
      if (existing && existing.expires_at_ms > now && existing.holder_id !== holderId) {
        return {
          granted: false,
          key,
          holderId: existing.holder_id,
          expiresAtMs: existing.expires_at_ms,
          remainingTtlMs: existing.expires_at_ms - now,
        };
      }

      // 3. Grant lock (Insert or renew)
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO distributed_locks (lock_key, holder_id, expires_at_ms, created_at_ms)
         VALUES (?, ?, ?, ?)`,
        key, holderId, expiresAt, now
      );

      return {
        granted: true,
        key,
        holderId,
        expiresAtMs: expiresAt,
      };
    });

    if (result.granted) {
      // Schedule automated alarm to clean expired locks
      await this.ctx.storage.setAlarm(now + ttlMs + 1000);
    }

    return result;
  }

  async releaseLock(key: string, holderId: string): Promise<{ released: boolean }> {
    this.ensureInit();
    return this.ctx.storage.transactionSync(() => {
      const existing = (this.ctx.storage.sql.exec(
        "SELECT holder_id FROM distributed_locks WHERE lock_key = ?",
        key
      ).toArray() as unknown as Array<{ holder_id: string }>)[0];

      if (!existing || existing.holder_id !== holderId) {
        return { released: false };
      }

      this.ctx.storage.sql.exec("DELETE FROM distributed_locks WHERE lock_key = ?", key);
      return { released: true };
    });
  }

  async getLockStatus(key: string): Promise<{ isLocked: boolean; holderId?: string; remainingTtlMs?: number }> {
    this.ensureInit();
    const now = Date.now();
    const existing = (this.ctx.storage.sql.exec(
      "SELECT holder_id, expires_at_ms FROM distributed_locks WHERE lock_key = ?",
      key
    ).toArray() as unknown as Array<{ holder_id: string; expires_at_ms: number }>)[0];

    if (!existing || existing.expires_at_ms <= now) {
      return { isLocked: false };
    }

    return {
      isLocked: true,
      holderId: existing.holder_id,
      remainingTtlMs: existing.expires_at_ms - now,
    };
  }

  override async fetch(request: Request): Promise<Response> {
    this.ensureInit();
    // First-ever slot creation on a fresh DO instance schedules the sweep; subsequent calls
    // are no-ops (setAlarm is idempotent-by-overwrite, but we only need one recurring cadence).
    const existingAlarm = await this.ctx.storage.getAlarm();
    if (existingAlarm === null) await this.ctx.storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS);

    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/acquire") {
        return this.handleAcquire(request);
      }
      if (request.method === "POST" && url.pathname === "/release") {
        return this.handleRelease(request);
      }
      if (request.method === "GET" && url.pathname === "/status") {
        return this.handleStatus(url.searchParams.get("key") ?? "");
      }
      if (request.method === "POST" && (url.pathname === "/lock/acquire" || url.pathname === "/lock-acquire")) {
        const body = await request.json<LockAcquireRequest>().catch(() => ({}) as LockAcquireRequest);
        const result = await this.acquireLock(body);
        return Response.json(result);
      }
      if (request.method === "POST" && (url.pathname === "/lock/release" || url.pathname === "/lock-release")) {
        const body = await request.json<{ key?: string; holderId?: string; holder_id?: string }>().catch(() => ({}) as any);
        const result = await this.releaseLock(body.key ?? "", body.holderId ?? body.holder_id ?? "");
        return Response.json(result);
      }
      if (request.method === "GET" && (url.pathname === "/lock/status" || url.pathname === "/lock-status")) {
        const key = url.searchParams.get("key") ?? "";
        const result = await this.getLockStatus(key);
        return Response.json(result);
      }
      return Response.json({ error_code: "not_found" }, { status: 404 });
    } catch (err) {
      return Response.json({ error_code: "internal_error", message: String(err) }, { status: 500 });
    }
  }

  private async handleAcquire(request: Request): Promise<Response> {
    const body = await request.json<{ key?: string; holder_id?: string; limit?: number; ttl_ms?: number }>().catch(() => ({}) as Record<string, never>);
    const key = String(body.key ?? "");
    const holderId = String(body.holder_id ?? "");
    const limit = typeof body.limit === "number" && body.limit > 0 ? body.limit : 3; // spec default maxConcurrentRuns
    // Only fall back to the default when the caller omitted ttl_ms entirely — an explicit
    // non-positive value (e.g. a test simulating an already-expired slot) is honored, not
    // silently overridden.
    const ttlMs = typeof body.ttl_ms === "number" ? body.ttl_ms : DEFAULT_TTL_MS;
    if (!key || !holderId) {
      return Response.json({ error_code: "bad_request", message: "key and holder_id are required" }, { status: 400 });
    }

    const now = Date.now();
    // Sweep this key's own stale slots inline too — bounds worst-case staleness to one
    // acquire() call even between alarm ticks, without waiting on the alarm cadence.
    this.ctx.storage.sql.exec(`DELETE FROM slots WHERE key = ? AND expires_at < ?`, key, now);

    // Idempotent re-acquire: a holder that already has this key's slot just extends its TTL.
    const already = this.ctx.storage.sql.exec(`SELECT 1 FROM slots WHERE key = ? AND holder_id = ?`, key, holderId).toArray();
    if (already.length > 0) {
      this.ctx.storage.sql.exec(`UPDATE slots SET expires_at = ? WHERE key = ? AND holder_id = ?`, now + ttlMs, key, holderId);
      return Response.json({ granted: true, active: this.countActive(key) });
    }

    // No `await` between this COUNT and the INSERT below — atomic against concurrent acquire()
    // calls for the same key (DO's single-threaded execution model).
    const active = this.countActive(key);
    if (active >= limit) {
      return Response.json({ granted: false, active, limit });
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO slots (key, holder_id, acquired_at, expires_at) VALUES (?, ?, ?, ?)`,
      key, holderId, now, now + ttlMs
    );
    return Response.json({ granted: true, active: active + 1, limit });
  }

  private async handleRelease(request: Request): Promise<Response> {
    const body = await request.json<{ key?: string; holder_id?: string }>().catch(() => ({}) as Record<string, never>);
    const key = String(body.key ?? "");
    const holderId = String(body.holder_id ?? "");
    if (key && holderId) {
      this.ctx.storage.sql.exec(`DELETE FROM slots WHERE key = ? AND holder_id = ?`, key, holderId);
    }
    return Response.json({ released: true });
  }

  private handleStatus(key: string): Response {
    return Response.json({ key, active: this.countActive(key) });
  }

  private countActive(key: string): number {
    const rows = this.ctx.storage.sql.exec(`SELECT COUNT(*) AS c FROM slots WHERE key = ?`, key).toArray() as Array<{ c: number }>;
    return rows[0]?.c ?? 0;
  }

  // Deadlock fix: reclaim any slot whose TTL lapsed without an explicit release (holder
  // crashed, was evicted, or simply never called back) — spec gap "ConcurrencyDO — Deadlock
  // Scenario" closed.
  override async alarm(): Promise<void> {
    this.ensureInit();
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(`DELETE FROM slots WHERE expires_at < ?`, now);
      this.ctx.storage.sql.exec(`DELETE FROM distributed_locks WHERE expires_at_ms <= ?`, now);
    });
    await this.ctx.storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS);
  }
}
