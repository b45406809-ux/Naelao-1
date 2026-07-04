import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import spacesWorker from "../../workers/spaces/src/index.js";
import { mintInternalToken } from "@naelao/http";
import { ProductUserDO } from "../../workers/spaces/src/do/ProductUserDO.js";
import { SpaceTypeRegistryDO } from "../../workers/spaces/src/do/SpaceTypeRegistryDO.js";
import { createFakeD1 } from "../stubs/d1-sqlite.js";
import { makeStatefulDoNamespace } from "./helpers/fake-do-namespace.js";

// Phase E (§A1.17): subscription plans + credit packs. A business (child space) never carries its
// own catalog — the builder authors plans/creditPacks once on the PRODUCT ROOT
// (productConfig.pricingConfig), and any business under that product resolves the SAME catalog by
// walking up parent_space_id (the same one-hop-max invariant /internal/product-sessions/verify's
// parent-walk already established for ProductUserDO resolution).

const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const PLATFORM_SECRET = "test-platform-secret";

const SPACES_TABLE_SQL = `
  CREATE TABLE spaces (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    name TEXT NOT NULL DEFAULT '', spacetype_id TEXT NOT NULL DEFAULT 'launchpad',
    config_json TEXT NOT NULL DEFAULT '{}', parent_space_id TEXT,
    product_slug TEXT, conversation_access_approved_by TEXT, conversation_access_approved_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')), created_by TEXT
  );
`;
const BUSINESS_MEMBERSHIPS_SQL = `
  CREATE TABLE business_memberships (
    business_space_id TEXT NOT NULL, product_space_id TEXT NOT NULL, end_user_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member', status TEXT NOT NULL DEFAULT 'active',
    invited_by TEXT, joined_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (business_space_id, end_user_id)
  );
`;
const BUILDER_DASHBOARD_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0045_builder_dashboard_api.sql"), "utf8");

function makeEnv() {
  const fakeDb = createFakeD1([SPACES_TABLE_SQL, BUSINESS_MEMBERSHIPS_SQL, BUILDER_DASHBOARD_MIGRATION]);
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

async function seedProductWithPlans(env: ReturnType<typeof makeEnv>) {
  const pricingConfig = {
    model: "subscription",
    plans: [
      { id: "pro", name: "Pro", priceCents: 2900, interval: "month", creditAllowance: 5000, lsVariantId: "var_pro" },
      { id: "basic", name: "Basic", priceCents: 900, interval: "month" }, // no lsVariantId yet
    ],
    creditPacks: [{ id: "pack-1000", name: "1,000 credits", credits: 1000, priceCents: 500, lsVariantId: "var_pack" }],
  };
  await env.PLATFORM_DB.prepare(
    "INSERT INTO spaces (id, tenant_id, status, name, spacetype_id, config_json) VALUES ('prod-root', 'root-tenant', 'active', 'Product', 'launchpad', ?)"
  ).bind(JSON.stringify({ productConfig: { pricingConfig } })).run();
  await env.PLATFORM_DB.prepare(
    "INSERT INTO spaces (id, tenant_id, status, name, spacetype_id, parent_space_id) VALUES ('biz-alice', 'alice-tenant', 'active', 'Alice Biz', 'launchpad', 'prod-root')"
  ).run();
  await env.PLATFORM_DB.prepare(
    "INSERT INTO business_memberships (business_space_id, product_space_id, end_user_id, role, status) VALUES ('biz-alice', 'prod-root', 'alice', 'owner', 'active')"
  ).run();
}

describe("GET /spaces/:spaceId/pricing (business-scoped, walks to product root)", () => {
  it("a business member sees the catalog authored on the product root, not its own (empty) config", async () => {
    const env = makeEnv();
    await seedProductWithPlans(env);
    const res = await spacesWorker.fetch(
      req("/spaces/biz-alice/pricing", { headers: { "x-naelao-role": "product_end_user", "x-naelao-user-id": "alice" } }),
      env as never,
      execCtx
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { plans: Array<{ id: string; price_cents: number }>; credit_packs: Array<{ id: string; credits: number }> };
    expect(body.plans).toHaveLength(2);
    expect(body.plans.find((p) => p.id === "pro")).toMatchObject({ price_cents: 2900 });
    expect(body.credit_packs).toHaveLength(1);
    expect(body.credit_packs[0]).toMatchObject({ id: "pack-1000", credits: 1000 });
  });

  it("CRITICAL: a different end user cannot view a business they don't belong to", async () => {
    const env = makeEnv();
    await seedProductWithPlans(env);
    const res = await spacesWorker.fetch(
      req("/spaces/biz-alice/pricing", { headers: { "x-naelao-role": "product_end_user", "x-naelao-user-id": "mallory" } }),
      env as never,
      execCtx
    );
    expect(res.status).toBe(403);
  });

  it("querying the product root directly also works (team-mode products have no separate business)", async () => {
    const env = makeEnv();
    await seedProductWithPlans(env);
    const res = await spacesWorker.fetch(
      req("/spaces/prod-root/pricing", { headers: { "x-naelao-role": "product_end_user", "x-naelao-user-id": "anyone" } }),
      env as never,
      execCtx
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { plans: unknown[] };
    expect(body.plans).toHaveLength(2);
  });

  it("404s for a nonexistent space", async () => {
    const env = makeEnv();
    const res = await spacesWorker.fetch(
      req("/spaces/no-such-space/pricing", { headers: { "x-naelao-role": "product_end_user", "x-naelao-user-id": "alice" } }),
      env as never,
      execCtx
    );
    expect([403, 404]).toContain(res.status);
  });
});

describe("GET /internal/pricing-catalog (billing worker's checkout resolution)", () => {
  it("requires a verified internal token", async () => {
    const env = makeEnv();
    await seedProductWithPlans(env);
    const res = await spacesWorker.fetch(req("/internal/pricing-catalog?space_id=biz-alice"), env as never, execCtx);
    expect(res.status).toBe(403);
  });

  it("returns the full plan/pack objects including lsVariantId, resolved via the product root", async () => {
    const env = makeEnv();
    await seedProductWithPlans(env);
    const token = await mintInternalToken(PLATFORM_SECRET, "alice-tenant");
    const res = await spacesWorker.fetch(
      req("/internal/pricing-catalog?space_id=biz-alice", { headers: { "x-naelao-tenant-id": "alice-tenant", "x-naelao-internal-token": token } }),
      env as never,
      execCtx
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { product_space_id: string; plans: Array<{ id: string; lsVariantId?: string }> };
    expect(body.product_space_id).toBe("prod-root");
    expect(body.plans.find((p) => p.id === "pro")?.lsVariantId).toBe("var_pro");
    expect(body.plans.find((p) => p.id === "basic")?.lsVariantId).toBeUndefined();
  });
});

describe("PATCH /builder/products/:id/pricing", () => {
  function makeBillingWorker(variantId: string) {
    const calls: Array<{ body: { name: string; price_cents: number; kind: string } }> = [];
    return {
      fetch: async (r: Request) => {
        calls.push({ body: await r.json() });
        return new Response(JSON.stringify({ ls_variant_id: variantId, ls_product_id: "lsprod_x" }), { status: 200 });
      },
      calls,
    };
  }

  it("provisions an LS variant for a new plan lacking one, and leaves an already-provisioned plan untouched", async () => {
    const env = makeEnv();
    await env.PLATFORM_DB.prepare(
      "INSERT INTO spaces (id, tenant_id, status, name, spacetype_id, config_json) VALUES ('prod-1', 'tenant-1', 'active', 'My Product', 'launchpad', ?)"
    ).bind(JSON.stringify({ productConfig: { pricingConfig: { model: "subscription", plans: [{ id: "pro", name: "Pro", priceCents: 2900, interval: "month", lsVariantId: "var_existing" }] } } })).run();

    const billing = makeBillingWorker("var_new_basic");
    const res = await spacesWorker.fetch(
      req("/builder/products/prod-1/pricing", {
        method: "PATCH",
        headers: { "x-naelao-tenant-id": "tenant-1" },
        body: JSON.stringify({
          plans: [
            { id: "pro", name: "Pro", priceCents: 2900, interval: "month", lsVariantId: "var_existing" },
            { id: "basic", name: "Basic", priceCents: 900, interval: "month" },
          ],
        }),
      }),
      { ...env, BILLING_WORKER: billing } as never,
      execCtx
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pricing_config: { plans: Array<{ id: string; lsVariantId?: string }> } };
    expect(body.pricing_config.plans.find((p) => p.id === "pro")?.lsVariantId).toBe("var_existing");
    expect(body.pricing_config.plans.find((p) => p.id === "basic")?.lsVariantId).toBe("var_new_basic");
    // Only ONE provisioning call — the already-provisioned "pro" plan was never re-sent.
    expect(billing.calls).toHaveLength(1);
    expect(billing.calls[0]!.body).toMatchObject({ price_cents: 900, kind: "subscription" });
  });

  it("provisions credit packs as one_time variants", async () => {
    const env = makeEnv();
    await env.PLATFORM_DB.prepare(
      "INSERT INTO spaces (id, tenant_id, status, name, spacetype_id, config_json) VALUES ('prod-1', 'tenant-1', 'active', 'My Product', 'launchpad', '{}')"
    ).run();
    const billing = makeBillingWorker("var_pack_new");
    const res = await spacesWorker.fetch(
      req("/builder/products/prod-1/pricing", {
        method: "PATCH",
        headers: { "x-naelao-tenant-id": "tenant-1" },
        body: JSON.stringify({ creditPacks: [{ id: "pack-500", name: "500 credits", credits: 500, priceCents: 300 }] }),
      }),
      { ...env, BILLING_WORKER: billing } as never,
      execCtx
    );
    expect(res.status).toBe(200);
    expect(billing.calls[0]!.body).toMatchObject({ kind: "one_time", price_cents: 300 });
  });

  it("404s for a product the calling tenant does not own", async () => {
    const env = makeEnv();
    await env.PLATFORM_DB.prepare(
      "INSERT INTO spaces (id, tenant_id, status, name, spacetype_id) VALUES ('prod-1', 'someone-else', 'active', 'X', 'launchpad')"
    ).run();
    const res = await spacesWorker.fetch(
      req("/builder/products/prod-1/pricing", { method: "PATCH", headers: { "x-naelao-tenant-id": "tenant-1" }, body: JSON.stringify({ plans: [] }) }),
      env as never,
      execCtx
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /internal/credit-packs/grant (webhook-safe, idempotent)", () => {
  it("requires a verified internal token", async () => {
    const env = makeEnv();
    const res = await spacesWorker.fetch(
      req("/internal/credit-packs/grant", { method: "POST", body: JSON.stringify({ product_space_id: "prod-1", end_user_id: "alice", credits: 500, idempotency_key: "k1" }) }),
      env as never,
      execCtx
    );
    expect(res.status).toBe(403);
  });

  it("grants credits to the end user's ProductUserDO", async () => {
    const env = makeEnv();
    await env.PLATFORM_DB.prepare(
      "INSERT INTO spaces (id, tenant_id, status, name, spacetype_id) VALUES ('prod-1', 'tenant-1', 'active', 'Product', 'launchpad')"
    ).run();
    const token = await mintInternalToken(PLATFORM_SECRET, "tenant-1");
    const res = await spacesWorker.fetch(
      req("/internal/credit-packs/grant", {
        method: "POST",
        headers: { "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token },
        body: JSON.stringify({ product_space_id: "prod-1", end_user_id: "alice", credits: 500, idempotency_key: "evt-1" }),
      }),
      env as never,
      execCtx
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { balance_credits: number };
    expect(body.balance_credits).toBe(500);
  });

  it("a webhook retry with the same idempotency_key does not double-grant", async () => {
    const env = makeEnv();
    await env.PLATFORM_DB.prepare(
      "INSERT INTO spaces (id, tenant_id, status, name, spacetype_id) VALUES ('prod-1', 'tenant-1', 'active', 'Product', 'launchpad')"
    ).run();
    const token = await mintInternalToken(PLATFORM_SECRET, "tenant-1");
    const grant = () =>
      spacesWorker.fetch(
        req("/internal/credit-packs/grant", {
          method: "POST",
          headers: { "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token },
          body: JSON.stringify({ product_space_id: "prod-1", end_user_id: "alice", credits: 500, idempotency_key: "evt-retry" }),
        }),
        env as never,
        execCtx
      );
    const first = await (await grant()).json() as { balance_credits: number };
    const second = await (await grant()).json() as { balance_credits: number; deduplicated?: boolean };
    expect(first.balance_credits).toBe(500);
    expect(second.balance_credits).toBe(500); // NOT 1000 — the retry was deduplicated
    expect(second.deduplicated).toBe(true);
  });
});
