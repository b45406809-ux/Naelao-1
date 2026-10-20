// G-AX12: Token bucket rate limiter as a Durable Object.
// Replaces fixed-window counters — avoids boundary burst (N at end + N at start of window).
//
// Token bucket parameters per key:
//   capacity  = burst capacity (default: 2× per-minute rate)
//   rate      = refill rate in tokens/second = limit/60
//
// HTTP interface (internal):
//   POST /check  { key: string, limit: number } → { allowed: boolean, remaining: number, retry_after_ms: number }
//   POST /reset  { key: string }                → 204
//
// F7: the router used to route EVERY request on the platform through idFromName("global-rate-
// limiter") — a single DO serializing all traffic platform-wide. The router now shards by
// calling idFromName(bucketKey) itself, so each key gets its own DO instance and this table
// holds at most one row (this DO's own key). Since buckets were never pruned before (rows
// accumulated forever) and a sharded DO now holds exactly one key, an idle DO can free its
// storage entirely via an alarm instead of needing a sweeper.

import { DurableObject } from "cloudflare:workers";
import { readBoundedRequestBytes, RequestBodyTooLargeError } from "@naelao/http";

interface BucketRow {
  key: string;
  tokens: number;
  last_refill_at: number; // unix ms
  capacity: number;
  rate_per_sec: number;
}

// How long a sharded bucket DO waits with no /check calls before it clears its own storage.
// Reset on every /check, so this only fires after genuine idle time, not mid-burst traffic.
const IDLE_CLEANUP_MS = 10 * 60 * 1000;

export class RateLimitDO extends DurableObject {
  private initialized = false;

  private ensureInit(): void {
    if (this.initialized) return;
    // Do NOT run PRAGMA journal_mode=WAL here — Cloudflare's SQLite-backed DO storage manages
    // its own journal mode and rejects this PRAGMA with "not authorized: SQLITE_AUTH", throwing
    // on every single call to this DO in production (confirmed via a live wrangler tail session
    // against a real deployment; the test suite's SQLite shim doesn't enforce this restriction,
    // so it was never caught by the ~1900 passing unit tests). CLAUDE.md's own DO SQLite Pattern
    // section used to instruct setting this — it does not apply to Cloudflare's real runtime.
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS buckets (
        key           TEXT PRIMARY KEY,
        tokens        REAL NOT NULL,
        last_refill_at INTEGER NOT NULL,
        capacity      REAL NOT NULL,
        rate_per_sec  REAL NOT NULL
      )
    `);
    this.initialized = true;
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.body && request.method !== "GET" && request.method !== "HEAD") {
      try { request = new Request(request, { body: await readBoundedRequestBytes(request, 8 * 1024) }); }
      catch (error) {
        if (error instanceof RequestBodyTooLargeError) return Response.json({ error_code: "request_body_too_large" }, { status: 413 });
        return Response.json({ error_code: "invalid_request_body" }, { status: 400 });
      }
    }
    this.ensureInit();
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/check") {
      const body = await request.json<{ key: string; limit: number }>();
      if (!body.key || !body.limit) {
        return Response.json({ error: "key and limit required" }, { status: 400 });
      }

      // Push the idle-cleanup alarm back on every call — it only actually fires once this
      // (now single-key) DO has seen no traffic for IDLE_CLEANUP_MS.
      await this.ctx.storage.setAlarm(Date.now() + IDLE_CLEANUP_MS);

      const perMinuteLimit = body.limit;
      const capacity = perMinuteLimit * 2; // allow burst up to 2× per-minute limit
      const ratePerSec = perMinuteLimit / 60;
      const nowMs = Date.now();

      // Fetch existing bucket or create default
      const rows = this.ctx.storage.sql
        .exec(`SELECT * FROM buckets WHERE key = ?`, body.key)
        .toArray() as unknown as BucketRow[];

      let bucket = rows[0];
      if (!bucket) {
        // New key — start with full bucket
        bucket = {
          key: body.key,
          tokens: capacity,
          last_refill_at: nowMs,
          capacity,
          rate_per_sec: ratePerSec,
        };
      }

      // Refill tokens based on elapsed time
      const elapsedSec = Math.max(0, (nowMs - bucket.last_refill_at) / 1000);
      const refilled = Math.min(capacity, bucket.tokens + elapsedSec * ratePerSec);

      if (refilled < 1) {
        // Not enough tokens — rate limited
        const retryAfterMs = Math.ceil((1 - refilled) / ratePerSec * 1000);
        this.ctx.storage.sql.exec(
          `INSERT OR REPLACE INTO buckets (key, tokens, last_refill_at, capacity, rate_per_sec)
           VALUES (?, ?, ?, ?, ?)`,
          body.key, refilled, nowMs, capacity, ratePerSec
        );
        return Response.json({ allowed: false, remaining: 0, retry_after_ms: retryAfterMs });
      }

      const newTokens = refilled - 1;
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO buckets (key, tokens, last_refill_at, capacity, rate_per_sec)
         VALUES (?, ?, ?, ?, ?)`,
        body.key, newTokens, nowMs, capacity, ratePerSec
      );

      return Response.json({
        allowed: true,
        remaining: Math.floor(newTokens),
        retry_after_ms: 0,
      });
    }

    if (request.method === "POST" && url.pathname === "/reset") {
      const body = await request.json<{ key: string }>();
      if (body.key) {
        this.ctx.storage.sql.exec(`DELETE FROM buckets WHERE key = ?`, body.key);
      }
      return new Response(null, { status: 204 });
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  }

  // Fires only after IDLE_CLEANUP_MS with no /check calls (each call reschedules it) — frees
  // this bucket's storage since a sharded DO holds exactly one key's row.
  override async alarm(): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM buckets");
  }
}
