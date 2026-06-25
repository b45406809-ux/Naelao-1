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
  PLATFORM_DB: D1Database;
  SPACES_WORKER: Fetcher;
  KNOWLEDGE_WORKER: Fetcher;
  AGENTS_WORKER: Fetcher;
  AUTH_WORKER: Fetcher;
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
