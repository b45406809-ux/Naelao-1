import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import spacesWorker from "../../workers/spaces/src/index.js";
import { BuilderAccountDO } from "../../workers/spaces/src/do/BuilderAccountDO.js";
import { ProductUserDO } from "../../workers/spaces/src/do/ProductUserDO.js";
import { SpaceTypeRegistryDO } from "../../workers/spaces/src/do/SpaceTypeRegistryDO.js";
import { createFakeD1 } from "../stubs/d1-sqlite.js";
import { makeStatefulDoNamespace } from "./helpers/fake-do-namespace.js";

// Three-Tier Platform Model, Phase 4 (docs/spec-appendix A1.17): the Product Creation Wizard.
// No frontend-render test harness exists in this repo (no playwright/puppeteer dependency), so
// per the plan this verifies the wizard's actual integration surface: the exact request shape
// apps/dashboard/src/app/dashboard/products/new/page.tsx sends at "Review & Launch" round-trips
// correctly through the real spaces worker (POST /builder/products, backed by create-space.ts's
// createSpaceRecord — the same shared path /spaces POST uses) and that the wizard's two read
// dependencies (GET /builder/space-types, wrapping SpaceTypeRegistryDO) return a shape the
// SpaceTypeStep component can render. The UI itself was manually verified end-to-end (dev server
// + CDP click-through of all 7 steps) since this repo has no automated browser-rendering harness.

const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

const SPACES_TABLE_SQL = `
  CREATE TABLE spaces (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    name TEXT NOT NULL DEFAULT '', spacetype_id TEXT NOT NULL DEFAULT 'launchpad',
    config_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')), created_by TEXT
  );
  CREATE TABLE orgs (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', owner_id TEXT NOT NULL DEFAULT '', plan_tier TEXT NOT NULL DEFAULT 'free');
  CREATE TABLE spacetypes (id TEXT PRIMARY KEY, config_schema TEXT);
`;
const NAELAO_PRODUCT_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0044_naelao_product.sql"), "utf8");
const BUILDER_DASHBOARD_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0045_builder_dashboard_api.sql"), "utf8");

function makeEnv() {
  const fakeDb = createFakeD1([SPACES_TABLE_SQL, NAELAO_PRODUCT_MIGRATION, BUILDER_DASHBOARD_MIGRATION]);
  return {
    PLATFORM_SECRET: "s",
    ENVIRONMENT: "test",
    PLATFORM_DB: fakeDb,
    BUILDER_ACCOUNT_DO: makeStatefulDoNamespace(BuilderAccountDO),
    PRODUCT_USER_DO: makeStatefulDoNamespace(ProductUserDO),
    SPACE_TYPE_REGISTRY_DO: makeStatefulDoNamespace(SpaceTypeRegistryDO),
    NAELAO_CONFIG_KV: { get: async () => null, put: async () => {} },
  };
}

function req(path: string, opts: { method?: string; body?: unknown; tenant?: string } = {}): Request {
  const headers = new Headers();
  if (opts.tenant) headers.set("x-naelao-tenant-id", opts.tenant);
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  return new Request(`https://spaces.naelao.com${path}`, {
    method: opts.method ?? "GET",
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

// The exact shape apps/dashboard/src/app/dashboard/products/new/page.tsx's launch() builds,
// with a Temple selected (spacetype_id "launchpad" + template_id "creator-store") and every
// wizard step's fields populated.
const WIZARD_LAUNCH_PAYLOAD = {
  name: "Acme Creator Store",
  spacetype_id: "launchpad",
  template_id: "creator-store",
  product_slug: "acme-store",
  product_config: {
    branding: { brandColor: "#4f46e5", logoUrl: "https://cdn.example.com/logo.png", productDescription: "A store" },
    authProvider: { provider: "naelao-native", requireAdminApproval: false, allowedEmailDomains: ["acme.com"] },
    pricingConfig: { model: "credits", creditsIncludedPerMonth: 1000, overageCreditsPriceCents: 2 },
  },
};

describe("Product Creation Wizard — launch payload round-trips through POST /builder/products", () => {
  it("creates a real product carrying the Temple's template_id, the platform slug, and every step's product_config", async () => {
    const env = makeEnv();
    const res = await spacesWorker.fetch(
      req("/builder/products", { method: "POST", tenant: "tenant-1", body: WIZARD_LAUNCH_PAYLOAD }),
      env as never, execCtx
    );
    expect(res.status).toBe(201);
    const created = await res.json() as { id: string; name: string; spacetype_id: string; status: string; product_slug: string };
    expect(created.name).toBe("Acme Creator Store");
    expect(created.spacetype_id).toBe("launchpad");
    expect(created.product_slug).toBe("acme-store");
    // No PROVISION_QUEUE bound in this test env — matches local-dev fallback, same as /spaces POST.
    expect(created.status).toBe("active");

    const detail = await (await spacesWorker.fetch(req(`/builder/products/${created.id}`, { tenant: "tenant-1" }), env as never, execCtx)).json() as {
      product_config: { branding: { brandColor: string }; authProvider: { provider: string; allowedEmailDomains: string[] }; pricingConfig: { model: string; creditsIncludedPerMonth: number } };
    };
    expect(detail.product_config.branding.brandColor).toBe("#4f46e5");
    expect(detail.product_config.authProvider.provider).toBe("naelao-native");
    expect(detail.product_config.authProvider.allowedEmailDomains).toEqual(["acme.com"]);
    expect(detail.product_config.pricingConfig.model).toBe("credits");
    expect(detail.product_config.pricingConfig.creditsIncludedPerMonth).toBe(1000);
  });

  it("registers the created product in the builder's BuilderAccountDO index (so it appears in the Products list)", async () => {
    const env = makeEnv();
    const created = await (await spacesWorker.fetch(
      req("/builder/products", { method: "POST", tenant: "tenant-1", body: WIZARD_LAUNCH_PAYLOAD }), env as never, execCtx
    )).json() as { id: string };

    const list = await (await spacesWorker.fetch(req("/builder/products", { tenant: "tenant-1" }), env as never, execCtx)).json() as { data: Array<{ id: string }> };
    expect(list.data.map((p) => p.id)).toContain(created.id);
  });

  it("rejects launch when the Identity step's slug is malformed (defense-in-depth behind client-side validation)", async () => {
    const env = makeEnv();
    const res = await spacesWorker.fetch(
      req("/builder/products", { method: "POST", tenant: "tenant-1", body: { ...WIZARD_LAUNCH_PAYLOAD, product_slug: "Not Valid!" } }),
      env as never, execCtx
    );
    expect(res.status).toBe(400);
  });

  it("without a Temple (blank SpaceType path), creates with no template_id in config_json", async () => {
    const env = makeEnv();
    const { template_id: _templateId, ...withoutTemple } = WIZARD_LAUNCH_PAYLOAD;
    const created = await (await spacesWorker.fetch(
      req("/builder/products", { method: "POST", tenant: "tenant-1", body: withoutTemple }), env as never, execCtx
    )).json() as { id: string };
    const detail = await (await spacesWorker.fetch(req(`/builder/products/${created.id}`, { tenant: "tenant-1" }), env as never, execCtx)).json() as Record<string, unknown>;
    expect(detail["template_id"]).toBeUndefined();
  });
});

describe("Product Creation Wizard — GET /builder/space-types (the Space-Type Selection step's data source)", () => {
  it("wraps SpaceTypeRegistryDO's real GET /types — an empty registry returns an empty, renderable list, not an error", async () => {
    const env = makeEnv();
    const res = await spacesWorker.fetch(req("/builder/space-types", { tenant: "tenant-1" }), env as never, execCtx);
    expect(res.status).toBe(200);
    const body = await res.json() as { types: unknown[] };
    expect(Array.isArray(body.types)).toBe(true);
  });

  it("lists a registered, approved, visible SpaceType (matches how the wizard renders 'start blank' cards)", async () => {
    const env = makeEnv();
    const registryStub = env.SPACE_TYPE_REGISTRY_DO.get(env.SPACE_TYPE_REGISTRY_DO.idFromName("global-space-type-registry"));
    await registryStub.fetch(new Request("http://registry/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        authorId: "naelao",
        manifest: {
          id: "launchpad", name: "Launchpad", description: "Build a business", version: "1.0.0",
          marketplace: { priceUsdPerMonth: 0 },
          backend: { resourceBudget: {} },
        },
      }),
    }));

    const res = await spacesWorker.fetch(req("/builder/space-types", { tenant: "tenant-1" }), env as never, execCtx);
    const body = await res.json() as { types: Array<{ id: string; name: string }> };
    expect(body.types.some((t) => t.id === "launchpad")).toBe(true);
  });
});
