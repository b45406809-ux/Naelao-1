import { Hono } from "hono";
import { cors, requestId, jwtAuth, errorResponse } from "@naelao/http";
import { signHmac } from "@naelao/crypto";
import type { NaelaoJwtClaims } from "@naelao/types";

export interface Env {
  ENVIRONMENT: string;
  JWT_SECRET: string;
  PLATFORM_SECRET: string;
  SESSION_REVOCATION: KVNamespace;
  CONFIG: KVNamespace;
  NONCE_STORE: KVNamespace;
  PLATFORM_DB: D1Database;
  SPACES_WORKER: Fetcher;
  KNOWLEDGE_WORKER: Fetcher;
  AGENTS_WORKER: Fetcher;
  AUTH_WORKER: Fetcher;
}

// G-AX27: Replay attack prevention — max clock skew in seconds
const MAX_TIMESTAMP_SKEW_S = 300;

// ── G-AX27: validate timestamp and track nonce to prevent replay attacks ──────
async function checkReplayPrevention(
  request: Request,
  nonceStore: KVNamespace
): Promise<{ ok: boolean; reason?: string }> {
  const tsHeader = request.headers.get("x-naelao-timestamp");
  if (!tsHeader) return { ok: true }; // header optional for unauthenticated routes

  const ts = parseInt(tsHeader, 10);
  if (isNaN(ts)) return { ok: false, reason: "x-naelao-timestamp must be a unix epoch integer" };

  const nowS = Math.floor(Date.now() / 1000);
  if (Math.abs(nowS - ts) > MAX_TIMESTAMP_SKEW_S) {
    return { ok: false, reason: `Request timestamp is outside ±${MAX_TIMESTAMP_SKEW_S}s window` };
  }

  // Nonce check (best-effort — KV eventual consistency ~60s, but catches most replays)
  const nonceHeader = request.headers.get("x-naelao-nonce");
  if (nonceHeader) {
    const nonceKey = `nonce:${nonceHeader}`;
    const existing = await nonceStore.get(nonceKey);
    if (existing !== null) {
      return { ok: false, reason: "Request nonce has already been used (replay detected)" };
    }
    // Store nonce with TTL slightly longer than the allowed skew window
    await nonceStore.put(nonceKey, "1", { expirationTtl: MAX_TIMESTAMP_SKEW_S + 60 });
  }

  return { ok: true };
}

// G-AD02: In-memory per-user token version cache (5s TTL)
// Map key: userId, value: { version, expiresAt }
const tokenVersionCache = new Map<string, { version: number; expiresAt: number }>();
const TOKEN_VERSION_CACHE_TTL_MS = 5_000;

async function checkTokenVersion(
  db: D1Database,
  userId: string,
  claimedVersion: number
): Promise<boolean> {
  const cached = tokenVersionCache.get(userId);
  let currentVersion: number;

  if (cached && Date.now() < cached.expiresAt) {
    currentVersion = cached.version;
  } else {
    const row = await db
      .prepare("SELECT token_version FROM users WHERE id = ?1")
      .bind(userId)
      .first<{ token_version: number }>();
    currentVersion = row?.token_version ?? 0;
    tokenVersionCache.set(userId, { version: currentVersion, expiresAt: Date.now() + TOKEN_VERSION_CACHE_TTL_MS });
  }

  return claimedVersion >= currentVersion;
}

// Extend Hono context variables for this worker
declare module "hono" {
  interface ContextVariableMap {
    requestId: string;
    claims: NaelaoJwtClaims;
  }
}

// G-A11: Validate required secrets at startup
function validateEnv(env: Env): void {
  const required = ["JWT_SECRET", "PLATFORM_SECRET"] as const;
  for (const key of required) {
    if (!env[key]) throw new Error(`Missing required secret: ${key}`);
  }
}

const app = new Hono<{ Bindings: Env }>();

// ── Global middleware ────────────────────────────────────────────────────────
app.use("*", cors(["*"]));
app.use("*", requestId);
app.use("*", async (c, next) => { validateEnv(c.env); await next(); });

// ── Health check (unauthenticated) ───────────────────────────────────────────
app.get("/health", (c) =>
  c.json({ status: "ok", env: c.env.ENVIRONMENT, ts: Date.now() })
);

// ── Auth routes (forwarded to auth worker) ───────────────────────────────────
app.all("/v1/auth/*", async (c) => {
  const url = new URL(c.req.url);
  const downstream = new URL(url.pathname.replace("/v1/auth", ""), "http://auth");
  downstream.search = url.search;
  return c.env.AUTH_WORKER.fetch(
    new Request(downstream.toString(), {
      method: c.req.method,
      headers: c.req.raw.headers,
      body: c.req.raw.body,
    })
  );
});

// ── Protected API routes ─────────────────────────────────────────────────────
const api = new Hono<{ Bindings: Env }>();
api.use(
  "*",
  jwtAuth((c) => (c as unknown as { env: Env }).env.JWT_SECRET)
);

// G-AX27: Replay attack prevention — timestamp skew + nonce dedup
api.use("*", async (c, next) => {
  if (c.env.NONCE_STORE) {
    const result = await checkReplayPrevention(c.req.raw, c.env.NONCE_STORE);
    if (!result.ok) {
      return c.json({ error_code: "replay_detected", message: result.reason }, 400);
    }
  }
  return next();
});

// G-AD02: Token version check — reject tokens whose version is behind the DB value.
// Uses 5s in-memory cache to avoid a D1 read on every request.
api.use("*", async (c, next) => {
  const claims = c.get("claims");
  if (claims?.tv !== undefined) {
    const valid = await checkTokenVersion(c.env.PLATFORM_DB, claims.sub, claims.tv);
    if (!valid) {
      return c.json(
        { error_code: "token_revoked", message: "Session has been revoked" },
        401
      );
    }
  }
  return next();
});

// G-I01: Sign inter-worker requests with HMAC so downstream workers can verify origin
async function proxyTo(
  worker: Fetcher,
  claims: NaelaoJwtClaims | undefined,
  req: Request,
  platformSecret: string,
): Promise<Response> {
  const headers = new Headers(req.headers);
  const ts = Date.now().toString();
  if (claims) {
    headers.set("x-naelao-tenant-id", claims.tid);
    headers.set("x-naelao-user-id", claims.sub);
    headers.set("x-naelao-role", claims.role);
    headers.set("x-naelao-scopes", claims.scopes.join(","));
    const sig = await signHmac(`internal:${claims.tid}:${ts}`, platformSecret);
    headers.set("x-naelao-internal-token", `t=${ts},v1=${sig}`);
  }
  return worker.fetch(new Request(req.url, {
    method: req.method,
    headers,
    body: req.body,
  }));
}

// Spaces CRUD → spaces worker
api.all("/spaces/*", async (c) => proxyTo(c.env.SPACES_WORKER, c.get("claims"), c.req.raw, c.env.PLATFORM_SECRET));
api.all("/spaces", async (c) => proxyTo(c.env.SPACES_WORKER, c.get("claims"), c.req.raw, c.env.PLATFORM_SECRET));

// Knowledge (KB) → knowledge worker
api.all("/spaces/:spaceId/kb/*", async (c) =>
  proxyTo(c.env.KNOWLEDGE_WORKER, c.get("claims"), c.req.raw, c.env.PLATFORM_SECRET)
);

// Agent sessions + messages → agents worker
api.all("/spaces/:spaceId/sessions/*", async (c) =>
  proxyTo(c.env.AGENTS_WORKER, c.get("claims"), c.req.raw, c.env.PLATFORM_SECRET)
);
api.all("/spaces/:spaceId/sessions", async (c) =>
  proxyTo(c.env.AGENTS_WORKER, c.get("claims"), c.req.raw, c.env.PLATFORM_SECRET)
);

app.route("/v1", api);

// ── Error handler ────────────────────────────────────────────────────────────
app.onError((err, c) => {
  const reqId = c.get("requestId") ?? "unknown";
  return errorResponse(err, reqId);
});

app.notFound((c) => {
  return c.json(
    { error_code: "not_found", message: "Route not found", request_id: c.get("requestId") },
    404
  );
});

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;
