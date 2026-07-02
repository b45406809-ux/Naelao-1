import { describe, it, expect } from "vitest";
import routerWorker from "../../workers/router/src/index.js";
import { signJwt } from "@naelao/auth";

// F15: api.all("/spaces/*") and api.all("/spaces") were registered BEFORE the more specific
// /spaces/:spaceId/kb/*, /credentials, /sessions*, /bootstrap/*, /projects/from-template, and
// /channels/* routes. Hono dispatches to the first matching handler in registration order, and
// none of the proxy handlers call next() — so the catch-all always won and every one of those
// requests was misrouted to SPACES_WORKER instead of KNOWLEDGE_WORKER/CREDENTIALS_WORKER/
// AGENTS_WORKER. Fixed by moving the two catch-alls below every specific /spaces/:spaceId/...
// route. This test locks in correct dispatch for one representative request per target worker.

const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const JWT_SECRET = "test-jwt-secret";

function namedFetcher(name: string): Fetcher {
  return { fetch: async () => Response.json({ worker: name }) } as unknown as Fetcher;
}

function makeEnv() {
  return {
    ENVIRONMENT: "test",
    JWT_SECRET,
    PLATFORM_SECRET: "test-platform-secret",
    SPACES_WORKER: namedFetcher("SPACES"),
    KNOWLEDGE_WORKER: namedFetcher("KNOWLEDGE"),
    AGENTS_WORKER: namedFetcher("AGENTS"),
    CREDENTIALS_WORKER: namedFetcher("CREDENTIALS"),
  };
}

async function authedFetch(method: string, path: string, env: unknown) {
  const token = await signJwt(
    { sub: "user-1", tid: "tenant-1", email: "u@example.com", role: "owner", scopes: [] },
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
    const res = await authedFetch("GET", "/v1/spaces/s1/kb/documents", makeEnv());
    expect(await res.json()).toEqual({ worker: "KNOWLEDGE" });
  });

  it("GET /v1/spaces/s1/credentials → CREDENTIALS_WORKER", async () => {
    const res = await authedFetch("GET", "/v1/spaces/s1/credentials", makeEnv());
    expect(await res.json()).toEqual({ worker: "CREDENTIALS" });
  });

  it("POST /v1/spaces/s1/sessions → AGENTS_WORKER", async () => {
    const res = await authedFetch("POST", "/v1/spaces/s1/sessions", makeEnv());
    expect(await res.json()).toEqual({ worker: "AGENTS" });
  });

  it("POST /v1/spaces/s1/channels/slack/connect → AGENTS_WORKER", async () => {
    const res = await authedFetch("POST", "/v1/spaces/s1/channels/slack/connect", makeEnv());
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
});
