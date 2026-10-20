import { describe, it, expect } from "vitest";
import spacesWorker from "../../workers/spaces/src/index.js";
import knowledgeWorker from "../../workers/knowledge/src/index.js";
import { mintInternalToken } from "@naelao/http";

// A1.16.9 (layer-3 backstop follow-up): the remaining public /spaces/:id/... and internal/*
// routes called directly (non-router) by NaelaoAgentDO/provisioner/billing/prebuilt-scripts
// now require requireInternalHmac too. This doesn't re-test the middleware itself (see
// packages/http-internal-hmac.test.ts) — it proves the mounting actually took effect on a
// representative sample of the newly-gated routes, using the real worker handlers.

const SECRET = "test-platform-secret";
const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function makeSpacesEnv(): Record<string, unknown> {
  const db = {
    prepare(sql: string) {
      const stmt = {
        bind() { return stmt; },
        async first() {
          if (/FROM spaces WHERE/.test(sql)) return { name: "Test Space", spacetype_id: "launchpad", config_json: "{}", parent_space_id: "product-1" };
          if (/FROM space_members/.test(sql)) return null;
          if (/FROM business_memberships/.test(sql)) return { role: "member" };
          return null;
        },
        async all() { return { results: [] }; },
        async run() { return { meta: { changes: 1 } }; },
      };
      return stmt;
    },
  };
  const kv = { async get() { return null; }, async put() {}, async delete() {} };
  return { PLATFORM_SECRET: SECRET, ENVIRONMENT: "test", PLATFORM_DB: db, NAELAO_CONFIG_KV: kv };
}

describe("spaces worker — newly-gated routes reject forged direct requests", () => {
  it("POST /spaces/:spaceId/projects rejects with no internal token", async () => {
    const res = await spacesWorker.fetch(
      new Request("https://spaces.naelao.com/spaces/space-1/projects", {
        method: "POST",
        headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-1" },
        body: JSON.stringify({ name: "Support" }),
      }),
      makeSpacesEnv() as never,
      execCtx
    );
    expect(res.status).toBe(403);
  });

  it("POST /spaces/:spaceId/projects accepts with a properly minted token", async () => {
    const token = await mintInternalToken(SECRET, "tenant-1");
    const res = await spacesWorker.fetch(
      new Request("https://spaces.naelao.com/spaces/space-1/projects", {
        method: "POST",
        headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token },
        body: JSON.stringify({ name: "Support" }),
      }),
      makeSpacesEnv() as never,
      execCtx
    );
    // Not testing the full downstream flow here (no real SPACE_DO binding in this minimal
    // env) — just that the auth gate itself passed rather than rejecting with 403.
    expect(res.status).not.toBe(403);
  });

  it("GET /spaces/:spaceId/assistant-policy rejects the old-style forged x-naelao-internal header", async () => {
    const res = await spacesWorker.fetch(
      new Request("https://spaces.naelao.com/spaces/space-1/assistant-policy", {
        headers: { "x-naelao-tenant-id": "tenant-1", "x-naelao-internal": "agents" }, // forged, not a real token
      }),
      makeSpacesEnv() as never,
      execCtx
    );
    expect(res.status).toBe(403);
  });

  it("GET /internal/business-services rejects any truthy x-naelao-internal header (the OLD check this replaces)", async () => {
    const res = await spacesWorker.fetch(
      new Request("https://spaces.naelao.com/internal/business-services?space_id=space-1&kind=storefront", {
        headers: { "x-naelao-internal": "anything-at-all" },
      }),
      makeSpacesEnv() as never,
      execCtx
    );
    expect(res.status).toBe(403);
  });

  it("POST /internal/space-types-record-install/:id rejects a static 'provisioner' string (the OLD check this replaces)", async () => {
    const res = await spacesWorker.fetch(
      new Request("https://spaces.naelao.com/internal/space-types-record-install/launchpad", {
        method: "POST",
        headers: { "content-type": "application/json", "x-naelao-internal": "provisioner" },
        body: JSON.stringify({ spaceId: "space-1", version: "1" }),
      }),
      makeSpacesEnv() as never,
      execCtx
    );
    expect(res.status).toBe(403);
  });

  it("POST /internal/space-types-record-install/:id accepts a properly minted token", async () => {
    const token = await mintInternalToken(SECRET, "tenant-1");
    const res = await spacesWorker.fetch(
      new Request("https://spaces.naelao.com/internal/space-types-record-install/launchpad", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-naelao-tenant-id": "tenant-1",
          "x-naelao-internal-token": token,
        },
        body: JSON.stringify({ spaceId: "space-1", version: "1" }),
      }),
      makeSpacesEnv() as never,
      execCtx
    );
    expect(res.status).not.toBe(403);
  });

  // WS-2 (Space Assistant surface, Status panel): GET is now reachable by a signed-in product
  // end user reading their own assistant's permissions — PATCH must never be.
  it("GET /spaces/:spaceId/assistant-policy allows a product_end_user with a valid internal token", async () => {
    const token = await mintInternalToken(SECRET, "tenant-1");
    const res = await spacesWorker.fetch(
      new Request("https://spaces.naelao.com/spaces/space-1/assistant-policy", {
        headers: {
          "x-naelao-tenant-id": "tenant-1",
          "x-naelao-internal-token": token,
          "x-naelao-role": "product_end_user",
          "x-naelao-user-id": "user-42",
        },
      }),
      makeSpacesEnv() as never,
      execCtx
    );
    expect(res.status).not.toBe(403);
  });

  it("PATCH /spaces/:spaceId/assistant-policy rejects a product_end_user even with a valid internal token", async () => {
    const token = await mintInternalToken(SECRET, "tenant-1");
    const res = await spacesWorker.fetch(
      new Request("https://spaces.naelao.com/spaces/space-1/assistant-policy", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-naelao-tenant-id": "tenant-1",
          "x-naelao-internal-token": token,
          "x-naelao-role": "product_end_user",
          "x-naelao-user-id": "user-42",
        },
        body: JSON.stringify({ approval_mode: "yolo" }),
      }),
      makeSpacesEnv() as never,
      execCtx
    );
    expect(res.status).toBe(403);
  });
});

// Bucket A/B (following up on the deferred routes): builder-only team surfaces (members,
// agent-definitions, threads) and the end-user chat transport (sessions) — investigated first
// (apps/widget + apps/portal grepped for direct callers) before gating.
describe("spaces worker — bucket A/B routes (members, agent-definitions, threads, sessions)", () => {
  it("GET /spaces/:spaceId/members rejects with no internal token", async () => {
    const res = await spacesWorker.fetch(
      new Request("https://spaces.naelao.com/spaces/space-1/members", {
        headers: { "x-naelao-tenant-id": "tenant-1" },
      }),
      makeSpacesEnv() as never,
      execCtx
    );
    expect(res.status).toBe(403);
  });

  it("GET /spaces/:spaceId/agent-definitions rejects with no internal token", async () => {
    const res = await spacesWorker.fetch(
      new Request("https://spaces.naelao.com/spaces/space-1/agent-definitions", {
        headers: { "x-naelao-tenant-id": "tenant-1" },
      }),
      makeSpacesEnv() as never,
      execCtx
    );
    expect(res.status).toBe(403);
  });

  it("GET /spaces/:spaceId/threads rejects with no internal token", async () => {
    const res = await spacesWorker.fetch(
      new Request("https://spaces.naelao.com/spaces/space-1/threads", {
        headers: { "x-naelao-tenant-id": "tenant-1" },
      }),
      makeSpacesEnv() as never,
      execCtx
    );
    expect(res.status).toBe(403);
  });

  it("GET /spaces/:spaceId/threads accepts a properly minted token", async () => {
    const token = await mintInternalToken(SECRET, "tenant-1");
    const res = await spacesWorker.fetch(
      new Request("https://spaces.naelao.com/spaces/space-1/threads", {
        headers: { "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token },
      }),
      makeSpacesEnv() as never,
      execCtx
    );
    expect(res.status).not.toBe(403);
  });

  it("POST /spaces/:spaceId/sessions/:id/messages rejects with no internal token (the currently-broken end-user chat path)", async () => {
    const res = await spacesWorker.fetch(
      new Request("https://spaces.naelao.com/spaces/space-1/sessions/sess-1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-1" },
        body: JSON.stringify({ role: "user", content: "hi" }),
      }),
      makeSpacesEnv() as never,
      execCtx
    );
    expect(res.status).toBe(403);
  });

  it("POST /spaces/:spaceId/sessions/:id/messages accepts a properly minted token (NaelaoAgentDO's writeConversationToSession shape)", async () => {
    const token = await mintInternalToken(SECRET, "tenant-1");
    const res = await spacesWorker.fetch(
      new Request("https://spaces.naelao.com/spaces/space-1/sessions/sess-1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token },
        body: JSON.stringify({ role: "user", content: "hi" }),
      }),
      makeSpacesEnv() as never,
      execCtx
    );
    expect(res.status).not.toBe(403);
  });
});

describe("knowledge worker — kb/* routes (bucket A) now require a token", () => {
  it("GET /spaces/:spaceId/kb/search rejects with no internal token", async () => {
    const res = await knowledgeWorker.fetch(
      new Request("https://knowledge.naelao.com/spaces/space-1/kb/search?q=hello", {
        headers: { "x-naelao-tenant-id": "tenant-1" },
      }),
      { PLATFORM_SECRET: SECRET, ENVIRONMENT: "test" } as never,
      execCtx
    );
    expect(res.status).toBe(403);
  });
});

describe("knowledge worker — semantic-cache routes now require a token (previously NO auth at all)", () => {
  function makeKnowledgeEnv(): Record<string, unknown> {
    return {
      PLATFORM_SECRET: SECRET,
      ENVIRONMENT: "test",
      PLATFORM_DB: {
        prepare() {
          const stmt = { bind() { return stmt; }, async first() { return { config_json: "{}" }; } };
          return stmt;
        },
      },
    };
  }

  it("POST /internal/semantic-cache/lookup rejects an unauthenticated request", async () => {
    const res = await knowledgeWorker.fetch(
      new Request("https://knowledge.naelao.com/internal/semantic-cache/lookup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "hello", spaceId: "space-1" }),
      }),
      makeKnowledgeEnv() as never,
      execCtx
    );
    expect(res.status).toBe(403);
  });

  it("POST /internal/semantic-cache/lookup accepts a properly minted token", async () => {
    const token = await mintInternalToken(SECRET, "tenant-1");
    const res = await knowledgeWorker.fetch(
      new Request("https://knowledge.naelao.com/internal/semantic-cache/lookup", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-naelao-tenant-id": "tenant-1",
          "x-naelao-internal-token": token,
        },
        body: JSON.stringify({ query: "hello", spaceId: "space-1" }),
      }),
      makeKnowledgeEnv() as never,
      execCtx
    );
    // No SEMANTIC_CACHE_VECTORS binding in this minimal env -> the route itself fails open
    // with { hit: false } rather than a real cache lookup; the point is it's not a 403.
    expect(res.status).not.toBe(403);
  });
});
