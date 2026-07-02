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

import { DurableObject } from "cloudflare:workers";

interface BucketRow {
  key: string;
  tokens: number;
  last_refill_at: number; // unix ms
  capacity: number;
  rate_per_sec: number;
}

export class RateLimitDO extends DurableObject {
  private initialized = false;

  private ensureInit(): void {
    if (this.initialized) return;
    this.ctx.storage.sql.exec("PRAGMA journal_mode=WAL");
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
    this.ensureInit();
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/check") {
      const body = await request.json<{ key: string; limit: number }>();
      if (!body.key || !body.limit) {
        return Response.json({ error: "key and limit required" }, { status: 400 });
      }

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
}
