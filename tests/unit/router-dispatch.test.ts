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
//
// Three-Tier Platform Model, Phase 6: the original F15 fix asserted plain "POST /sessions" (no
// sub-path) went to AGENTS_WORKER — that was true for THIS test's stub (which answers any path),
// but AGENTS_WORKER's real handler never implemented bare session/message CRUD at all — only
// its /agent/run, /agent/runs/*, and /approvals/* sub-paths exist there. Session CREATE and
// message GET/POST are actually implemented in SPACES_WORKER (forwarded to SpaceDO — see its
// "SpaceDO session proxy" comment). Updated the split: bare /sessions[/*] → SPACES_WORKER, the
// agent-run/approvals sub-paths → AGENTS_WORKER (registered first so they win over the general
// catch-all, same F15 reasoning).

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

  it("POST /v1/spaces/s1/sessions → SPACES_WORKER (session CRUD lives on SpaceDO)", async () => {
    const res = await authedFetch("POST", "/v1/spaces/s1/sessions", makeEnv());
    expect(await res.json()).toEqual({ worker: "SPACES" });
  });

  it("POST /v1/spaces/s1/sessions/sess1/messages → SPACES_WORKER", async () => {
    const res = await authedFetch("POST", "/v1/spaces/s1/sessions/sess1/messages", makeEnv());
    expect(await res.json()).toEqual({ worker: "SPACES" });
  });

  it("POST /v1/spaces/s1/sessions/sess1/agent/run → AGENTS_WORKER", async () => {
    const res = await authedFetch("POST", "/v1/spaces/s1/sessions/sess1/agent/run", makeEnv());
    expect(await res.json()).toEqual({ worker: "AGENTS" });
  });

  it("GET /v1/spaces/s1/sessions/sess1/agent/runs/run1/stream → AGENTS_WORKER", async () => {
    const res = await authedFetch("GET", "/v1/spaces/s1/sessions/sess1/agent/runs/run1/stream", makeEnv());
    expect(await res.json()).toEqual({ worker: "AGENTS" });
  });

  it("PUT /v1/spaces/s1/sessions/sess1/approvals/a1/approve → AGENTS_WORKER", async () => {
    const res = await authedFetch("PUT", "/v1/spaces/s1/sessions/sess1/approvals/a1/approve", makeEnv());
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

  it("POST /v1/spaces/s1/end-users/signup → SPACES_WORKER, with NO auth at all (Phase 6)", async () => {
    const res = await routerWorker.fetch(
      new Request("https://router.naelao.com/v1/spaces/s1/end-users/signup", { method: "POST" }),
      makeEnv() as never, execCtx
    );
    expect(await res.json()).toEqual({ worker: "SPACES" });
  });
});
