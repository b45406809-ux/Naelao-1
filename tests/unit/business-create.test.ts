import { describe, it, expect } from "vitest";
import { createBusinessForEndUser } from "../../workers/spaces/src/business-create.js";
import { createFakeD1 } from "../stubs/d1-sqlite.js";

// Fills a real coverage gap the Three-Tier phased plan flagged in advance: "no route-level test
// for POST /reseller/spaces." createBusinessForEndUser (business-create.ts) is the exact logic
// that route now delegates to (Phase C extracted it so the new product-scoped wrapper,
// POST /spaces/:productSpaceId/businesses, could reuse it instead of re-implementing) — testing
// it here covers both callers at once.

const SCHEMA = [
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
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
  } as unknown as KVNamespace;
}

function makeEnv(productConfig: Record<string, unknown>) {
  const fakeDb = createFakeD1(SCHEMA);
  fakeDb.db.exec(
    `INSERT INTO spaces (id, tenant_id, status, name, config_json) VALUES ('prod-1', 'builder-tenant', 'active', 'Acme', '${JSON.stringify({ productConfig }).replace(/'/g, "''")}')`
  );
  const sentMessages: unknown[] = [];
  return {
    env: {
      PLATFORM_DB: fakeDb,
      PLATFORM_SECRET: "test-secret",
      SPACE_TYPE_REGISTRY_DO: make404RegistryDo(),
      NAELAO_CONFIG_KV: makeKv(),
      PROVISION_QUEUE: { send: async (msg: unknown) => void sentMessages.push(msg) } as unknown as Queue<unknown>,
    },
    fakeDb,
    sentMessages,
  };
}

describe("createBusinessForEndUser", () => {
  it("rejects when the product doesn't allow customer-created businesses (membershipModel 'team')", async () => {
    const { env } = makeEnv({ membershipModel: "team", allowPublicSignup: true });
    const result = await createBusinessForEndUser(env as never, {
      resellerProductSpaceId: "prod-1", userId: "u1", name: "My Biz", spacetypeId: "launchpad",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error_code).toBe("not_allowed");
  });

  it("rejects when public signup is disabled", async () => {
    const { env } = makeEnv({ membershipModel: "tenant", allowPublicSignup: false, allowedChildSpaceTypes: ["launchpad"] });
    const result = await createBusinessForEndUser(env as never, {
      resellerProductSpaceId: "prod-1", userId: "u1", name: "My Biz", spacetypeId: "launchpad",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error_code).toBe("signup_closed");
  });

  it("rejects a spacetype not in allowedChildSpaceTypes", async () => {
    const { env } = makeEnv({ membershipModel: "hybrid", allowPublicSignup: true, allowedChildSpaceTypes: ["other-type"] });
    const result = await createBusinessForEndUser(env as never, {
      resellerProductSpaceId: "prod-1", userId: "u1", name: "My Biz", spacetypeId: "launchpad",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error_code).toBe("spacetype_not_allowed");
  });

  it("404s for a nonexistent or inactive product", async () => {
    const { env } = makeEnv({ membershipModel: "tenant", allowPublicSignup: true, allowedChildSpaceTypes: ["launchpad"] });
    const result = await createBusinessForEndUser(env as never, {
      resellerProductSpaceId: "no-such-product", userId: "u1", name: "My Biz", spacetypeId: "launchpad",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error_code).toBe("not_found");
  });

  it("creates a business, mints a child tenant, and queues provisioning with the template array", async () => {
    const { env, fakeDb, sentMessages } = makeEnv({ membershipModel: "hybrid", allowPublicSignup: true, allowedChildSpaceTypes: ["launchpad"] });
    const result = await createBusinessForEndUser(env as never, {
      resellerProductSpaceId: "prod-1", userId: "u1", name: "My Biz", spacetypeId: "launchpad",
      templateIds: ["creator-store", "newsletter-business"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe("provisioning");
    expect(result.tenantId).toMatch(/^ten_/);

    const space = fakeDb.db.prepare("SELECT * FROM spaces WHERE id = ?").get(result.spaceId) as { parent_space_id: string; scenario_type: string };
    expect(space.parent_space_id).toBe("prod-1");
    expect(space.scenario_type).toBe("user-workspace");

    const hierarchy = fakeDb.db.prepare("SELECT * FROM tenant_hierarchy WHERE child_tenant_id = ?").get(result.tenantId) as { child_owner_user_id: string };
    expect(hierarchy.child_owner_user_id).toBe("u1");

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toMatchObject({ templateId: "creator-store", templateIds: ["creator-store", "newsletter-business"], userId: "u1" });
  });

  it("reuses the SAME child tenant for a second business from the same customer", async () => {
    const { env, fakeDb } = makeEnv({ membershipModel: "hybrid", allowPublicSignup: true, allowedChildSpaceTypes: ["launchpad"] });
    const first = await createBusinessForEndUser(env as never, { resellerProductSpaceId: "prod-1", userId: "u1", name: "Biz One", spacetypeId: "launchpad" });
    const second = await createBusinessForEndUser(env as never, { resellerProductSpaceId: "prod-1", userId: "u1", name: "Biz Two", spacetypeId: "launchpad" });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.tenantId).toBe(first.tenantId);

    // Only ONE tenant_hierarchy row — the second business does not re-mint a hierarchy row.
    const rows = fakeDb.db.prepare("SELECT * FROM tenant_hierarchy WHERE child_tenant_id = ?").all(first.tenantId);
    expect(rows).toHaveLength(1);
  });

  it("a DIFFERENT customer under the same product gets a DIFFERENT child tenant", async () => {
    const { env } = makeEnv({ membershipModel: "hybrid", allowPublicSignup: true, allowedChildSpaceTypes: ["launchpad"] });
    const a = await createBusinessForEndUser(env as never, { resellerProductSpaceId: "prod-1", userId: "customer-a", name: "A's Biz", spacetypeId: "launchpad" });
    const b = await createBusinessForEndUser(env as never, { resellerProductSpaceId: "prod-1", userId: "customer-b", name: "B's Biz", spacetypeId: "launchpad" });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.tenantId).not.toBe(b.tenantId);
  });
});
