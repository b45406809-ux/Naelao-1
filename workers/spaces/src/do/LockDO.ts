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
import { readBoundedRequestBytes, RequestBodyTooLargeError } from "@naelao/http";

const DEFAULT_TTL_MS = 30_000;
const MIN_TTL_MS = 1_000;
const MAX_TTL_MS = 24 * 60 * 60 * 1_000;
const CALLER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class LockDO extends DurableObject {
  private initialized = false;

  private ensureInit(): void {
    if (this.initialized) return;
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
    if (request.body && request.method !== "GET" && request.method !== "HEAD") {
      try { request = new Request(request, { body: await readBoundedRequestBytes(request, 16 * 1024) }); }
      catch (error) {
        if (error instanceof RequestBodyTooLargeError) return Response.json({ error_code: "request_body_too_large" }, { status: 413 });
        return Response.json({ error_code: "invalid_request_body" }, { status: 400 });
      }
    }
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
      const body = await request.json<unknown>().catch(() => null);
      if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ error: "invalid_request" }, { status: 400 });
      const input = body as { caller_id?: unknown; ttl_ms?: unknown };
      if (typeof input.caller_id !== "string" || !CALLER_ID_PATTERN.test(input.caller_id)) {
        return Response.json({ error: "caller_id required" }, { status: 400 });
      }
      const ttlMs = input.ttl_ms ?? DEFAULT_TTL_MS;
      if (typeof ttlMs !== "number" || !Number.isSafeInteger(ttlMs) || ttlMs < MIN_TTL_MS || ttlMs > MAX_TTL_MS) {
        return Response.json({ error: "invalid_ttl_ms" }, { status: 400 });
      }
      const row = this.getLockRow();

      // Check if lock is held by someone else and not expired
      if (row.holder !== null && row.holder !== input.caller_id && (row.expires_at ?? 0) > nowMs) {
        return Response.json({ acquired: false, holder: row.holder });
      }

      // Acquire (or re-acquire if caller already holds it or lock expired)
      const expiresAt = nowMs + ttlMs;
      this.ctx.storage.sql.exec(
        `UPDATE lock_state SET holder = ?, expires_at = ? WHERE id = 1`,
        input.caller_id,
        expiresAt
      );

      // Set alarm to auto-expire the lock
      await this.ctx.storage.setAlarm(expiresAt);

      return Response.json({ acquired: true });
    }

    if (request.method === "POST" && url.pathname === "/release") {
      const body = await request.json<unknown>().catch(() => null);
      if (!body || typeof body !== "object" || Array.isArray(body) ||
          typeof (body as { caller_id?: unknown }).caller_id !== "string" ||
          !CALLER_ID_PATTERN.test((body as { caller_id: string }).caller_id)) {
        return Response.json({ error: "caller_id required" }, { status: 400 });
      }
      const callerId = (body as { caller_id: string }).caller_id;
      const row = this.getLockRow();

      if (row.holder !== callerId) {
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
      await this.ctx.storage.deleteAlarm();
    } else if (row.holder !== null && row.expires_at !== null) {
      // An older renewal alarm can race a newer acquire. If it fires early, keep
      // the current lease alive by restoring the alarm for the persisted expiry.
      await this.ctx.storage.setAlarm(row.expires_at);
    }
  }

  private getLockRow(): { holder: string | null; expires_at: number | null } {
    const rows = this.ctx.storage.sql
      .exec(`SELECT holder, expires_at FROM lock_state WHERE id = 1`)
      .toArray() as { holder: string | null; expires_at: number | null }[];
    return rows[0] ?? { holder: null, expires_at: null };
  }
}
