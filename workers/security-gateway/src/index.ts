import { Hono } from "hono";
import { RateLimiterDO, wafMiddleware, securityHeaders } from "@naelao/security";
import { errorResponse, tooManyRequests } from "@naelao/http";

export { RateLimiterDO };

interface SecurityEnv {
  ENVIRONMENT: string;
  PLATFORM_SECRET: string;
  PLATFORM_DB: D1Database;
  RATE_LIMITER: DurableObjectNamespace;
  ROUTER_WORKER: Fetcher;
  RATE_LIMIT_GLOBAL: string;
  RATE_LIMIT_AUTH: string;
  RATE_LIMIT_TENANT: string;
}

// Private IP ranges that must not be fetched by tools
const PRIVATE_RANGES = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^::1$/,
  /^fc00:/i,
  /^fe80:/i,
];

function isPrivateIp(ip: string): boolean {
  return PRIVATE_RANGES.some((r) => r.test(ip));
}

async function checkRateLimit(
  ns: DurableObjectNamespace,
  key: string,
  limit: number,
  windowMs: number
): Promise<{ allowed: boolean; retryAfterMs?: number }> {
  const doId = ns.idFromName(`rl:${key}`);
  const stub = ns.get(doId);
  const res = await stub.fetch("http://rl/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, limit, windowMs }),
  });
  const data = await res.json<{ allowed: boolean; retryAfterMs?: number }>();
  return data;
}

const app = new Hono<{ Bindings: SecurityEnv }>();

// Security headers on all responses
app.use("*", securityHeaders());

// WAF scan on all requests
app.use("*", wafMiddleware());

// Rate limit + proxy
app.all("*", async (c) => {
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const path = new URL(c.req.url).pathname;
  const tenantId = c.req.header("x-naelao-tenant-id");

  const globalLimit = Number(c.env.RATE_LIMIT_GLOBAL) || 1000;
  const authLimit = Number(c.env.RATE_LIMIT_AUTH) || 10;
  const tenantLimit = Number(c.env.RATE_LIMIT_TENANT) || 500;
  const windowMs = 60_000; // 1 minute

  // 1. IP-level global rate limit
  if (!isPrivateIp(ip)) {
    const globalCheck = await checkRateLimit(c.env.RATE_LIMITER, `ip:${ip}`, globalLimit, windowMs);
    if (!globalCheck.allowed) {
      const retryAfter = Math.ceil((globalCheck.retryAfterMs ?? windowMs) / 1000);
      return c.json(
        { error_code: "rate_limited", message: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(retryAfter) } }
      );
    }
  }

  // 2. Stricter limit for auth endpoints
  if (path.startsWith("/v1/auth/")) {
    const authCheck = await checkRateLimit(c.env.RATE_LIMITER, `auth:${ip}`, authLimit, windowMs);
    if (!authCheck.allowed) {
      const retryAfter = Math.ceil((authCheck.retryAfterMs ?? windowMs) / 1000);
      return c.json(
        { error_code: "rate_limited", message: "Too many authentication attempts" },
        { status: 429, headers: { "Retry-After": String(retryAfter) } }
      );
    }
  }

  // 3. Per-tenant limit for authenticated requests
  if (tenantId) {
    const tenantCheck = await checkRateLimit(
      c.env.RATE_LIMITER,
      `tenant:${tenantId}`,
      tenantLimit,
      windowMs
    );
    if (!tenantCheck.allowed) {
      const retryAfter = Math.ceil((tenantCheck.retryAfterMs ?? windowMs) / 1000);
      return c.json(
        { error_code: "rate_limited", message: "Tenant rate limit exceeded" },
        { status: 429, headers: { "Retry-After": String(retryAfter) } }
      );
    }
  }

  // Forward to router worker
  return c.env.ROUTER_WORKER.fetch(c.req.raw);
});

app.onError((err, c) => errorResponse(err, c.req.header("x-request-id") ?? "unknown"));

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<SecurityEnv>;
