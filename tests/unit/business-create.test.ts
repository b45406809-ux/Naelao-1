import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createBusinessForEndUser } from "../../workers/spaces/src/business-create.js";
import { LockDO } from "../../workers/spaces/src/do/LockDO.js";
import { createDOStorage } from "./helpers/sqlite-do-shim.js";
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
    created_by TEXT, deleted_at TEXT
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
  `CREATE TABLE product_end_users (
    product_space_id TEXT NOT NULL, end_user_id TEXT NOT NULL, email TEXT, suspended_at TEXT, deleted_at TEXT,
    PRIMARY KEY (product_space_id, end_user_id)
  );`,
  `CREATE TABLE business_memberships (
    business_space_id TEXT NOT NULL, product_space_id TEXT NOT NULL, end_user_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member', status TEXT NOT NULL DEFAULT 'active',
    invited_by TEXT, joined_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (business_space_id, end_user_id)
  );`,
  readFileSync(new URL("../../infra/migrations/0126_space_provisioning_outbox.sql", import.meta.url), "utf8"),
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

function makeLockDoNamespace(): DurableObjectNamespace {
  const instances = new Map<string, LockDO>();
  return {
    idFromName: (name: string) => ({ toString: () => name }) as unknown as DurableObjectId,
    get: (id: DurableObjectId) => {
      const name = id.toString();
      let object = instances.get(name);
      if (!object) { object = new LockDO({ storage: createDOStorage() } as never, {} as never); instances.set(name, object); }
      return { fetch: (request: Request) => object!.fetch(request) } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
}

/** Phase 4 (money): a fake PRODUCT_USER_DO namespace whose /plan-tier reads a fixed tier per
 *  (productId:endUserId) key — enough to exercise resolveEffectiveBusinessLimit's real wiring
 *  through createBusinessForEndUser without a real DO. */
function makeProductUserDoNamespace(tierByKey: Record<string, string>): DurableObjectNamespace {
  return {
    idFromName: (name: string) => ({ toString: () => name }) as unknown as DurableObjectId,
    get: (id: DurableObjectId) => ({
      fetch: async (req: Request) => {
        const url = new URL(req.url);
        if (url.pathname === "/plan-tier") {
          // The real name is an HMAC of "produser:{productId}:{endUserId}" — the fake stashes
          // the un-hashed key as the id string itself (idFromName above), so match on suffix.
          const idStr = id.toString();
          const matchedKey = Object.keys(tierByKey).find((k) => idStr.endsWith(k));
          return Response.json({ plan_tier: matchedKey ? tierByKey[matchedKey] : "free" });
        }
        return new Response("not found", { status: 404 });
      },
    }) as unknown as DurableObjectStub,
  } as unknown as DurableObjectNamespace;
}

function makeEnv(productConfig: Record<string, unknown>, opts?: { personalPlanTierByKey?: Record<string, string> }) {
  const fakeDb = createFakeD1(SCHEMA);
  fakeDb.db.exec(
    `INSERT INTO spaces (id, tenant_id, status, name, config_json) VALUES ('prod-1', 'builder-tenant', 'active', 'Acme', '${JSON.stringify({ productConfig }).replace(/'/g, "''")}')`
  );
  for (const userId of ["u1", "u2", "customer-a", "customer-b", "u-free", "u-plus", "u-nodo", "u-atcap"]) {
    fakeDb.db.prepare("INSERT INTO product_end_users (product_space_id, end_user_id) VALUES ('prod-1', ?)").run(userId);
  }
  const sentMessages: unknown[] = [];
  return {
    env: {
      PLATFORM_DB: fakeDb,
      PLATFORM_SECRET: "test-secret",
      LOCK_DO: makeLockDoNamespace(),
      SPACE_TYPE_REGISTRY_DO: make404RegistryDo(),
      NAELAO_CONFIG_KV: makeKv(),
      PROVISION_QUEUE: { send: async (msg: unknown) => void sentMessages.push(msg) } as unknown as Queue<unknown>,
      ...(opts?.personalPlanTierByKey ? { PRODUCT_USER_DO: makeProductUserDoNamespace(opts.personalPlanTierByKey) } : {}),
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

  // Found by walking the real end-user journey on a live deployment: this refusal used to say
  // "Public signup is disabled for this product" — moments after a customer had visibly signed up
  // fine, because end-user signup is a different route that never reads this flag. A builder would
  // go hunting for a signup setting that does not exist. The message must name what is actually
  // off and where to turn it on.
  it("rejects business creation with a message that does not misdirect to 'signup'", async () => {
    const { env } = makeEnv({ membershipModel: "tenant", allowPublicSignup: false, allowedChildSpaceTypes: ["launchpad"] });
    const result = await createBusinessForEndUser(env as never, {
      resellerProductSpaceId: "prod-1", userId: "u1", name: "My Biz", spacetypeId: "launchpad",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("business_creation_disabled");
      expect(result.message).toMatch(/create their own businesses/i);
      // The whole point: never blame signup for a business-creation gate.
      expect(result.message.toLowerCase()).not.toContain("signup");
      // And point at the real control, so the builder knows what to do next.
      expect(result.message).toMatch(/Product Mode/i);
    }
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

  it("retains the business and atomic queue intent when queue delivery fails", async () => {
    const { env, fakeDb } = makeEnv({ membershipModel: "hybrid", allowPublicSignup: true, allowedChildSpaceTypes: ["launchpad"] });
    env.PROVISION_QUEUE = { send: async () => { throw new Error("queue unavailable"); } } as unknown as Queue<unknown>;
    const result = await createBusinessForEndUser(env as never, {
      resellerProductSpaceId: "prod-1", userId: "u1", name: "My Biz", spacetypeId: "launchpad",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fakeDb.db.prepare("SELECT status FROM spaces WHERE id = ?").get(result.spaceId)).toEqual({ status: "provisioning" });
    expect(fakeDb.db.prepare("SELECT status, attempt_count FROM space_provisioning_outbox WHERE space_id = ?").get(result.spaceId))
      .toEqual({ status: "pending", attempt_count: 1 });
    expect(fakeDb.db.prepare("SELECT COUNT(*) AS count FROM business_memberships WHERE business_space_id = ?").get(result.spaceId))
      .toEqual({ count: 1 });
  });

  it("rolls back the space, hierarchy, membership, and outbox together on a mid-batch write failure", async () => {
    const { env, fakeDb } = makeEnv({ membershipModel: "hybrid", allowPublicSignup: true, allowedChildSpaceTypes: ["launchpad"] });
    fakeDb.db.exec(`CREATE TRIGGER fail_business_membership BEFORE INSERT ON business_memberships
      BEGIN SELECT RAISE(ABORT, 'simulated membership storage failure'); END;`);
    const result = await createBusinessForEndUser(env as never, {
      resellerProductSpaceId: "prod-1", userId: "u1", name: "My Biz", spacetypeId: "launchpad",
    });
    expect(result).toMatchObject({ ok: false, error_code: "business_creation_unavailable", status: 503 });
    expect(fakeDb.db.prepare("SELECT COUNT(*) AS count FROM spaces WHERE parent_space_id = 'prod-1'").get())
      .toEqual({ count: 0 });
    expect(fakeDb.db.prepare("SELECT COUNT(*) AS count FROM tenant_hierarchy").get()).toEqual({ count: 0 });
    expect(fakeDb.db.prepare("SELECT COUNT(*) AS count FROM business_memberships").get()).toEqual({ count: 0 });
    expect(fakeDb.db.prepare("SELECT COUNT(*) AS count FROM space_provisioning_outbox").get()).toEqual({ count: 0 });
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

  it("F-19: caps the number of businesses a single end user can create (default 10)", async () => {
    const { env } = makeEnv({ membershipModel: "hybrid", allowPublicSignup: true, allowedChildSpaceTypes: ["launchpad"], maxBusinessesPerEndUser: 2 });
    const first = await createBusinessForEndUser(env as never, { resellerProductSpaceId: "prod-1", userId: "u1", name: "Biz 1", spacetypeId: "launchpad" });
    const second = await createBusinessForEndUser(env as never, { resellerProductSpaceId: "prod-1", userId: "u1", name: "Biz 2", spacetypeId: "launchpad" });
    const third = await createBusinessForEndUser(env as never, { resellerProductSpaceId: "prod-1", userId: "u1", name: "Biz 3", spacetypeId: "launchpad" });
    expect(first.ok && second.ok).toBe(true);
    expect(third.ok).toBe(false);
    if (!third.ok) {
      expect(third.error_code).toBe("business_limit_reached");
      expect(third.status).toBe(429);
    }
    // A DIFFERENT user is unaffected by u1's cap.
    const other = await createBusinessForEndUser(env as never, { resellerProductSpaceId: "prod-1", userId: "u2", name: "Other", spacetypeId: "launchpad" });
    expect(other.ok).toBe(true);
  });

  // Phase 4 (money): the personal-plan tier combines with the product's own configured ceiling.
  describe("personal-plan tier narrows/widens the F-19 ceiling (resolveEffectiveBusinessLimit)", () => {
    it("a FREE-tier user is capped at 3 even though the product allows up to 10 (the default)", async () => {
      const { env } = makeEnv(
        { membershipModel: "hybrid", allowPublicSignup: true, allowedChildSpaceTypes: ["launchpad"] }, // default maxBusinessesPerEndUser = 10
        { personalPlanTierByKey: { "prod-1:u-free": "free" } }
      );
      for (let i = 1; i <= 3; i++) {
        const r = await createBusinessForEndUser(env as never, { resellerProductSpaceId: "prod-1", userId: "u-free", name: `Biz ${i}`, spacetypeId: "launchpad" });
        expect(r.ok).toBe(true);
      }
      const fourth = await createBusinessForEndUser(env as never, { resellerProductSpaceId: "prod-1", userId: "u-free", name: "Biz 4", spacetypeId: "launchpad" });
      expect(fourth.ok).toBe(false);
      if (!fourth.ok) {
        expect(fourth.error_code).toBe("business_limit_reached");
        // A real, actionable hint since the product's own ceiling (10) is higher than what
        // this free-tier user actually got (3) — they can genuinely unlock more by upgrading.
        expect(fourth.message).toMatch(/upgrade/i);
      }
    });

    it("a PLUS-tier user gets the FULL product ceiling (10), not squeezed to the free-tier number", async () => {
      const { env } = makeEnv(
        { membershipModel: "hybrid", allowPublicSignup: true, allowedChildSpaceTypes: ["launchpad"] },
        { personalPlanTierByKey: { "prod-1:u-plus": "plus" } }
      );
      for (let i = 1; i <= 4; i++) {
        // 4 > the free cap of 3 — proves this user is NOT on the free ceiling.
        const r = await createBusinessForEndUser(env as never, { resellerProductSpaceId: "prod-1", userId: "u-plus", name: `Biz ${i}`, spacetypeId: "launchpad" });
        expect(r.ok).toBe(true);
      }
    });

    it("a personal plan NEVER widens past the product's own configured ceiling, even on 'plus'", async () => {
      const { env } = makeEnv(
        { membershipModel: "hybrid", allowPublicSignup: true, allowedChildSpaceTypes: ["launchpad"], maxBusinessesPerEndUser: 1 },
        { personalPlanTierByKey: { "prod-1:u-plus": "plus" } }
      );
      const first = await createBusinessForEndUser(env as never, { resellerProductSpaceId: "prod-1", userId: "u-plus", name: "Biz 1", spacetypeId: "launchpad" });
      expect(first.ok).toBe(true);
      const second = await createBusinessForEndUser(env as never, { resellerProductSpaceId: "prod-1", userId: "u-plus", name: "Biz 2", spacetypeId: "launchpad" });
      expect(second.ok).toBe(false); // the builder's own ceiling (1) is the hard outer bound
    });

    it("fails CLOSED to the free-tier cap (not the flat product ceiling) when PRODUCT_USER_DO isn't bound — a missing binding never grants MORE than intended", async () => {
      // No personalPlanTierByKey passed — makeEnv omits PRODUCT_USER_DO entirely (every real
      // deployment binds it; this exercises resolvePersonalPlanTier's own documented fail-closed
      // default of 'free' rather than silently bypassing the whole gate).
      const { env } = makeEnv({ membershipModel: "hybrid", allowPublicSignup: true, allowedChildSpaceTypes: ["launchpad"], maxBusinessesPerEndUser: 5 });
      for (let i = 1; i <= 3; i++) {
        const r = await createBusinessForEndUser(env as never, { resellerProductSpaceId: "prod-1", userId: "u-nodo", name: `Biz ${i}`, spacetypeId: "launchpad" });
        expect(r.ok).toBe(true);
      }
      const fourth = await createBusinessForEndUser(env as never, { resellerProductSpaceId: "prod-1", userId: "u-nodo", name: "Biz 4", spacetypeId: "launchpad" });
      expect(fourth.ok).toBe(false); // capped at 3 (free-tier default), NOT the product's own 5
    });

    it("a product ceiling AT OR BELOW the free-tier cap is completely unaffected by this whole feature (exact pre-Phase-4 behavior)", async () => {
      // The pre-existing F-19 test above (maxBusinessesPerEndUser: 2, no PRODUCT_USER_DO) already
      // covers this implicitly (min(2,3)=2 === the old flat 2) — this makes the invariant explicit.
      const { env } = makeEnv({ membershipModel: "hybrid", allowPublicSignup: true, allowedChildSpaceTypes: ["launchpad"], maxBusinessesPerEndUser: 3 });
      for (let i = 1; i <= 3; i++) {
        const r = await createBusinessForEndUser(env as never, { resellerProductSpaceId: "prod-1", userId: "u-atcap", name: `Biz ${i}`, spacetypeId: "launchpad" });
        expect(r.ok).toBe(true);
      }
      const fourth = await createBusinessForEndUser(env as never, { resellerProductSpaceId: "prod-1", userId: "u-atcap", name: "Biz 4", spacetypeId: "launchpad" });
      expect(fourth.ok).toBe(false);
    });
  });
});
