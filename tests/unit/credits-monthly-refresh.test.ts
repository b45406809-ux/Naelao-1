import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import spacesWorker from "../../workers/spaces/src/index.js";
import { mintInternalToken } from "@naelao/http";
import { ProductUserDO } from "../../workers/spaces/src/do/ProductUserDO.js";
import { SpaceTypeRegistryDO } from "../../workers/spaces/src/do/SpaceTypeRegistryDO.js";
import { createFakeD1 } from "../stubs/d1-sqlite.js";
import { makeStatefulDoNamespace } from "./helpers/fake-do-namespace.js";

// Tier 2 metering follow-up: creditsIncludedPerMonth was builder-configurable but only ever
// granted ONCE, at signup, despite the field name implying a recurring monthly allowance. This
// route is called lazily by NaelaoAgentDO right before every Space-Assistant-scope run by a
// signed-in end user — proves it grants the right amount, resolves the same free-tier default
// signup uses, and is idempotent within a calendar month (no double-grant on repeated calls).

const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const PLATFORM_SECRET = "test-platform-secret";

const SPACES_TABLE_SQL = `
  CREATE TABLE spaces (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    name TEXT NOT NULL DEFAULT '', spacetype_id TEXT NOT NULL DEFAULT 'launchpad',
    config_json TEXT NOT NULL DEFAULT '{}', parent_space_id TEXT, product_slug TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')), created_by TEXT
  );
`;

function makeEnv() {
  const fakeDb = createFakeD1([SPACES_TABLE_SQL]);
  return {
    PLATFORM_SECRET,
    ENVIRONMENT: "test",
    PLATFORM_DB: fakeDb,
    PRODUCT_USER_DO: makeStatefulDoNamespace(ProductUserDO),
    SPACE_TYPE_REGISTRY_DO: makeStatefulDoNamespace(SpaceTypeRegistryDO),
    NAELAO_CONFIG_KV: { get: async () => null, put: async () => {} },
  };
}

function req(path: string, init: RequestInit & { headers?: Record<string, string> } = {}): Request {
  return new Request(`https://spaces.naelao.com${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

async function seedProduct(env: ReturnType<typeof makeEnv>, id: string, pricingConfig?: Record<string, unknown>) {
  const configJson = pricingConfig ? JSON.stringify({ productConfig: { pricingConfig } }) : "{}";
  await env.PLATFORM_DB.prepare(
    "INSERT INTO spaces (id, tenant_id, status, name, spacetype_id, config_json) VALUES (?, 'tenant-1', 'active', 'Product', 'launchpad', ?)"
  ).bind(id, configJson).run();
}

async function refresh(env: ReturnType<typeof makeEnv>, spaceId: string, endUserId: string) {
  const token = await mintInternalToken(PLATFORM_SECRET, "tenant-1");
  return spacesWorker.fetch(
    req(`/internal/product-users/${spaceId}/${endUserId}/credits/refresh-monthly`, {
      method: "POST",
      headers: { "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token },
    }),
    env as never,
    execCtx
  );
}

describe("POST /internal/product-users/:spaceId/:endUserId/credits/refresh-monthly", () => {
  it("requires a verified internal token", async () => {
    const env = makeEnv();
    await seedProduct(env, "prod-1");
    const res = await spacesWorker.fetch(
      req("/internal/product-users/prod-1/alice/credits/refresh-monthly", { method: "POST" }),
      env as never,
      execCtx
    );
    expect(res.status).toBe(403);
  });

  it("grants the free-tier default (100) for an unconfigured product", async () => {
    const env = makeEnv();
    await seedProduct(env, "prod-1");
    const res = await refresh(env, "prod-1", "alice");
    expect(res.status).toBe(200);
    const body = await res.json() as { granted: boolean; balance_credits: number };
    expect(body.granted).toBe(true);
    expect(body.balance_credits).toBe(100);
  });

  it("grants the explicit creditsIncludedPerMonth for a configured 'credits' model", async () => {
    const env = makeEnv();
    await seedProduct(env, "prod-1", { model: "credits", creditsIncludedPerMonth: 500 });
    const res = await refresh(env, "prod-1", "alice");
    const body = await res.json() as { granted: boolean; balance_credits: number };
    expect(body.granted).toBe(true);
    expect(body.balance_credits).toBe(500);
  });

  it("does NOT grant for a paid model with no explicit allowance (pay-as-you-go)", async () => {
    const env = makeEnv();
    await seedProduct(env, "prod-1", { model: "credits" });
    const res = await refresh(env, "prod-1", "alice");
    const body = await res.json() as { granted: boolean; reason?: string };
    expect(body.granted).toBe(false);
    expect(body.reason).toBe("no_monthly_allowance");
  });

  it("is idempotent within the same calendar month — a repeat call does not double-grant", async () => {
    const env = makeEnv();
    await seedProduct(env, "prod-1", { model: "free" });
    const first = await refresh(env, "prod-1", "alice");
    const firstBody = await first.json() as { granted: boolean; balance_credits: number };
    expect(firstBody.granted).toBe(true);
    expect(firstBody.balance_credits).toBe(100);

    const second = await refresh(env, "prod-1", "alice");
    const secondBody = await second.json() as { granted: boolean; balance_credits: number };
    expect(secondBody.granted).toBe(false); // deduplicated
    expect(secondBody.balance_credits).toBe(100); // NOT 200
  });

  it("grants independently per end user", async () => {
    const env = makeEnv();
    await seedProduct(env, "prod-1", { model: "free" });
    await refresh(env, "prod-1", "alice");
    const bobRes = await refresh(env, "prod-1", "bob");
    const bobBody = await bobRes.json() as { granted: boolean; balance_credits: number };
    expect(bobBody.granted).toBe(true);
    expect(bobBody.balance_credits).toBe(100);
  });

  it("404s for a nonexistent product", async () => {
    const env = makeEnv();
    const res = await refresh(env, "no-such-product", "alice");
    expect(res.status).toBe(404);
  });
});
