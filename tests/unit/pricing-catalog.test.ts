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
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', suspension_reason TEXT,
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
const SPACE_MEMBERS_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0021_space_members.sql"), "utf8");

function makeEnv() {
  const fakeDb = createFakeD1([SPACES_TABLE_SQL, BUSINESS_MEMBERSHIPS_SQL, SPACE_MEMBERS_MIGRATION, BUILDER_DASHBOARD_MIGRATION]);
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

// An end-user request as the router would forward it: role/user claims PLUS the internal HMAC token
// (proxyTo mints it off ANY verified claims, role included) and the owning tenant header the
// requireInternalHmac backstop verifies against.
async function endUserHeaders(tenant: string, userId: string): Promise<Record<string, string>> {
  return {
    "x-naelao-role": "product_end_user",
    "x-naelao-user-id": userId,
    "x-naelao-tenant-id": tenant,
    "x-naelao-internal-token": await mintInternalToken(PLATFORM_SECRET, tenant),
  };
}

async function builderHeaders(tenant: string): Promise<Record<string, string>> {
  return { "x-naelao-tenant-id": tenant, "x-naelao-internal-token": await mintInternalToken(PLATFORM_SECRET, tenant) };
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
    "INSERT INTO space_members (id, space_id, tenant_id, end_user_id, role) VALUES ('member-anyone', 'prod-root', 'root-tenant', 'anyone', 'member')"
  ).run();
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
      req("/spaces/biz-alice/pricing", { headers: await endUserHeaders("alice-tenant", "alice") }),
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
      req("/spaces/biz-alice/pricing", { headers: await endUserHeaders("alice-tenant", "mallory") }),
      env as never,
      execCtx
    );
    expect(res.status).toBe(403);
  });

  it("querying the product root directly also works (team-mode products have no separate business)", async () => {
    const env = makeEnv();
    await seedProductWithPlans(env);
    const res = await spacesWorker.fetch(
      req("/spaces/prod-root/pricing", { headers: await endUserHeaders("root-tenant", "anyone") }),
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
      req("/spaces/no-such-space/pricing", { headers: await endUserHeaders("alice-tenant", "alice") }),
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
        headers: await builderHeaders("tenant-1"),
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

  it("rejects malformed, unsafe, or duplicate pricing data before external variant provisioning", async () => {
    for (const body of [
      { plans: "not-an-array" },
      { plans: [{ id: "pro", name: "Pro", priceCents: -1, interval: "month" }] },
      { plans: [{ id: "pro", name: "Pro", priceCents: 1200.5, interval: "month" }] },
      { plans: [{ id: "pro", name: "Pro", priceCents: 1200, interval: "month", limits: { maxThreadsPerUser: -1 } }] },
      { plans: [{ id: "pro", name: "Pro", priceCents: 1200, interval: "month", unexpected: "persist me" }] },
      { plans: [
        { id: "pro", name: "Pro", priceCents: 1200, interval: "month" },
        { id: "pro", name: "Duplicate", priceCents: 1400, interval: "year" },
      ] },
      { creditPacks: [{ id: "pack", name: "Pack", credits: 0, priceCents: 100 }] },
      { walletTopups: [{ id: "wallet", name: "Wallet", priceCents: Number.MAX_SAFE_INTEGER + 1 }] },
      { externalRevenueCut: { enabled: true, cutBps: 10_001 } },
      { unexpected: true },
    ]) {
      const env = makeEnv();
      await env.PLATFORM_DB.prepare(
        "INSERT INTO spaces (id, tenant_id, status, name, spacetype_id, config_json) VALUES ('prod-1', 'tenant-1', 'active', 'Product', 'launchpad', '{}')"
      ).run();
      const billing = makeBillingWorker("must-not-be-called");
      const res = await spacesWorker.fetch(
        req("/builder/products/prod-1/pricing", {
          method: "PATCH", headers: await builderHeaders("tenant-1"), body: JSON.stringify(body),
        }),
        { ...env, BILLING_WORKER: billing } as never,
        execCtx
      );
      expect(res.status).toBe(400);
      expect(billing.calls).toHaveLength(0);
      const saved = await env.PLATFORM_DB.prepare("SELECT config_json FROM spaces WHERE id = 'prod-1'").first<{ config_json: string }>();
      expect(saved?.config_json).toBe("{}");
    }
  });

  it("returns a client error for malformed JSON instead of failing after route dispatch", async () => {
    const env = makeEnv();
    await env.PLATFORM_DB.prepare(
      "INSERT INTO spaces (id, tenant_id, status, name, spacetype_id, config_json) VALUES ('prod-1', 'tenant-1', 'active', 'Product', 'launchpad', '{}')"
    ).run();
    const res = await spacesWorker.fetch(
      req("/builder/products/prod-1/pricing", { method: "PATCH", headers: await builderHeaders("tenant-1"), body: "{" }),
      env as never, execCtx
    );
    expect(res.status).toBe(400);
  });

  it("bounds pricing request bodies before parsing or calling billing", async () => {
    const env = makeEnv();
    await env.PLATFORM_DB.prepare(
      "INSERT INTO spaces (id, tenant_id, status, name, spacetype_id, config_json) VALUES ('prod-1', 'tenant-1', 'active', 'Product', 'launchpad', '{}')"
    ).run();
    const billing = makeBillingWorker("must-not-be-called");
    const res = await spacesWorker.fetch(
      req("/builder/products/prod-1/pricing", {
        method: "PATCH", headers: await builderHeaders("tenant-1"),
        body: JSON.stringify({ plans: [{ id: "pro", name: "x".repeat(70_000), priceCents: 500, interval: "month" }] }),
      }),
      { ...env, BILLING_WORKER: billing } as never,
      execCtx,
    );
    expect(res.status).toBe(413);
    expect(billing.calls).toHaveLength(0);
  });

  it("prevents generic product updates from bypassing the pricing endpoint", async () => {
    const env = makeEnv();
    const pricing = { model: "subscription", plans: [{ id: "basic", name: "Basic", priceCents: 1200, interval: "month" }] };
    await env.PLATFORM_DB.prepare(
      "INSERT INTO spaces (id, tenant_id, status, name, spacetype_id, config_json) VALUES ('prod-1', 'tenant-1', 'active', 'Product', 'launchpad', ?)"
    ).bind(JSON.stringify({ productConfig: { pricingConfig: pricing } })).run();

    const bypass = await spacesWorker.fetch(
      req("/builder/products/prod-1", {
        method: "PATCH", headers: await builderHeaders("tenant-1"),
        body: JSON.stringify({ product_config: { pricingConfig: { ...pricing, plans: [{ ...pricing.plans[0], priceCents: 1 }] } } }),
      }), env as never, execCtx
    );
    expect(bypass.status).toBe(400);

    // The configuration page sends its fetched price catalog back while changing unrelated
    // settings; preserving that exact catalog must remain a successful update.
    const regularEdit = await spacesWorker.fetch(
      req("/builder/products/prod-1", {
        method: "PATCH", headers: await builderHeaders("tenant-1"),
        body: JSON.stringify({ product_config: { pricingConfig: pricing, modelConfig: { model: "claude-opus-4-8" } } }),
      }), env as never, execCtx
    );
    expect(regularEdit.status).toBe(200);
    const saved = await env.PLATFORM_DB.prepare("SELECT config_json FROM spaces WHERE id = 'prod-1'").first<{ config_json: string }>();
    expect(JSON.parse(saved!.config_json).productConfig.pricingConfig.plans[0].priceCents).toBe(1200);
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
        headers: await builderHeaders("tenant-1"),
        body: JSON.stringify({ creditPacks: [{ id: "pack-500", name: "500 credits", credits: 500, priceCents: 300 }] }),
      }),
      { ...env, BILLING_WORKER: billing } as never,
      execCtx
    );
    expect(res.status).toBe(200);
    expect(billing.calls[0]!.body).toMatchObject({ kind: "one_time", price_cents: 300 });
  });

  it("provisions wallet top-up packs as one_time variants (Launchpad Wallet)", async () => {
    const env = makeEnv();
    await env.PLATFORM_DB.prepare(
      "INSERT INTO spaces (id, tenant_id, status, name, spacetype_id, config_json) VALUES ('prod-1', 'tenant-1', 'active', 'My Product', 'launchpad', '{}')"
    ).run();
    const billing = makeBillingWorker("var_topup_new");
    const res = await spacesWorker.fetch(
      req("/builder/products/prod-1/pricing", {
        method: "PATCH",
        headers: await builderHeaders("tenant-1"),
        body: JSON.stringify({ walletTopups: [{ id: "topup-25", name: "$25", priceCents: 2500 }] }),
      }),
      { ...env, BILLING_WORKER: billing } as never,
      execCtx
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pricing_config: { walletTopups: Array<{ id: string; lsVariantId?: string }> } };
    expect(body.pricing_config.walletTopups.find((t) => t.id === "topup-25")?.lsVariantId).toBe("var_topup_new");
    expect(billing.calls[0]!.body).toMatchObject({ kind: "one_time", price_cents: 2500 });
  });

  it("404s for a product the calling tenant does not own", async () => {
    const env = makeEnv();
    await env.PLATFORM_DB.prepare(
      "INSERT INTO spaces (id, tenant_id, status, name, spacetype_id) VALUES ('prod-1', 'someone-else', 'active', 'X', 'launchpad')"
    ).run();
    const res = await spacesWorker.fetch(
      req("/builder/products/prod-1/pricing", { method: "PATCH", headers: await builderHeaders("tenant-1"), body: JSON.stringify({ plans: [] }) }),
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

// Phase 4 (money): the personal-plan catalog rides the exact same pricing-catalog machinery as
// plans/creditPacks above — same product-root authorship, same walk-to-root resolution.
describe("GET /spaces/:spaceId/personal-plan + POST /internal/personal-plan/grant (Phase 4, money)", () => {
  async function seedProductWithPersonalPlans(env: ReturnType<typeof makeEnv>) {
    const pricingConfig = {
      model: "credits",
      personalPlans: [{ id: "plus-monthly", name: "Plus", tier: "plus", priceCents: 500, interval: "month", lsVariantId: "var_plus" }],
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

  it("GET /spaces/:spaceId/pricing surfaces personal_plans alongside plans/credit_packs", async () => {
    const env = makeEnv();
    await seedProductWithPersonalPlans(env);
    const res = await spacesWorker.fetch(
      req("/spaces/biz-alice/pricing", { headers: await endUserHeaders("alice-tenant", "alice") }),
      env as never, execCtx
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { personal_plans: Array<{ id: string; tier: string; price_cents: number }> };
    expect(body.personal_plans).toHaveLength(1);
    expect(body.personal_plans[0]).toMatchObject({ id: "plus-monthly", tier: "plus", price_cents: 500 });
  });

  it("GET /spaces/:spaceId/personal-plan defaults a new end user to 'free' with the real free-tier limits", async () => {
    const env = makeEnv();
    await seedProductWithPersonalPlans(env);
    const res = await spacesWorker.fetch(
      req("/spaces/biz-alice/personal-plan", { headers: await endUserHeaders("alice-tenant", "alice") }),
      env as never, execCtx
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { plan_tier: string; limits: { maxBusinessesOwned: number; canInviteOthers: boolean } };
    expect(body.plan_tier).toBe("free");
    expect(body.limits).toEqual({ maxBusinessesOwned: 3, canInviteOthers: false });
  });

  it("POST /internal/personal-plan/grant requires a verified internal token", async () => {
    const env = makeEnv();
    const res = await spacesWorker.fetch(
      req("/internal/personal-plan/grant", { method: "POST", body: JSON.stringify({ product_space_id: "prod-root", end_user_id: "alice", tier: "plus" }) }),
      env as never, execCtx
    );
    expect(res.status).toBe(403);
  });

  it("POST /internal/personal-plan/grant sets the tier, and GET /personal-plan reflects it immediately", async () => {
    const env = makeEnv();
    await seedProductWithPersonalPlans(env);
    const token = await mintInternalToken(PLATFORM_SECRET, "root-tenant");
    const grantRes = await spacesWorker.fetch(
      req("/internal/personal-plan/grant", {
        method: "POST",
        headers: { "x-naelao-tenant-id": "root-tenant", "x-naelao-internal-token": token },
        body: JSON.stringify({ product_space_id: "prod-root", end_user_id: "alice", tier: "plus" }),
      }),
      env as never, execCtx
    );
    expect(grantRes.status).toBe(200);

    const readRes = await spacesWorker.fetch(
      req("/spaces/biz-alice/personal-plan", { headers: await endUserHeaders("alice-tenant", "alice") }),
      env as never, execCtx
    );
    const body = (await readRes.json()) as { plan_tier: string; limits: { maxBusinessesOwned: number; canInviteOthers: boolean } };
    expect(body.plan_tier).toBe("plus");
    expect(body.limits).toEqual({ maxBusinessesOwned: 25, canInviteOthers: true });
  });

  it("routes a verified paid-period grant into the entitlement ledger", async () => {
    const env = makeEnv();
    await seedProductWithPersonalPlans(env);
    const token = await mintInternalToken(PLATFORM_SECRET, "root-tenant");
    const grant = await spacesWorker.fetch(req("/internal/personal-plan/grant", {
      method: "POST",
      headers: { "x-naelao-tenant-id": "root-tenant", "x-naelao-internal-token": token },
      body: JSON.stringify({
        action: "purchase", product_space_id: "prod-root", end_user_id: "alice", tier: "plus",
        interval: "month", provider: "lemon_squeezy", provider_event_id: "order-period-1", amount_cents: 500,
      }),
    }), env as never, execCtx);
    expect(grant.status).toBe(200);
    expect(await grant.json()).toMatchObject({ plan_tier: "plus", deduplicated: false });

    const read = await spacesWorker.fetch(
      req("/spaces/biz-alice/personal-plan", { headers: await endUserHeaders("alice-tenant", "alice") }),
      env as never, execCtx
    );
    expect(await read.json()).toMatchObject({ plan_tier: "plus", limits: { canInviteOthers: true } });
  });

  it("rejects a nonsense tier at the grant route", async () => {
    const env = makeEnv();
    await seedProductWithPersonalPlans(env);
    const token = await mintInternalToken(PLATFORM_SECRET, "root-tenant");
    const res = await spacesWorker.fetch(
      req("/internal/personal-plan/grant", {
        method: "POST",
        headers: { "x-naelao-tenant-id": "root-tenant", "x-naelao-internal-token": token },
        body: JSON.stringify({ product_space_id: "prod-root", end_user_id: "alice", tier: "premium-forever" }),
      }),
      env as never, execCtx
    );
    expect(res.status).toBe(400);
  });

  it("CRITICAL: a different end user's own tier is completely independent (no cross-user leakage)", async () => {
    const env = makeEnv();
    await seedProductWithPersonalPlans(env);
    // bob is also a genuine member of the SAME business, so his own /personal-plan read is
    // reachable — the real test is that alice's grant never bleeds into his.
    await env.PLATFORM_DB.prepare(
      "INSERT INTO business_memberships (business_space_id, product_space_id, end_user_id, role, status) VALUES ('biz-alice', 'prod-root', 'bob', 'member', 'active')"
    ).run();
    const token = await mintInternalToken(PLATFORM_SECRET, "root-tenant");
    await spacesWorker.fetch(
      req("/internal/personal-plan/grant", {
        method: "POST",
        headers: { "x-naelao-tenant-id": "root-tenant", "x-naelao-internal-token": token },
        body: JSON.stringify({ product_space_id: "prod-root", end_user_id: "alice", tier: "plus" }),
      }),
      env as never, execCtx
    );
    const bobRes = await spacesWorker.fetch(
      req("/spaces/biz-alice/personal-plan", { headers: await endUserHeaders("alice-tenant", "bob") }),
      env as never, execCtx
    );
    expect(bobRes.status).toBe(200);
    const bobBody = (await bobRes.json()) as { plan_tier: string };
    expect(bobBody.plan_tier).toBe("free"); // alice's grant did not leak to bob
  });
});
