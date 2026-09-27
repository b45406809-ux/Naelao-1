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

const SWEEP_INTERVAL_MS = 5 * 60 * 1000; // spec: "auto-release abandoned slots" via DO Alarms
const DEFAULT_TTL_MS = 30 * 60 * 1000; // a slot no one explicitly releases within 30m is stale
const FILE_LOCK_TTL_MS = 30_000;

export interface ConcurrencyDOEnv {
  PLATFORM_SECRET?: string;
}

export class ConcurrencyDO extends DurableObject<ConcurrencyDOEnv> {
  private initialized = false;

  private ensureInit(): void {
    if (this.initialized) return;
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
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS locks (
      key TEXT PRIMARY KEY, holder_id TEXT NOT NULL, acquired_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    )`);
    this.ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS idx_locks_expires ON locks(expires_at)`);
    this.initialized = true;
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
      if (request.method === "POST" && (url.pathname === "/lock/acquire" || url.pathname === "/locks/acquire")) {
        return this.acquireLock(request);
      }
      if (request.method === "POST" && (url.pathname === "/lock/release" || url.pathname === "/locks/release")) {
        return this.releaseLock(request);
      }
      if (request.method === "POST" && url.pathname === "/locks/force-release") {
        return this.forceReleaseLock(request);
      }
      return Response.json({ error_code: "not_found" }, { status: 404 });
    } catch (err) {
      return Response.json({ error_code: "internal_error", message: String(err) }, { status: 500 });
    }
  }

  private async acquireLock(request: Request): Promise<Response> {
    const body = await request.json<{ key?: string; holderId?: string; holder_id?: string; ttlMs?: number; ttl_ms?: number }>().catch(() => ({} as { key?: string; holderId?: string; holder_id?: string; ttlMs?: number; ttl_ms?: number }));
    const key = String(body.key ?? "");
    const holderId = String(body.holderId ?? body.holder_id ?? "");
    if (!key || !holderId) return Response.json({ error_code: "bad_request", message: "key and holderId are required" }, { status: 400 });
    // File locks are deliberately short lived. Callers may request less, never more.
    const requestedTtl = body.ttlMs ?? body.ttl_ms ?? FILE_LOCK_TTL_MS;
    const ttlMs = Math.max(1, Math.min(FILE_LOCK_TTL_MS, requestedTtl));
    const now = Date.now();
    this.ctx.storage.sql.exec(`DELETE FROM locks WHERE key = ? AND expires_at <= ?`, key, now);
    const rows = this.ctx.storage.sql.exec(`SELECT holder_id, expires_at FROM locks WHERE key = ?`, key).toArray() as Array<{ holder_id: string; expires_at: number }>;
    const held = rows[0];
    if (held && held.holder_id !== holderId) {
      return Response.json({ acquired: false, heldBy: held.holder_id, remainingMs: Math.max(0, held.expires_at - now) });
    }
    const expiresAt = now + ttlMs;
    this.ctx.storage.sql.exec(
      `INSERT INTO locks (key, holder_id, acquired_at, expires_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET holder_id=excluded.holder_id, acquired_at=excluded.acquired_at, expires_at=excluded.expires_at`,
      key, holderId, now, expiresAt
    );
    await this.scheduleNextAlarm();
    return Response.json({ acquired: true, holderId, expiresAt, ttlMs });
  }

  private async releaseLock(request: Request): Promise<Response> {
    const body = await request.json<{ key?: string; holderId?: string; holder_id?: string }>().catch(() => ({} as { key?: string; holderId?: string; holder_id?: string }));
    const key = String(body.key ?? "");
    const holderId = String(body.holderId ?? body.holder_id ?? "");
    const before = this.ctx.storage.sql.exec(`SELECT holder_id FROM locks WHERE key = ?`, key).toArray() as Array<{ holder_id: string }>;
    if (key && holderId) this.ctx.storage.sql.exec(`DELETE FROM locks WHERE key = ? AND holder_id = ?`, key, holderId);
    await this.scheduleNextAlarm();
    return Response.json({ released: before[0]?.holder_id === holderId });
  }

  private async forceReleaseLock(request: Request): Promise<Response> {
    const body = await request.json<{ key?: string }>().catch(() => ({} as { key?: string }));
    const key = String(body.key ?? "");
    if (!key) return Response.json({ error_code: "bad_request", message: "key is required" }, { status: 400 });
    this.ctx.storage.sql.exec(`DELETE FROM locks WHERE key = ?`, key);
    await this.scheduleNextAlarm();
    return Response.json({ released: true, forced: true });
  }

  private async scheduleNextAlarm(): Promise<void> {
    const rows = this.ctx.storage.sql.exec(`SELECT MIN(expires_at) AS expires_at FROM locks`).toArray() as Array<{ expires_at: number | null }>;
    const next = rows[0]?.expires_at;
    await this.ctx.storage.setAlarm(next ?? Date.now() + SWEEP_INTERVAL_MS);
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
    this.ctx.storage.sql.exec(`DELETE FROM slots WHERE expires_at < ?`, Date.now());
    this.ctx.storage.sql.exec(`DELETE FROM locks WHERE expires_at <= ?`, Date.now());
    await this.scheduleNextAlarm();
  }
}
