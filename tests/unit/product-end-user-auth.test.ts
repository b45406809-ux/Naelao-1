import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import spacesWorker from "../../workers/spaces/src/index.js";
import { ProductUserDO } from "../../workers/spaces/src/do/ProductUserDO.js";
import { BuilderAccountDO } from "../../workers/spaces/src/do/BuilderAccountDO.js";
import { SpaceTypeRegistryDO } from "../../workers/spaces/src/do/SpaceTypeRegistryDO.js";
import { createFakeD1 } from "../stubs/d1-sqlite.js";
import { makeStatefulDoNamespace } from "./helpers/fake-do-namespace.js";

// Three-Tier Platform Model, Phase 6 (Journey 1B: "End user signs up or is invited via the
// builder's configured auth provider"). ProductUserDO (Phase 2) mints and verifies sessions but
// never verified an IDENTITY — these routes are the missing piece for authProvider:
// 'naelao-native' specifically: real email+password signup/login scoped to one product.

const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

const SPACES_TABLE_SQL = `
  CREATE TABLE spaces (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    name TEXT NOT NULL DEFAULT '', spacetype_id TEXT NOT NULL DEFAULT 'launchpad',
    config_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')), created_by TEXT
  );
`;
const CREDENTIALS_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0046_product_end_user_credentials.sql"), "utf8");
const BUILDER_DASHBOARD_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0045_builder_dashboard_api.sql"), "utf8");

function makeEnv() {
  const fakeDb = createFakeD1([SPACES_TABLE_SQL, BUILDER_DASHBOARD_MIGRATION, CREDENTIALS_MIGRATION]);
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

async function seedProduct(env: ReturnType<typeof makeEnv>, id: string, tenantId: string, productConfig?: Record<string, unknown>) {
  const configJson = productConfig ? JSON.stringify({ productConfig }) : "{}";
  await env.PLATFORM_DB.prepare(
    "INSERT INTO spaces (id, tenant_id, status, name, config_json) VALUES (?, ?, 'active', 'Acme Store', ?)"
  ).bind(id, tenantId, configJson).run();
}

function req(path: string, body: unknown): Request {
  return new Request(`https://spaces.naelao.com${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

describe("POST /spaces/:spaceId/end-users/signup", () => {
  it("creates a real account and returns a usable session token", async () => {
    const env = makeEnv();
    await seedProduct(env, "prod-1", "tenant-1");
    const res = await spacesWorker.fetch(req("/spaces/prod-1/end-users/signup", { email: "jane@acme.com", password: "hunter22" }), env as never, execCtx);
    expect(res.status).toBe(201);
    const body = await res.json() as { end_user_id: string; session_token: string };
    expect(body.session_token).toMatch(/^nps_/);
    expect(body.end_user_id).toBeTruthy();
  });

  it("rejects a duplicate signup for the same email on the same product", async () => {
    const env = makeEnv();
    await seedProduct(env, "prod-1", "tenant-1");
    await spacesWorker.fetch(req("/spaces/prod-1/end-users/signup", { email: "jane@acme.com", password: "hunter22" }), env as never, execCtx);
    const res = await spacesWorker.fetch(req("/spaces/prod-1/end-users/signup", { email: "jane@acme.com", password: "different1" }), env as never, execCtx);
    expect(res.status).toBe(409);
  });

  it("the SAME email can sign up independently on a DIFFERENT product", async () => {
    const env = makeEnv();
    await seedProduct(env, "prod-1", "tenant-1");
    await seedProduct(env, "prod-2", "tenant-2");
    const a = await spacesWorker.fetch(req("/spaces/prod-1/end-users/signup", { email: "jane@acme.com", password: "hunter22" }), env as never, execCtx);
    const b = await spacesWorker.fetch(req("/spaces/prod-2/end-users/signup", { email: "jane@acme.com", password: "hunter22" }), env as never, execCtx);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
  });

  it("rejects a short password", async () => {
    const env = makeEnv();
    await seedProduct(env, "prod-1", "tenant-1");
    const res = await spacesWorker.fetch(req("/spaces/prod-1/end-users/signup", { email: "jane@acme.com", password: "short" }), env as never, execCtx);
    expect(res.status).toBe(400);
  });

  it("enforces allowedEmailDomains when configured", async () => {
    const env = makeEnv();
    await seedProduct(env, "prod-1", "tenant-1", { authProvider: { provider: "naelao-native", allowedEmailDomains: ["acme.com"] } });
    const denied = await spacesWorker.fetch(req("/spaces/prod-1/end-users/signup", { email: "jane@other.com", password: "hunter22" }), env as never, execCtx);
    expect(denied.status).toBe(403);
    const allowed = await spacesWorker.fetch(req("/spaces/prod-1/end-users/signup", { email: "jane@acme.com", password: "hunter22" }), env as never, execCtx);
    expect(allowed.status).toBe(201);
  });

  it("rejects signup for a product configured with a non-native auth provider", async () => {
    const env = makeEnv();
    await seedProduct(env, "prod-1", "tenant-1", { authProvider: { provider: "clerk" } });
    const res = await spacesWorker.fetch(req("/spaces/prod-1/end-users/signup", { email: "jane@acme.com", password: "hunter22" }), env as never, execCtx);
    expect(res.status).toBe(400);
  });

  it("404s for a nonexistent product", async () => {
    const env = makeEnv();
    const res = await spacesWorker.fetch(req("/spaces/no-such-product/end-users/signup", { email: "jane@acme.com", password: "hunter22" }), env as never, execCtx);
    expect(res.status).toBe(404);
  });
});

describe("POST /spaces/:spaceId/end-users/login", () => {
  it("logs in with the correct password and returns a fresh session token", async () => {
    const env = makeEnv();
    await seedProduct(env, "prod-1", "tenant-1");
    await spacesWorker.fetch(req("/spaces/prod-1/end-users/signup", { email: "jane@acme.com", password: "hunter22" }), env as never, execCtx);
    const res = await spacesWorker.fetch(req("/spaces/prod-1/end-users/login", { email: "jane@acme.com", password: "hunter22" }), env as never, execCtx);
    expect(res.status).toBe(200);
    const body = await res.json() as { session_token: string };
    expect(body.session_token).toMatch(/^nps_/);
  });

  it("rejects a wrong password without revealing whether the email exists", async () => {
    const env = makeEnv();
    await seedProduct(env, "prod-1", "tenant-1");
    await spacesWorker.fetch(req("/spaces/prod-1/end-users/signup", { email: "jane@acme.com", password: "hunter22" }), env as never, execCtx);
    const wrongPw = await spacesWorker.fetch(req("/spaces/prod-1/end-users/login", { email: "jane@acme.com", password: "wrongpass" }), env as never, execCtx);
    const noSuchEmail = await spacesWorker.fetch(req("/spaces/prod-1/end-users/login", { email: "nobody@acme.com", password: "wrongpass" }), env as never, execCtx);
    expect(wrongPw.status).toBe(401);
    expect(noSuchEmail.status).toBe(401);
    expect((await wrongPw.json() as { error_code: string }).error_code).toBe((await noSuchEmail.json() as { error_code: string }).error_code);
  });

  it("rejects login for a suspended account", async () => {
    const env = makeEnv();
    await seedProduct(env, "prod-1", "tenant-1");
    const signup = await (await spacesWorker.fetch(req("/spaces/prod-1/end-users/signup", { email: "jane@acme.com", password: "hunter22" }), env as never, execCtx)).json() as { end_user_id: string };
    await env.PLATFORM_DB.prepare(
      "UPDATE product_end_users SET suspended_at = datetime('now') WHERE product_space_id = ? AND end_user_id = ?"
    ).bind("prod-1", signup.end_user_id).run();
    const res = await spacesWorker.fetch(req("/spaces/prod-1/end-users/login", { email: "jane@acme.com", password: "hunter22" }), env as never, execCtx);
    expect(res.status).toBe(403);
  });

  it("a session minted at login verifies against the product's internal verify endpoint", async () => {
    const env = makeEnv();
    await seedProduct(env, "prod-1", "tenant-1");
    const signup = await (await spacesWorker.fetch(req("/spaces/prod-1/end-users/signup", { email: "jane@acme.com", password: "hunter22" }), env as never, execCtx)).json() as { end_user_id: string; session_token: string };

    const verifyRes = await spacesWorker.fetch(
      new Request("https://spaces.naelao.com/internal/product-sessions/verify", {
        method: "POST",
        headers: { "content-type": "application/json", "x-naelao-platform-secret": "test-platform-secret" },
        body: JSON.stringify({ productId: "prod-1", endUserId: signup.end_user_id, sessionToken: signup.session_token }),
      }),
      env as never, execCtx
    );
    const verified = await verifyRes.json() as { valid: boolean; tenant_id: string };
    expect(verified.valid).toBe(true);
    expect(verified.tenant_id).toBe("tenant-1");
  });
});
