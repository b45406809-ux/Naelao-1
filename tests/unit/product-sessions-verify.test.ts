import { describe, it, expect } from "vitest";
import spacesWorker from "../../workers/spaces/src/index.js";
import { ProductUserDO } from "../../workers/spaces/src/do/ProductUserDO.js";
import { BuilderAccountDO } from "../../workers/spaces/src/do/BuilderAccountDO.js";
import { SpaceTypeRegistryDO } from "../../workers/spaces/src/do/SpaceTypeRegistryDO.js";
import { createFakeD1 } from "../stubs/d1-sqlite.js";
import { makeStatefulDoNamespace } from "./helpers/fake-do-namespace.js";

// Three-Tier Platform Model, Phase 6: POST /internal/product-sessions/verify is the missing link
// that lets naelao-router resolve a Bearer nps_... ProductUserDO session token into the owning
// tenant BEFORE it can mint router claims for that request — the chicken-and-egg (the router
// doesn't know the tenantId until AFTER verifying) is why this is gated by a direct
// x-naelao-platform-secret check, same precedent as the pre-existing /internal/space-types/seed
// route, not requireInternalHmac (which needs a pre-known tenantId).

const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

const SPACES_TABLE_SQL = `
  CREATE TABLE spaces (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    name TEXT NOT NULL DEFAULT '', spacetype_id TEXT NOT NULL DEFAULT 'launchpad',
    config_json TEXT NOT NULL DEFAULT '{}', parent_space_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')), created_by TEXT
  );
`;

function makeEnv() {
  const fakeDb = createFakeD1([SPACES_TABLE_SQL]);
  return {
    PLATFORM_SECRET: "test-platform-secret",
    ENVIRONMENT: "test",
    PLATFORM_DB: fakeDb,
    BUILDER_ACCOUNT_DO: makeStatefulDoNamespace(BuilderAccountDO),
    PRODUCT_USER_DO: makeStatefulDoNamespace(ProductUserDO),
    SPACE_TYPE_REGISTRY_DO: makeStatefulDoNamespace(SpaceTypeRegistryDO),
    NAELAO_CONFIG_KV: { get: async () => null, put: async () => {} },
  };
}

async function seedSpace(env: ReturnType<typeof makeEnv>, id: string, tenantId: string) {
  await env.PLATFORM_DB.prepare(
    "INSERT INTO spaces (id, tenant_id, status, name) VALUES (?, ?, 'active', 'Acme Store')"
  ).bind(id, tenantId).run();
}

function verifyReq(body: unknown, platformSecret?: string): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (platformSecret !== undefined) headers.set("x-naelao-platform-secret", platformSecret);
  return new Request("https://spaces.naelao.com/internal/product-sessions/verify", {
    method: "POST", headers, body: JSON.stringify(body),
  });
}

describe("POST /internal/product-sessions/verify", () => {
  it("rejects a wrong or missing platform secret with 403", async () => {
    const env = makeEnv();
    const res = await spacesWorker.fetch(verifyReq({ productId: "p1", endUserId: "u1", sessionToken: "x" }, "wrong-secret"), env as never, execCtx);
    expect(res.status).toBe(403);
    const noSecret = await spacesWorker.fetch(verifyReq({ productId: "p1", endUserId: "u1", sessionToken: "x" }), env as never, execCtx);
    expect(noSecret.status).toBe(403);
  });

  it("returns valid:false for a nonexistent product", async () => {
    const env = makeEnv();
    const res = await spacesWorker.fetch(verifyReq({ productId: "no-such-space", endUserId: "u1", sessionToken: "x" }, "test-platform-secret"), env as never, execCtx);
    const body = await res.json() as { valid: boolean };
    expect(body.valid).toBe(false);
  });

  it("returns valid:false for a forged/unknown session token", async () => {
    const env = makeEnv();
    await seedSpace(env, "prod-1", "tenant-1");
    const res = await spacesWorker.fetch(verifyReq({ productId: "prod-1", endUserId: "u1", sessionToken: "nps_forged" }, "test-platform-secret"), env as never, execCtx);
    const body = await res.json() as { valid: boolean };
    expect(body.valid).toBe(false);
  });

  it("returns valid:true + the product's owning tenant_id for a real session token", async () => {
    const env = makeEnv();
    await seedSpace(env, "prod-1", "tenant-1");

    // Open a real session directly on the end user's ProductUserDO (mirrors what Phase 2's
    // /sessions endpoint does), then verify it through the new internal endpoint.
    const { getDOName } = await import("@naelao/crypto");
    const doName = await getDOName("produser", "prod-1:user-42", "tenant-1", "test-platform-secret");
    const stub = env.PRODUCT_USER_DO.get(env.PRODUCT_USER_DO.idFromName(doName));
    const opened = await (await stub.fetch(new Request("http://do/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }))).json() as { session_token: string };

    const res = await spacesWorker.fetch(
      verifyReq({ productId: "prod-1", endUserId: "user-42", sessionToken: opened.session_token }, "test-platform-secret"),
      env as never, execCtx
    );
    const body = await res.json() as { valid: boolean; tenant_id: string; end_user_id: string };
    expect(body.valid).toBe(true);
    expect(body.tenant_id).toBe("tenant-1");
    expect(body.end_user_id).toBe("user-42");
  });

  it("a session opened for a DIFFERENT end user does not verify against this end user", async () => {
    const env = makeEnv();
    await seedSpace(env, "prod-1", "tenant-1");
    const { getDOName } = await import("@naelao/crypto");

    const doNameA = await getDOName("produser", "prod-1:user-a", "tenant-1", "test-platform-secret");
    const stubA = env.PRODUCT_USER_DO.get(env.PRODUCT_USER_DO.idFromName(doNameA));
    const opened = await (await stubA.fetch(new Request("http://do/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }))).json() as { session_token: string };

    // Attempt to verify user A's token but claiming to be user B — resolves a DIFFERENT
    // ProductUserDO instance (produser:prod-1:user-b) which has never seen this token.
    const res = await spacesWorker.fetch(
      verifyReq({ productId: "prod-1", endUserId: "user-b", sessionToken: opened.session_token }, "test-platform-secret"),
      env as never, execCtx
    );
    const body = await res.json() as { valid: boolean };
    expect(body.valid).toBe(false);
  });
});

describe("POST /internal/product-sessions/verify — Phase B parent-walk for child business spaces", () => {
  async function seedBusiness(env: ReturnType<typeof makeEnv>, id: string, tenantId: string, parentSpaceId: string) {
    await env.PLATFORM_DB.prepare(
      "INSERT INTO spaces (id, tenant_id, status, name, parent_space_id) VALUES (?, ?, 'active', 'My Business', ?)"
    ).bind(id, tenantId, parentSpaceId).run();
  }

  it("resolves a session opened under the PRODUCT ROOT when the URL space is a child business", async () => {
    const env = makeEnv();
    await seedSpace(env, "prod-root", "root-tenant");
    await seedBusiness(env, "biz-1", "biz-tenant", "prod-root");

    // The end user's ProductUserDO lives under the PRODUCT ROOT, not the business.
    const { getDOName } = await import("@naelao/crypto");
    const doName = await getDOName("produser", "prod-root:user-42", "root-tenant", "test-platform-secret");
    const stub = env.PRODUCT_USER_DO.get(env.PRODUCT_USER_DO.idFromName(doName));
    const opened = await (await stub.fetch(new Request("http://do/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }))).json() as { session_token: string };

    // Verify against the BUSINESS's id (what the URL/router actually sees).
    const res = await spacesWorker.fetch(
      verifyReq({ productId: "biz-1", endUserId: "user-42", sessionToken: opened.session_token }, "test-platform-secret"),
      env as never, execCtx
    );
    const body = await res.json() as { valid: boolean; tenant_id: string; end_user_id: string };
    expect(body.valid).toBe(true);
    // tenant_id returned is the BUSINESS's own tenant (for requireInternalHmac against the space
    // actually being accessed), not the product root's.
    expect(body.tenant_id).toBe("biz-tenant");
    expect(body.end_user_id).toBe("user-42");
  });

  it("a session opened directly under the business id (wrong DO) does not verify", async () => {
    const env = makeEnv();
    await seedSpace(env, "prod-root", "root-tenant");
    await seedBusiness(env, "biz-1", "biz-tenant", "prod-root");

    const { getDOName } = await import("@naelao/crypto");
    // Wrong: opened under the business id instead of the product root.
    const wrongDoName = await getDOName("produser", "biz-1:user-42", "biz-tenant", "test-platform-secret");
    const wrongStub = env.PRODUCT_USER_DO.get(env.PRODUCT_USER_DO.idFromName(wrongDoName));
    const opened = await (await wrongStub.fetch(new Request("http://do/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }))).json() as { session_token: string };

    const res = await spacesWorker.fetch(
      verifyReq({ productId: "biz-1", endUserId: "user-42", sessionToken: opened.session_token }, "test-platform-secret"),
      env as never, execCtx
    );
    const body = await res.json() as { valid: boolean };
    expect(body.valid).toBe(false);
  });

  it("returns valid:false if the parent product root no longer exists", async () => {
    const env = makeEnv();
    await seedBusiness(env, "biz-orphan", "biz-tenant", "no-such-root");
    const res = await spacesWorker.fetch(
      verifyReq({ productId: "biz-orphan", endUserId: "user-42", sessionToken: "nps_whatever" }, "test-platform-secret"),
      env as never, execCtx
    );
    const body = await res.json() as { valid: boolean };
    expect(body.valid).toBe(false);
  });
});
