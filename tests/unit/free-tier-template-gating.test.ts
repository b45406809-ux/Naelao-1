import { describe, it, expect } from "vitest";
import { createBusinessForEndUser } from "../../workers/spaces/src/business-create.js";
import { createSpaceRecord } from "../../workers/spaces/src/create-space.js";
import { checkFreeTierTemplateEligibility } from "../../workers/spaces/src/template-catalog.js";
import { createFakeD1 } from "../stubs/d1-sqlite.js";

// Spec G-BF08 (Appendix BF): LaunchpadTemplate.free_tier_eligible existed since Phase F and was
// projected to the dashboard — but NO creation path ever checked it, so a free-plan org could
// instantiate any template. This gates BOTH template entry points on the OWNING org's plan tier:
// createBusinessForEndUser (product-scoped businesses + reseller spaces) and createSpaceRecord
// (POST /spaces + POST /builder/products). Semantics under test:
//   - free tier + ineligible template  -> 403 plan_upgrade_required, no side effects
//   - free tier + eligible template    -> allowed
//   - empty template list ("Custom")   -> allowed (usage caps bound it)
//   - paid tiers                       -> unaffected (catalogue not even loaded)
//   - unknown org                      -> treated as free (tier fails CLOSED)
//   - catalogue unavailable            -> gate degrades OPEN (monetization gate, not a security
//                                         boundary; dev/test envs have no AGENTS_WORKER binding)

const CATALOG = [
  { id: "whop-seller", name: "Whop Seller", coming_soon: false, free_tier_eligible: true },
  { id: "micro-saas", name: "Micro-SaaS", coming_soon: true, free_tier_eligible: false },
  { id: "service-agency", name: "Service Agency", coming_soon: true, free_tier_eligible: false },
];

const BUSINESS_SCHEMA = [
  `CREATE TABLE spaces (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    name TEXT NOT NULL DEFAULT '', spacetype_id TEXT NOT NULL DEFAULT 'launchpad',
    config_json TEXT NOT NULL DEFAULT '{}', parent_space_id TEXT, depth INTEGER NOT NULL DEFAULT 0,
    tenancy_mode TEXT, scenario_type TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_by TEXT
  );`,
  `CREATE TABLE tenant_hierarchy (
    child_tenant_id TEXT PRIMARY KEY, parent_tenant_id TEXT NOT NULL,
    reseller_product_space_id TEXT NOT NULL, child_space_id TEXT NOT NULL,
    child_owner_user_id TEXT, status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );`,
  `CREATE TABLE reseller_accounts (
    tenant_id TEXT PRIMARY KEY, product_space_id TEXT NOT NULL,
    billing_relationship TEXT NOT NULL DEFAULT 'platform', wholesale_cents INTEGER,
    referral_share_pct REAL NOT NULL DEFAULT 0.0, status TEXT NOT NULL DEFAULT 'active',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );`,
  `CREATE TABLE orgs (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', owner_id TEXT NOT NULL DEFAULT '', plan_tier TEXT NOT NULL DEFAULT 'free');`,
  `CREATE TABLE product_end_users (product_space_id TEXT NOT NULL, end_user_id TEXT NOT NULL, email TEXT, suspended_at TEXT, deleted_at TEXT);`,
  `CREATE TABLE business_memberships (business_space_id TEXT NOT NULL, product_space_id TEXT NOT NULL, end_user_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', status TEXT NOT NULL DEFAULT 'active', joined_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (business_space_id, end_user_id));`,
];

function make404RegistryDo(): DurableObjectNamespace {
  return {
    idFromName: (name: string) => ({ toString: () => name }) as unknown as DurableObjectId,
    get: () => ({ fetch: async () => new Response("not found", { status: 404 }) }) as unknown as DurableObjectStub,
  } as unknown as DurableObjectNamespace;
}

function makeKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (k: string, type?: string) => {
      const v = store.get(k) ?? null;
      return v !== null && type === "json" ? JSON.parse(v) : v;
    },
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
  } as unknown as KVNamespace;
}

const agentsWorkerStub = {
  fetch: async () => Response.json({ templates: CATALOG }),
} as unknown as Fetcher;

const OPEN_PRODUCT_CONFIG = { membershipModel: "hybrid", allowPublicSignup: true, allowedChildSpaceTypes: ["launchpad"] };

function makeBusinessEnv(opts: { builderTier?: string; withAgentsWorker?: boolean } = {}) {
  const fakeDb = createFakeD1(BUSINESS_SCHEMA);
  fakeDb.db.exec(
    `INSERT INTO spaces (id, tenant_id, status, name, config_json) VALUES ('prod-1', 'builder-tenant', 'active', 'Acme', '${JSON.stringify({ productConfig: OPEN_PRODUCT_CONFIG }).replace(/'/g, "''")}')`
  );
  fakeDb.db.exec("INSERT INTO product_end_users (product_space_id, end_user_id) VALUES ('prod-1', 'u1')");
  if (opts.builderTier) {
    fakeDb.db.exec(`INSERT INTO orgs (id, plan_tier) VALUES ('builder-tenant', '${opts.builderTier}')`);
  }
  return {
    env: {
      PLATFORM_DB: fakeDb,
      PLATFORM_SECRET: "test-secret",
      LOCK_DO: { idFromName: (name: string) => name, get: () => ({ fetch: async (request: Request) =>
        request.url.endsWith("/acquire") ? Response.json({ acquired: true }) : Response.json({ released: true }) }) },
      SPACE_TYPE_REGISTRY_DO: make404RegistryDo(),
      NAELAO_CONFIG_KV: makeKv(),
      ...(opts.withAgentsWorker !== false ? { AGENTS_WORKER: agentsWorkerStub } : {}),
    },
    fakeDb,
  };
}

async function createBiz(env: unknown, templateIds: string[] | undefined) {
  return createBusinessForEndUser(env as never, {
    resellerProductSpaceId: "prod-1", userId: "u1", name: "My Biz", spacetypeId: "launchpad",
    ...(templateIds ? { templateIds } : {}),
  });
}

describe("G-BF08 — free-tier template gating: createBusinessForEndUser", () => {
  it("blocks a free-tier org from a non-eligible template, naming it", async () => {
    const { env } = makeBusinessEnv({ builderTier: "free" });
    const result = await createBiz(env, ["micro-saas"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("plan_upgrade_required");
      expect(result.status).toBe(403);
      expect(result.message).toContain("micro-saas");
    }
  });

  it("blocks a mixed selection when ANY template is ineligible", async () => {
    const { env } = makeBusinessEnv({ builderTier: "free" });
    const result = await createBiz(env, ["whop-seller", "service-agency"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("plan_upgrade_required");
      expect(result.message).toContain("service-agency");
      expect(result.message).not.toContain("whop-seller");
    }
  });

  it("a rejected create leaves NO side effects (no space, no tenant, no reseller account)", async () => {
    const { env, fakeDb } = makeBusinessEnv({ builderTier: "free" });
    const result = await createBiz(env, ["micro-saas"]);
    expect(result.ok).toBe(false);
    expect((fakeDb.db.prepare("SELECT COUNT(*) AS c FROM spaces WHERE id != 'prod-1'").get() as { c: number }).c).toBe(0);
    expect((fakeDb.db.prepare("SELECT COUNT(*) AS c FROM tenant_hierarchy").get() as { c: number }).c).toBe(0);
    expect((fakeDb.db.prepare("SELECT COUNT(*) AS c FROM reseller_accounts").get() as { c: number }).c).toBe(0);
  });

  it("allows a free-tier org to use a free_tier_eligible template", async () => {
    const { env } = makeBusinessEnv({ builderTier: "free" });
    const result = await createBiz(env, ["whop-seller"]);
    expect(result.ok).toBe(true);
  });

  it("allows Custom (no templates) on the free tier", async () => {
    const { env } = makeBusinessEnv({ builderTier: "free" });
    const result = await createBiz(env, undefined);
    expect(result.ok).toBe(true);
  });

  it("paid tiers are unaffected by eligibility", async () => {
    for (const tier of ["growth", "business", "enterprise"]) {
      const { env } = makeBusinessEnv({ builderTier: tier });
      const result = await createBiz(env, ["micro-saas"]);
      expect(result.ok, `tier ${tier} should pass`).toBe(true);
    }
  });

  it("an org with no orgs row is treated as free (tier fails closed)", async () => {
    const { env } = makeBusinessEnv({}); // no orgs row for builder-tenant
    const result = await createBiz(env, ["micro-saas"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error_code).toBe("plan_upgrade_required");
  });

  it("an unknown stored tier also fails closed instead of bypassing eligibility", async () => {
    const { env } = makeBusinessEnv({ builderTier: "not-a-real-tier" });
    const result = await createBiz(env, ["micro-saas"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error_code).toBe("plan_upgrade_required");
  });

  it("degrades OPEN when the catalogue is unavailable (no AGENTS_WORKER binding)", async () => {
    const { env } = makeBusinessEnv({ builderTier: "free", withAgentsWorker: false });
    const result = await createBiz(env, ["micro-saas"]);
    expect(result.ok).toBe(true);
  });
});

const SPACES_TABLE_SQL = `
  CREATE TABLE spaces (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    name TEXT NOT NULL DEFAULT '', spacetype_id TEXT NOT NULL DEFAULT 'launchpad',
    config_json TEXT NOT NULL DEFAULT '{}', product_slug TEXT, parent_space_id TEXT, depth INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_by TEXT
  );
  CREATE TABLE orgs (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', owner_id TEXT NOT NULL DEFAULT '', plan_tier TEXT NOT NULL DEFAULT 'free');
  CREATE TABLE spacetypes (id TEXT PRIMARY KEY, schema_json TEXT);
`;

describe("G-BF08 — free-tier template gating: createSpaceRecord (POST /spaces + /builder/products)", () => {
  it("throws plan_upgrade_required for a free-tier org requesting an ineligible template", async () => {
    const fakeDb = createFakeD1([SPACES_TABLE_SQL]);
    await expect(
      createSpaceRecord(
        { PLATFORM_DB: fakeDb, NAELAO_CONFIG_KV: makeKv(), AGENTS_WORKER: agentsWorkerStub },
        { tenantId: "tenant-1", name: "A", spacetypeId: "launchpad", templateId: "micro-saas" }
      )
    ).rejects.toMatchObject({ error_code: "plan_upgrade_required", status: 403 });
  });

  it("allows an eligible template on the free tier, and any template without one", async () => {
    const fakeDb = createFakeD1([SPACES_TABLE_SQL]);
    const env = { PLATFORM_DB: fakeDb, NAELAO_CONFIG_KV: makeKv(), AGENTS_WORKER: agentsWorkerStub };
    await expect(
      createSpaceRecord(env, { tenantId: "tenant-1", name: "A", spacetypeId: "launchpad", templateId: "whop-seller" })
    ).resolves.toBeDefined();
    await expect(
      createSpaceRecord(env, { tenantId: "tenant-1", name: "B", spacetypeId: "launchpad" })
    ).resolves.toBeDefined();
  });

  it("a paid-tier org may use any template", async () => {
    const fakeDb = createFakeD1([SPACES_TABLE_SQL]);
    fakeDb.db.exec("INSERT INTO orgs (id, plan_tier) VALUES ('tenant-1', 'growth')");
    await expect(
      createSpaceRecord(
        { PLATFORM_DB: fakeDb, NAELAO_CONFIG_KV: makeKv(), AGENTS_WORKER: agentsWorkerStub },
        { tenantId: "tenant-1", name: "A", spacetypeId: "launchpad", templateId: "micro-saas" }
      )
    ).resolves.toBeDefined();
  });

  it("stays backwards-compatible with envs that lack the catalogue bindings entirely", async () => {
    const fakeDb = createFakeD1([SPACES_TABLE_SQL]);
    await expect(
      createSpaceRecord({ PLATFORM_DB: fakeDb }, { tenantId: "tenant-1", name: "A", spacetypeId: "launchpad", templateId: "micro-saas" })
    ).resolves.toBeDefined();
  });
});

describe("G-BF08 — checkFreeTierTemplateEligibility caches the catalogue (v2 key)", () => {
  it("second check reuses KV instead of re-hitting the agents worker", async () => {
    const fakeDb = createFakeD1([`CREATE TABLE orgs (id TEXT PRIMARY KEY, plan_tier TEXT NOT NULL DEFAULT 'free');`]);
    let fetches = 0;
    const countingWorker = { fetch: async () => { fetches++; return Response.json({ templates: CATALOG }); } } as unknown as Fetcher;
    const env = { NAELAO_CONFIG_KV: makeKv(), AGENTS_WORKER: countingWorker };
    await checkFreeTierTemplateEligibility(fakeDb, env, "t1", ["whop-seller"]);
    await checkFreeTierTemplateEligibility(fakeDb, env, "t1", ["whop-seller"]);
    expect(fetches).toBe(1);
  });
});
