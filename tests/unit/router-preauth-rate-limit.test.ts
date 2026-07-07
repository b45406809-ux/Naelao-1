import { describe, it, expect } from "vitest";
import routerWorker from "../../workers/router/src/index.js";

// Security audit follow-up: the authenticated `api` group's rate limiter (G-AX12 / F7) only
// covers routes registered AFTER it in the middleware chain. Every unauthenticated route
// (end-users/signup, end-users/login, request-password-reset, reset-password, by-slug,
// shell/manifest) is registered BEFORE that group and had no throttling at all — unlimited
// password-guessing against login, unlimited free-credit-farming against signup. This exercises
// the new pre-auth limiter that closes that gap.

const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function namedFetcher(name: string): Fetcher {
  return { fetch: async () => Response.json({ worker: name }) } as unknown as Fetcher;
}

function makeRateLimitDoNamespace(allowed: boolean) {
  const idFromNameCalls: string[] = [];
  const namespace = {
    idFromName(name: string) {
      idFromNameCalls.push(name);
      return { toString: () => name } as unknown as DurableObjectId;
    },
    get(_id: DurableObjectId) {
      return {
        async fetch() {
          return Response.json({ allowed, remaining: allowed ? 4 : 0, retry_after_ms: allowed ? 0 : 12_000 });
        },
      } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
  return { namespace, idFromNameCalls };
}

function makeEnv(rateLimitDo?: DurableObjectNamespace) {
  return {
    ENVIRONMENT: "test",
    JWT_SECRET: "test-jwt-secret",
    PLATFORM_SECRET: "test-platform-secret",
    SPACES_WORKER: namedFetcher("SPACES"),
    KNOWLEDGE_WORKER: namedFetcher("KNOWLEDGE"),
    AGENTS_WORKER: namedFetcher("AGENTS"),
    CREDENTIALS_WORKER: namedFetcher("CREDENTIALS"),
    AUTH_WORKER: namedFetcher("AUTH"),
    ...(rateLimitDo ? { RATE_LIMIT_DO: rateLimitDo } : {}),
  };
}

describe("router — pre-auth rate limiting on unauthenticated end-user routes", () => {
  it("blocks end-users/login with 429 when the limiter says not allowed", async () => {
    const { namespace } = makeRateLimitDoNamespace(false);
    const res = await routerWorker.fetch(
      new Request("https://router.naelao.com/v1/spaces/prod-1/end-users/login", {
        method: "POST", headers: { "cf-connecting-ip": "203.0.113.9", "content-type": "application/json" },
        body: JSON.stringify({ email: "a@x.com", password: "wrong" }),
      }),
      makeEnv(namespace) as never, execCtx
    );
    expect(res.status).toBe(429);
  });

  it("blocks end-users/signup with 429 when the limiter says not allowed (free-credit farming)", async () => {
    const { namespace } = makeRateLimitDoNamespace(false);
    const res = await routerWorker.fetch(
      new Request("https://router.naelao.com/v1/spaces/prod-1/end-users/signup", {
        method: "POST", headers: { "cf-connecting-ip": "203.0.113.9", "content-type": "application/json" },
        body: JSON.stringify({ email: "a@x.com", password: "hunter22" }),
      }),
      makeEnv(namespace) as never, execCtx
    );
    expect(res.status).toBe(429);
  });

  it("keys the login bucket by cf-connecting-ip, distinct from signup's own bucket", async () => {
    const { namespace, idFromNameCalls } = makeRateLimitDoNamespace(true);
    await routerWorker.fetch(
      new Request("https://router.naelao.com/v1/spaces/prod-1/end-users/login", {
        method: "POST", headers: { "cf-connecting-ip": "203.0.113.9", "content-type": "application/json" },
        body: JSON.stringify({ email: "a@x.com", password: "x" }),
      }),
      makeEnv(namespace) as never, execCtx
    );
    await routerWorker.fetch(
      new Request("https://router.naelao.com/v1/spaces/prod-1/end-users/signup", {
        method: "POST", headers: { "cf-connecting-ip": "203.0.113.9", "content-type": "application/json" },
        body: JSON.stringify({ email: "a@x.com", password: "hunter22" }),
      }),
      makeEnv(namespace) as never, execCtx
    );
    expect(idFromNameCalls).toEqual(["preauth:end-user-login:203.0.113.9", "preauth:end-user-signup:203.0.113.9"]);
  });

  it("allows the request through when the limiter is not wired (RATE_LIMIT_DO absent)", async () => {
    const res = await routerWorker.fetch(
      new Request("https://router.naelao.com/v1/spaces/prod-1/end-users/login", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "a@x.com", password: "x" }),
      }),
      makeEnv() as never, execCtx
    );
    // No RATE_LIMIT_DO → proxied straight through to SPACES_WORKER (the stub above).
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ worker: "SPACES" });
  });

  it("also rate limits by-slug and shell/manifest reads", async () => {
    const { namespace: slugNs } = makeRateLimitDoNamespace(false);
    const slugRes = await routerWorker.fetch(
      new Request("https://router.naelao.com/v1/products/by-slug/acme", { headers: { "cf-connecting-ip": "203.0.113.9" } }),
      makeEnv(slugNs) as never, execCtx
    );
    expect(slugRes.status).toBe(429);

    const { namespace: manifestNs } = makeRateLimitDoNamespace(false);
    const manifestRes = await routerWorker.fetch(
      new Request("https://router.naelao.com/v1/spaces/prod-1/shell/manifest", { headers: { "cf-connecting-ip": "203.0.113.9" } }),
      makeEnv(manifestNs) as never, execCtx
    );
    expect(manifestRes.status).toBe(429);
  });

  it("fails CLOSED when the rate limiter DO itself errors — unlike the authenticated limiter, a pre-auth credential-guessing oracle must not open up on a limiter outage", async () => {
    const namespace = {
      idFromName(name: string) { return { toString: () => name } as unknown as DurableObjectId; },
      get() {
        return { async fetch() { throw new Error("DO unavailable"); } } as unknown as DurableObjectStub;
      },
    } as unknown as DurableObjectNamespace;

    const res = await routerWorker.fetch(
      new Request("https://router.naelao.com/v1/spaces/prod-1/end-users/login", {
        method: "POST", headers: { "cf-connecting-ip": "203.0.113.9", "content-type": "application/json" },
        body: JSON.stringify({ email: "a@x.com", password: "x" }),
      }),
      makeEnv(namespace) as never, execCtx
    );
    expect(res.status).toBe(429);
  });
});

describe("router — pre-auth rate limiting on /v1/auth/* (builder login/register/password-reset)", () => {
  it("blocks builder login with 429 when the limiter says not allowed (this used to be completely unthrottled)", async () => {
    const { namespace } = makeRateLimitDoNamespace(false);
    const res = await routerWorker.fetch(
      new Request("https://router.naelao.com/v1/auth/login", {
        method: "POST", headers: { "cf-connecting-ip": "203.0.113.9", "content-type": "application/json" },
        body: JSON.stringify({ email: "a@x.com", password: "wrong" }),
      }),
      makeEnv(namespace) as never, execCtx
    );
    expect(res.status).toBe(429);
  });

  it("blocks builder register with 429 when the limiter says not allowed (this used to be completely unthrottled)", async () => {
    const { namespace } = makeRateLimitDoNamespace(false);
    const res = await routerWorker.fetch(
      new Request("https://router.naelao.com/v1/auth/register", {
        method: "POST", headers: { "cf-connecting-ip": "203.0.113.9", "content-type": "application/json" },
        body: JSON.stringify({ email: "a@x.com", password: "hunter22" }),
      }),
      makeEnv(namespace) as never, execCtx
    );
    expect(res.status).toBe(429);
  });

  it("blocks builder request-password-reset with 429 when the limiter says not allowed", async () => {
    const { namespace } = makeRateLimitDoNamespace(false);
    const res = await routerWorker.fetch(
      new Request("https://router.naelao.com/v1/auth/request-password-reset", {
        method: "POST", headers: { "cf-connecting-ip": "203.0.113.9", "content-type": "application/json" },
        body: JSON.stringify({ email: "a@x.com" }),
      }),
      makeEnv(namespace) as never, execCtx
    );
    expect(res.status).toBe(429);
  });

  it("blocks builder reset-password with 429 when the limiter says not allowed", async () => {
    const { namespace } = makeRateLimitDoNamespace(false);
    const res = await routerWorker.fetch(
      new Request("https://router.naelao.com/v1/auth/reset-password", {
        method: "POST", headers: { "cf-connecting-ip": "203.0.113.9", "content-type": "application/json" },
        body: JSON.stringify({ token: "t", new_password: "hunter222" }),
      }),
      makeEnv(namespace) as never, execCtx
    );
    expect(res.status).toBe(429);
  });

  it("keys builder-login and builder-register in distinct buckets", async () => {
    const { namespace, idFromNameCalls } = makeRateLimitDoNamespace(true);
    await routerWorker.fetch(
      new Request("https://router.naelao.com/v1/auth/login", {
        method: "POST", headers: { "cf-connecting-ip": "203.0.113.9", "content-type": "application/json" },
        body: JSON.stringify({ email: "a@x.com", password: "x" }),
      }),
      makeEnv(namespace) as never, execCtx
    );
    await routerWorker.fetch(
      new Request("https://router.naelao.com/v1/auth/register", {
        method: "POST", headers: { "cf-connecting-ip": "203.0.113.9", "content-type": "application/json" },
        body: JSON.stringify({ email: "a@x.com", password: "hunter22" }),
      }),
      makeEnv(namespace) as never, execCtx
    );
    expect(idFromNameCalls).toEqual(["preauth:builder-login:203.0.113.9", "preauth:builder-register:203.0.113.9"]);
  });

  it("still forwards to the auth worker when the limiter allows it through", async () => {
    const { namespace } = makeRateLimitDoNamespace(true);
    const res = await routerWorker.fetch(
      new Request("https://router.naelao.com/v1/auth/login", {
        method: "POST", headers: { "cf-connecting-ip": "203.0.113.9", "content-type": "application/json" },
        body: JSON.stringify({ email: "a@x.com", password: "x" }),
      }),
      makeEnv(namespace) as never, execCtx
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ worker: "AUTH" });
  });
});
