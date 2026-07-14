// G-J01: Sliding window rate limiter using Durable Objects
// KV is eventually consistent (~60s) — DO NOT use KV for rate limiting
import { DurableObject } from "cloudflare:workers";

interface RateLimitRequest {
  key: string;
  limit: number;
  windowMs: number;
}

interface RateLimitResponse {
  allowed: boolean;
  remaining: number;
  retryAfterMs?: number;
}

// Sliding window rate limiter DO
// DO name encodes the rate limit key: rl:{identifier}
// e.g. rl:ip:1.2.3.4  or  rl:tenant:abc123
export class RateLimiterDO extends DurableObject {
  private initialized = false;

  private ensureInit(): void {
    if (this.initialized) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS hits (
        ts INTEGER NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_hits_ts ON hits(ts)
    `);
    this.initialized = true;
  }

  override async fetch(request: Request): Promise<Response> {
    this.ensureInit();

    const body = await request.json<RateLimitRequest>();
    const { limit, windowMs } = body;

    const now = Date.now();
    const windowStart = now - windowMs;

    // Delete hits older than the window
    this.ctx.storage.sql.exec("DELETE FROM hits WHERE ts < ?", windowStart);

    // Count remaining hits in window
    const countResult = this.ctx.storage.sql.exec("SELECT COUNT(*) AS cnt FROM hits");
    const rows = [...countResult];
    const count = (rows[0] as { cnt: number } | undefined)?.cnt ?? 0;

    if (count < limit) {
      // Insert current hit timestamp
      this.ctx.storage.sql.exec("INSERT INTO hits (ts) VALUES (?)", now);

      const response: RateLimitResponse = {
        allowed: true,
        remaining: limit - count - 1,
      };
      return new Response(JSON.stringify(response), {
        headers: { "Content-Type": "application/json" },
      });
    } else {
      // Find the oldest hit to calculate retry-after
      const oldestResult = this.ctx.storage.sql.exec(
        "SELECT MIN(ts) AS oldest FROM hits"
      );
      const oldestRows = [...oldestResult];
      const oldestTs = (oldestRows[0] as { oldest: number | null } | undefined)?.oldest ?? now;
      const retryAfterMs = Math.max(0, oldestTs + windowMs - now);

      const response: RateLimitResponse = {
        allowed: false,
        remaining: 0,
        retryAfterMs,
      };
      return new Response(JSON.stringify(response), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      });
    }
  }
}
