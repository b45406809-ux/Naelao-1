import { Hono } from "hono";
import { cors, requestId, jwtAuth, errorResponse } from "@naelao/http";
import type { NaelaoJwtClaims } from "@naelao/types";

export interface Env {
  ENVIRONMENT: string;
  JWT_SECRET: string;
  PLATFORM_SECRET: string;
  SESSION_REVOCATION: KVNamespace;
  CONFIG: KVNamespace;
  SPACES_WORKER: Fetcher;
  KNOWLEDGE_WORKER: Fetcher;
  AGENTS_WORKER: Fetcher;
  AUTH_WORKER: Fetcher;
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

// Helper: forward to downstream worker with identity headers
function proxyTo(worker: Fetcher, claims: NaelaoJwtClaims | undefined, req: Request): Promise<Response> {
  const headers = new Headers(req.headers);
  if (claims) {
    headers.set("x-naelao-tenant-id", claims.tid);
    headers.set("x-naelao-user-id", claims.sub);
    headers.set("x-naelao-role", claims.role);
    headers.set("x-naelao-scopes", claims.scopes.join(","));
  }
  return worker.fetch(new Request(req.url, {
    method: req.method,
    headers,
    body: req.body,
  }));
}

// Spaces CRUD → spaces worker
api.all("/spaces/*", async (c) => proxyTo(c.env.SPACES_WORKER, c.get("claims"), c.req.raw));
api.all("/spaces", async (c) => proxyTo(c.env.SPACES_WORKER, c.get("claims"), c.req.raw));

// Knowledge (KB) → knowledge worker
api.all("/spaces/:spaceId/kb/*", async (c) =>
  proxyTo(c.env.KNOWLEDGE_WORKER, c.get("claims"), c.req.raw)
);

// Agent sessions + messages → agents worker
api.all("/spaces/:spaceId/sessions/*", async (c) =>
  proxyTo(c.env.AGENTS_WORKER, c.get("claims"), c.req.raw)
);
api.all("/spaces/:spaceId/sessions", async (c) =>
  proxyTo(c.env.AGENTS_WORKER, c.get("claims"), c.req.raw)
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
