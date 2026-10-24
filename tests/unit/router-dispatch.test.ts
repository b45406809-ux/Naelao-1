import { signJwt } from "@naelao/auth";
import { describe, expect, it } from "vitest";
import routerWorker from "../../workers/router/src/index.js";
import { clearTenantStatusCacheForTests } from "../../workers/router/src/tenant-status.js";
import { activeTenantDb } from "./helpers/active-tenant-db.js";

// F15: api.all("/spaces/*") and api.all("/spaces") were registered BEFORE the more specific
// /spaces/:spaceId/kb/*, /credentials, /sessions*, /bootstrap/*, /projects/from-template, and
// /channels/* routes. Hono dispatches to the first matching handler in registration order, and
// none of the proxy handlers call next() — so the catch-all always won and every one of those
// requests was misrouted to SPACES_WORKER instead of KNOWLEDGE_WORKER/CREDENTIALS_WORKER/
// AGENTS_WORKER. Fixed by moving the two catch-alls below every specific /spaces/:spaceId/...
// route. This test locks in correct dispatch for one representative request per target worker.
//
// Three-Tier Platform Model, Phase 6: the original F15 fix asserted plain "POST /sessions" (no
// sub-path) went to AGENTS_WORKER — that was true for THIS test's stub (which answers any path),
// but AGENTS_WORKER's real handler never implemented bare session/message CRUD at all — only
// its /agent/run, /agent/runs/*, and /approvals/* sub-paths exist there. Session CREATE and
// message GET/POST are actually implemented in SPACES_WORKER (forwarded to SpaceDO — see its
// "SpaceDO session proxy" comment). Updated the split: bare /sessions[/*] → SPACES_WORKER, the
// agent-run/approvals sub-paths → AGENTS_WORKER (registered first so they win over the general
// catch-all, same F15 reasoning).

const execCtx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;
const JWT_SECRET = "test-jwt-secret";

function namedFetcher(name: string): Fetcher {
  return {
    fetch: async () => Response.json({ worker: name }),
  } as unknown as Fetcher;
}

const allowRateLimitNamespace = {
  idFromName: (name: string) => ({ name }) as unknown as DurableObjectId,
  get: () => ({ fetch: async () => Response.json({ allowed: true, remaining: 4, retry_after_ms: 0 }) }) as unknown as DurableObjectStub,
} as unknown as DurableObjectNamespace;

function makeEnv(tenantStatus = "active", resellerStatus = "active") {
  return {
    ENVIRONMENT: "test",
    JWT_SECRET,
    PLATFORM_SECRET: "test-platform-secret",
    PLATFORM_DB: activeTenantDb(tenantStatus, resellerStatus),
    SPACES_WORKER: namedFetcher("SPACES"),
    KNOWLEDGE_WORKER: namedFetcher("KNOWLEDGE"),
    AGENTS_WORKER: namedFetcher("AGENTS"),
    CREDENTIALS_WORKER: namedFetcher("CREDENTIALS"),
    BILLING_WORKER: namedFetcher("BILLING"),
    RATE_LIMIT_DO: allowRateLimitNamespace,
  };
}

async function authedFetch(method: string, path: string, env: unknown) {
  const token = await signJwt(
    {
      sub: "user-1",
      tid: "tenant-1",
      email: "u@example.com",
      role: "owner",
      scopes: [],
    },
    JWT_SECRET
  );
  return routerWorker.fetch(
    new Request(`https://router.naelao.com${path}`, {
      method,
      headers: { authorization: `Bearer ${token}` },
    }),
    env as never,
    execCtx
  );
}

describe("router — /spaces dispatch order (F15)", () => {
  it("GET /v1/spaces/s1/kb/documents → KNOWLEDGE_WORKER", async () => {
    const res = await authedFetch(
      "GET",
      "/v1/spaces/s1/kb/documents",
      makeEnv()
    );
    expect(await res.json()).toEqual({ worker: "KNOWLEDGE" });
  });

  it("rejects all authenticated feature requests for a suspended tenant", async () => {
    clearTenantStatusCacheForTests();
    const res = await authedFetch("GET", "/v1/spaces/s1", makeEnv("suspended"));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error_code: "tenant_suspended" });
    clearTenantStatusCacheForTests();
  });

  it("rejects a signed JWT whose token version is ahead of the persisted revocation epoch", async () => {
    const userId = `future-version-user-${crypto.randomUUID()}`;
    const token = await signJwt({
      sub: userId,
      tid: "tenant-1",
      email: "u@example.com",
      role: "owner",
      scopes: [],
      tv: 2,
    }, JWT_SECRET);
    const response = await routerWorker.fetch(
      new Request("https://router.naelao.com/v1/spaces/s1", {
        headers: { authorization: `Bearer ${token}` },
      }),
      makeEnv() as never,
      execCtx
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error_code: "token_revoked" });
  });

  it("rejects child-tenant requests while its reseller hierarchy is suspended", async () => {
    clearTenantStatusCacheForTests();
    const res = await authedFetch("GET", "/v1/spaces/s1", makeEnv("active", "suspended"));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error_code: "tenant_suspended" });
    clearTenantStatusCacheForTests();
  });

  it("GET /v1/spaces/s1/credentials → CREDENTIALS_WORKER", async () => {
    const res = await authedFetch(
      "GET",
      "/v1/spaces/s1/credentials",
      makeEnv()
    );
    expect(await res.json()).toEqual({ worker: "CREDENTIALS" });
  });

  it("POST /v1/spaces/s1/sessions → SPACES_WORKER (session CRUD lives on SpaceDO)", async () => {
    const res = await authedFetch("POST", "/v1/spaces/s1/sessions", makeEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ worker: "SPACES" });
  });

  it("GET /v1/billing/subscription → BILLING_WORKER (F2 — builder's own plan/quota)", async () => {
    const res = await authedFetch("GET", "/v1/billing/subscription", makeEnv());
    expect(await res.json()).toEqual({ worker: "BILLING" });
  });

  it("POST /v1/billing/checkout → BILLING_WORKER (F2 — builder upgrade)", async () => {
    const res = await authedFetch("POST", "/v1/billing/checkout", makeEnv());
    expect(await res.json()).toEqual({ worker: "BILLING" });
  });

  it("returns 503 for /v1/billing/subscription when BILLING_WORKER isn't bound", async () => {
    const env = makeEnv() as Record<string, unknown>;
    env.BILLING_WORKER = undefined;
    const res = await authedFetch("GET", "/v1/billing/subscription", env);
    expect(res.status).toBe(503);
  });

  it("POST /v1/spaces/s1/sessions/sess1/messages → SPACES_WORKER", async () => {
    const res = await authedFetch(
      "POST",
      "/v1/spaces/s1/sessions/sess1/messages",
      makeEnv()
    );
    expect(await res.json()).toEqual({ worker: "SPACES" });
  });

  it("POST /v1/spaces/s1/sessions/sess1/agent/run → AGENTS_WORKER", async () => {
    const res = await authedFetch(
      "POST",
      "/v1/spaces/s1/sessions/sess1/agent/run",
      makeEnv()
    );
    expect(await res.json()).toEqual({ worker: "AGENTS" });
  });

  it("GET /v1/spaces/s1/sessions/sess1/agent/runs/run1/stream → AGENTS_WORKER", async () => {
    const res = await authedFetch(
      "GET",
      "/v1/spaces/s1/sessions/sess1/agent/runs/run1/stream",
      makeEnv()
    );
    expect(await res.json()).toEqual({ worker: "AGENTS" });
  });

  it("PUT /v1/spaces/s1/sessions/sess1/approvals/a1/approve → AGENTS_WORKER", async () => {
    const res = await authedFetch(
      "PUT",
      "/v1/spaces/s1/sessions/sess1/approvals/a1/approve",
      makeEnv()
    );
    expect(await res.json()).toEqual({ worker: "AGENTS" });
  });

  it("POST /v1/spaces/s1/channels/slack/connect → AGENTS_WORKER", async () => {
    const res = await authedFetch(
      "POST",
      "/v1/spaces/s1/channels/slack/connect",
      makeEnv()
    );
    expect(await res.json()).toEqual({ worker: "AGENTS" });
  });

  it("GET /v1/spaces/s1 → SPACES_WORKER (falls through to the catch-all)", async () => {
    const res = await authedFetch("GET", "/v1/spaces/s1", makeEnv());
    expect(await res.json()).toEqual({ worker: "SPACES" });
  });

  it("GET /v1/spaces → SPACES_WORKER (exact catch-all)", async () => {
    const res = await authedFetch("GET", "/v1/spaces", makeEnv());
    expect(await res.json()).toEqual({ worker: "SPACES" });
  });

  it("POST /v1/spaces/s1/end-users/signup → SPACES_WORKER, with NO auth at all (Phase 6)", async () => {
    const res = await routerWorker.fetch(
      new Request("https://router.naelao.com/v1/spaces/s1/end-users/signup", {
        method: "POST",
      }),
      makeEnv() as never,
      execCtx
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ worker: "SPACES" });
  });

  // F-1: the Builder Dashboard API — every management tab 404'd because the router had no /builder
  // route at all.
  it("POST /v1/builder/products → SPACES_WORKER (F-1)", async () => {
    const res = await authedFetch("POST", "/v1/builder/products", makeEnv());
    expect(await res.json()).toEqual({ worker: "SPACES" });
  });

  it("GET /v1/builder/api-keys → SPACES_WORKER (F-1)", async () => {
    const res = await authedFetch("GET", "/v1/builder/api-keys", makeEnv());
    expect(await res.json()).toEqual({ worker: "SPACES" });
  });
});

// F-2: the Lemon Squeezy webhook — the entire money-in path 404'd because the router never routed
// it. Unauthenticated (LS signature is the auth), proxied to BILLING_WORKER.
describe("router — Lemon Squeezy webhook ingress (F-2)", () => {
  it("POST /v1/webhooks/lemon-squeezy → BILLING_WORKER, with NO JWT", async () => {
    const env = { ...makeEnv(), BILLING_WORKER: namedFetcher("BILLING") };
    const res = await routerWorker.fetch(
      new Request("https://router.naelao.com/v1/webhooks/lemon-squeezy", {
        method: "POST",
        body: "{}",
      }),
      env as never,
      execCtx
    );
    expect(await res.json()).toEqual({ worker: "BILLING" });
  });

  it("returns 503 when the billing worker is not bound", async () => {
    const env = makeEnv() as Record<string, unknown>;
    env.BILLING_WORKER = undefined; // makeEnv now binds BILLING by default (F2); this case needs it absent
    const res = await routerWorker.fetch(
      new Request("https://router.naelao.com/v1/webhooks/lemon-squeezy", {
        method: "POST",
        body: "{}",
      }),
      env as never,
      execCtx
    );
    expect(res.status).toBe(503);
  });
});

// F-STRUCT: route-parity guard — assert the router SOURCE registers a handler for every top-level
// API prefix the dashboard and shell frontends depend on. This is the cheap structural equivalent
// of wrangler-vars-parity.test.ts: it catches the "an entire route group is unrouted" class of bug
// (F-1/F-2/F-3/F-5 were all this) without needing per-endpoint matching. If a frontend starts
// calling a new top-level prefix, add it here AND wire the router — the test forces the pairing.
describe("router — frontend route-parity (F-STRUCT)", () => {
  it("registers a proxy for every top-level API prefix the frontends call", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const routerSrc = readFileSync(
      join(__dirname, "../../workers/router/src/index.ts"),
      "utf8"
    );
    // Prefixes the dashboard (builder) and shell (end-user) clients depend on, each with the
    // registration substring that must exist in the router source.
    const REQUIRED_PREFIXES: Array<[label: string, needle: RegExp]> = [
      ["/builder (dashboard)", /["'`]\/builder\/\*["'`]/],
      ["/spaces (both)", /["'`]\/spaces\/\*["'`]/],
      ["/connectors (dashboard)", /["'`]\/connectors\/\*["'`]/],
      ["/templates (wizard)", /["'`]\/templates\/\*["'`]/],
      ["/products/by-slug (shell)", /\/v1\/products\/by-slug/],
      ["/webhooks/lemon-squeezy (money-in)", /\/v1\/webhooks\/lemon-squeezy/],
      // F2: the builder's own platform subscription surface (Settings page) — was a dead route.
      [
        "/billing/subscription (dashboard settings)",
        /["'`]\/billing\/subscription["'`]/,
      ],
      [
        "/billing/checkout (dashboard settings)",
        /["'`]\/billing\/checkout["'`]/,
      ],
      // The eval worker had NO router route at all, so the benchmark runner
      // (infra/scripts/run-eval-suite.mjs) could never reach a real deployment — exactly the
      // "entire route group is unrouted" class this guard exists to catch.
      ["/evals (eval harness runner)", /["'`]\/evals\/\*["'`]/],
    ];
    const missing = REQUIRED_PREFIXES.filter(
      ([, needle]) => !needle.test(routerSrc)
    ).map(([label]) => label);
    expect(
      missing,
      `router is missing a route for: ${missing.join(", ")}`
    ).toEqual([]);
  });
});
