// G-BB34: Distributed lock via Durable Object.
// One LockDO instance per lock_name (use idFromName(lockName)).
//
// HTTP interface:
//   POST /acquire  { caller_id: string, ttl_ms?: number } → { acquired: boolean, holder?: string }
//   POST /release  { caller_id: string }                  → { released: boolean }
//   GET  /status                                          → { locked: boolean, holder?: string, expires_at?: number }
//
// Caller must release() when done. TTL (default 30s) auto-expires via alarm
// so a crashed caller does not hold the lock forever.

import { DurableObject } from "cloudflare:workers";

const DEFAULT_TTL_MS = 30_000;

export class LockDO extends DurableObject {
  private initialized = false;

  private ensureInit(): void {
    if (this.initialized) return;
    this.ctx.storage.sql.exec("PRAGMA journal_mode=WAL");
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS lock_state (
        id         INTEGER PRIMARY KEY CHECK (id = 1),
        holder     TEXT,
        expires_at INTEGER
      );
      INSERT OR IGNORE INTO lock_state (id, holder, expires_at) VALUES (1, NULL, NULL);
    `);
    this.initialized = true;
  }

  override async fetch(request: Request): Promise<Response> {
    this.ensureInit();
    const url = new URL(request.url);
    const nowMs = Date.now();

    if (request.method === "GET" && url.pathname === "/status") {
      const row = this.getLockRow();
      const locked = row.holder !== null && (row.expires_at ?? 0) > nowMs;
      return Response.json({
        locked,
        holder: locked ? row.holder : undefined,
        expires_at: locked ? row.expires_at : undefined,
      });
    }

    if (request.method === "POST" && url.pathname === "/acquire") {
      const body = await request.json<{ caller_id: string; ttl_ms?: number }>();
      if (!body.caller_id) {
        return Response.json({ error: "caller_id required" }, { status: 400 });
      }
      const ttlMs = body.ttl_ms ?? DEFAULT_TTL_MS;
      const row = this.getLockRow();

      // Check if lock is held by someone else and not expired
      if (row.holder !== null && row.holder !== body.caller_id && (row.expires_at ?? 0) > nowMs) {
        return Response.json({ acquired: false, holder: row.holder });
      }

      // Acquire (or re-acquire if caller already holds it or lock expired)
      const expiresAt = nowMs + ttlMs;
      this.ctx.storage.sql.exec(
        `UPDATE lock_state SET holder = ?, expires_at = ? WHERE id = 1`,
        body.caller_id,
        expiresAt
      );

      // Set alarm to auto-expire the lock
      await this.ctx.storage.setAlarm(expiresAt);

      return Response.json({ acquired: true });
    }

    if (request.method === "POST" && url.pathname === "/release") {
      const body = await request.json<{ caller_id: string }>();
      if (!body.caller_id) {
        return Response.json({ error: "caller_id required" }, { status: 400 });
      }
      const row = this.getLockRow();

      if (row.holder !== body.caller_id) {
        return Response.json({ released: false, reason: "caller does not hold the lock" });
      }

      this.ctx.storage.sql.exec(
        `UPDATE lock_state SET holder = NULL, expires_at = NULL WHERE id = 1`
      );
      await this.ctx.storage.deleteAlarm();
      return Response.json({ released: true });
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  }

  override async alarm(): Promise<void> {
    this.ensureInit();
    const nowMs = Date.now();
    const row = this.getLockRow();
    // Only clear if TTL has actually elapsed
    if (row.holder !== null && (row.expires_at ?? 0) <= nowMs) {
      this.ctx.storage.sql.exec(
        `UPDATE lock_state SET holder = NULL, expires_at = NULL WHERE id = 1`
      );
    }
  }

  private getLockRow(): { holder: string | null; expires_at: number | null } {
    const rows = this.ctx.storage.sql
      .exec(`SELECT holder, expires_at FROM lock_state WHERE id = 1`)
      .toArray() as { holder: string | null; expires_at: number | null }[];
    return rows[0] ?? { holder: null, expires_at: null };
  }
}
