import { describe, it, expect, vi } from "vitest";
import { createSpaceRecord, SpaceCreationError } from "../../workers/spaces/src/create-space.js";
import { createFakeD1 } from "../stubs/d1-sqlite.js";

// Three-Tier Platform Model, Phase 4. createSpaceRecord is the single space-creation code path
// shared by /spaces POST and /builder/products POST (Phase 3's first draft of the latter
// reimplemented a bare INSERT instead — a real split-brain, fixed here).
//
// Writing this test surfaced a genuine, PRE-EXISTING production bug, not something this phase
// introduced: enforceSpaceQuota queried a table called "organizations", which no migration
// anywhere creates — the real table is `orgs` (infra/migrations/0002_orgs.sql). Since nothing in
// this repo's test suite exercised POST /spaces before this phase, this had never been caught —
// every real space creation call would have hard-500'd. Fixed to query `orgs`.

const SPACES_TABLE_SQL = `
  CREATE TABLE spaces (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    name TEXT NOT NULL DEFAULT '', spacetype_id TEXT NOT NULL DEFAULT 'launchpad',
    config_json TEXT NOT NULL DEFAULT '{}', product_slug TEXT, parent_space_id TEXT, depth INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_by TEXT
  );
  CREATE UNIQUE INDEX idx_spaces_product_slug ON spaces(product_slug) WHERE product_slug IS NOT NULL;
  CREATE TABLE orgs (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', owner_id TEXT NOT NULL DEFAULT '', plan_tier TEXT NOT NULL DEFAULT 'free');
  CREATE TABLE spacetypes (id TEXT PRIMARY KEY, schema_json TEXT);
`;

function makeDb() {
  return createFakeD1([SPACES_TABLE_SQL]);
}

describe("createSpaceRecord — quota enforcement queries the REAL orgs table", () => {
  it("does not throw 'no such table' — regression test for the organizations/orgs bug", async () => {
    const fakeDb = makeDb();
    await expect(
      createSpaceRecord({ PLATFORM_DB: fakeDb }, { tenantId: "tenant-1", name: "A", spacetypeId: "launchpad" })
    ).resolves.toBeDefined();
  });

  it("defaults to the free tier (limit 3) when no orgs row exists for the tenant", async () => {
    const fakeDb = makeDb();
    for (let i = 0; i < 3; i++) {
      await createSpaceRecord({ PLATFORM_DB: fakeDb }, { tenantId: "tenant-1", name: `Space ${i}`, spacetypeId: "launchpad" });
    }
    await expect(
      createSpaceRecord({ PLATFORM_DB: fakeDb }, { tenantId: "tenant-1", name: "One too many", spacetypeId: "launchpad" })
    ).rejects.toMatchObject({ error_code: "quota_exceeded", status: 402 });
  });

  it("respects a higher plan_tier limit from the real orgs row", async () => {
    const fakeDb = makeDb();
    fakeDb.db.exec("INSERT INTO orgs (id, plan_tier) VALUES ('tenant-1', 'pro')");
    // pro limit is 100 — 3 creations should NOT trip the free-tier limit of 3.
    for (let i = 0; i < 4; i++) {
      await createSpaceRecord({ PLATFORM_DB: fakeDb }, { tenantId: "tenant-1", name: `Space ${i}`, spacetypeId: "launchpad" });
    }
    const row = await fakeDb.prepare("SELECT COUNT(*) as n FROM spaces WHERE tenant_id = ?").bind("tenant-1").first<{ n: number }>();
    expect(row?.n).toBe(4);
  });
});

describe("createSpaceRecord — product_slug", () => {
  it("rejects a malformed slug before touching the database", async () => {
    const fakeDb = makeDb();
    await expect(
      createSpaceRecord({ PLATFORM_DB: fakeDb }, { tenantId: "t1", name: "A", spacetypeId: "launchpad", productSlug: "Not Valid!" })
    ).rejects.toMatchObject({ error_code: "bad_request", status: 400 });
  });

  it("enforces platform-wide slug uniqueness with a 409", async () => {
    const fakeDb = makeDb();
    await createSpaceRecord({ PLATFORM_DB: fakeDb }, { tenantId: "t1", name: "A", spacetypeId: "launchpad", productSlug: "my-shop" });
    await expect(
      createSpaceRecord({ PLATFORM_DB: fakeDb }, { tenantId: "t2", name: "B", spacetypeId: "launchpad", productSlug: "my-shop" })
    ).rejects.toMatchObject({ error_code: "conflict", status: 409 });
  });

  it.each([
    "www", "api", "admin", "login", "billing", "status", "dashboard",
    "support", "staging", "prod", "webhooks", "cdn", "naelao",
  ])("rejects reserved slug '%s' to prevent subdomain phishing", async (slug) => {
    const fakeDb = makeDb();
    await expect(
      createSpaceRecord({ PLATFORM_DB: fakeDb }, { tenantId: "t1", name: "A", spacetypeId: "launchpad", productSlug: slug })
    ).rejects.toMatchObject({ error_code: "bad_request", status: 400, message: expect.stringContaining("reserved") });
  });

  it("accepts a legitimate non-reserved slug", async () => {
    const fakeDb = makeDb();
    const result = await createSpaceRecord({ PLATFORM_DB: fakeDb }, { tenantId: "t1", name: "A", spacetypeId: "launchpad", productSlug: "my-awesome-shop" });
    expect(result.id).toBeTruthy();
  });

  // The Product Shell resolves every end-user URL as /p/{product_slug}. A product created without
  // one provisioned fine, reported `active`, and could never be opened — by its owner or by a
  // single customer. The wizard called the field optional, and nothing anywhere sets it later.
  it("derives a slug from the name when none is given, so the product is reachable", async () => {
    const fakeDb = makeDb();
    const result = await createSpaceRecord({ PLATFORM_DB: fakeDb }, { tenantId: "t1", name: "Acme Creator Store", spacetypeId: "launchpad" });
    const row = await fakeDb.prepare("SELECT product_slug FROM spaces WHERE id = ?").bind(result.id).first<{ product_slug: string }>();
    expect(row?.product_slug).toBe("acme-creator-store");
  });

  it("works around a taken name rather than failing on a field the builder never filled in", async () => {
    const fakeDb = makeDb();
    await createSpaceRecord({ PLATFORM_DB: fakeDb }, { tenantId: "t1", name: "Launchpad", spacetypeId: "launchpad" });
    const second = await createSpaceRecord({ PLATFORM_DB: fakeDb }, { tenantId: "t2", name: "Launchpad", spacetypeId: "launchpad" });
    const row = await fakeDb.prepare("SELECT product_slug FROM spaces WHERE id = ?").bind(second.id).first<{ product_slug: string }>();
    expect(row?.product_slug).toMatch(/^launchpad-[a-z0-9]{4}$/);
  });

  it("never derives a reserved slug", async () => {
    // "Admin" is a perfectly reasonable product name and a slug that must never be handed out.
    const fakeDb = makeDb();
    const result = await createSpaceRecord({ PLATFORM_DB: fakeDb }, { tenantId: "t1", name: "Admin", spacetypeId: "launchpad" });
    const row = await fakeDb.prepare("SELECT product_slug FROM spaces WHERE id = ?").bind(result.id).first<{ product_slug: string | null }>();
    expect(row?.product_slug).not.toBe("admin");
  });

  it("creates the product anyway when no usable slug can be derived", async () => {
    // Degrading to slugless is the old behavior — a name of pure punctuation must not block
    // creation over a convenience value the builder never asked for.
    const fakeDb = makeDb();
    const result = await createSpaceRecord({ PLATFORM_DB: fakeDb }, { tenantId: "t1", name: "!!!", spacetypeId: "launchpad" });
    expect(result.id).toBeTruthy();
    const row = await fakeDb.prepare("SELECT product_slug FROM spaces WHERE id = ?").bind(result.id).first<{ product_slug: string | null }>();
    expect(row?.product_slug).toBeNull();
  });
});

describe("createSpaceRecord — provisioning", () => {
  it("with no PROVISION_QUEUE bound, creates immediately 'active' and enqueues nothing", async () => {
    const fakeDb = makeDb();
    const result = await createSpaceRecord({ PLATFORM_DB: fakeDb }, { tenantId: "t1", name: "A", spacetypeId: "launchpad" });
    expect(result.status).toBe("active");
  });

  it("with PROVISION_QUEUE bound, creates as 'provisioning' and enqueues templateId", async () => {
    const fakeDb = makeDb();
    const send = vi.fn(async () => {});
    const result = await createSpaceRecord(
      { PLATFORM_DB: fakeDb, PROVISION_QUEUE: { send } as never },
      { tenantId: "t1", name: "A", spacetypeId: "launchpad", templateId: "creator-store", userId: "user-1" }
    );
    expect(result.status).toBe("provisioning");
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: "space_provision", spaceId: result.id, tenantId: "t1", templateId: "creator-store", userId: "user-1",
    }));
  });

  it("persists template_id into config_json so the space record is self-describing", async () => {
    const fakeDb = makeDb();
    const result = await createSpaceRecord({ PLATFORM_DB: fakeDb }, { tenantId: "t1", name: "A", spacetypeId: "launchpad", templateId: "creator-store" });
    const row = await fakeDb.prepare("SELECT config_json FROM spaces WHERE id = ?").bind(result.id).first<{ config_json: string }>();
    expect(JSON.parse(row!.config_json)).toMatchObject({ template_id: "creator-store" });
  });

  it("merges productConfig overrides (e.g. from the wizard's branding/pricing/auth steps) into config_json", async () => {
    const fakeDb = makeDb();
    const result = await createSpaceRecord(
      { PLATFORM_DB: fakeDb },
      { tenantId: "t1", name: "A", spacetypeId: "launchpad", configOverrides: { productConfig: { branding: { brandColor: "#ff0000" } } } }
    );
    const row = await fakeDb.prepare("SELECT config_json FROM spaces WHERE id = ?").bind(result.id).first<{ config_json: string }>();
    expect(JSON.parse(row!.config_json)).toMatchObject({ productConfig: { branding: { brandColor: "#ff0000" } } });
  });

  // The proactive tick infrastructure (hourly cron + near-real-time channel triggers) already
  // runs continuously; the digest email that reports on it was opt-in and off by default, so a
  // builder who never found the toggle got no visibility. Defaulted ON here unless the caller
  // already made an explicit choice.
  it("defaults the daily digest email ON when the caller doesn't specify it", async () => {
    const fakeDb = makeDb();
    const result = await createSpaceRecord({ PLATFORM_DB: fakeDb }, { tenantId: "t1", name: "A", spacetypeId: "launchpad" });
    const row = await fakeDb.prepare("SELECT config_json FROM spaces WHERE id = ?").bind(result.id).first<{ config_json: string }>();
    expect(JSON.parse(row!.config_json)).toMatchObject({ productConfig: { notificationsConfig: { dailyDigestEnabled: true } } });
  });

  it("respects an explicit dailyDigestEnabled: false rather than overriding it", async () => {
    const fakeDb = makeDb();
    const result = await createSpaceRecord(
      { PLATFORM_DB: fakeDb },
      { tenantId: "t1", name: "A", spacetypeId: "launchpad", configOverrides: { productConfig: { notificationsConfig: { dailyDigestEnabled: false } } } }
    );
    const row = await fakeDb.prepare("SELECT config_json FROM spaces WHERE id = ?").bind(result.id).first<{ config_json: string }>();
    expect(JSON.parse(row!.config_json)).toMatchObject({ productConfig: { notificationsConfig: { dailyDigestEnabled: false } } });
  });

  it("preserves other productConfig fields alongside the defaulted digest setting", async () => {
    const fakeDb = makeDb();
    const result = await createSpaceRecord(
      { PLATFORM_DB: fakeDb },
      { tenantId: "t1", name: "A", spacetypeId: "launchpad", configOverrides: { productConfig: { branding: { brandColor: "#ff0000" } } } }
    );
    const row = await fakeDb.prepare("SELECT config_json FROM spaces WHERE id = ?").bind(result.id).first<{ config_json: string }>();
    expect(JSON.parse(row!.config_json)).toMatchObject({
      productConfig: { branding: { brandColor: "#ff0000" }, notificationsConfig: { dailyDigestEnabled: true } },
    });
  });
});

describe("createSpaceRecord — config schema validation (G-AV02)", () => {
  it("rejects overrides that fail the SpaceType's declared config_schema", async () => {
    const fakeDb = makeDb();
    fakeDb.db.exec(
      `INSERT INTO spacetypes (id, schema_json) VALUES ('launchpad', '${JSON.stringify({
        required: ["storefront_name"],
        properties: { storefront_name: { type: "string", minLength: 3 } },
      })}')`
    );
    await expect(
      createSpaceRecord({ PLATFORM_DB: fakeDb }, { tenantId: "t1", name: "A", spacetypeId: "launchpad", configOverrides: { storefront_name: "ab" } })
    ).rejects.toBeInstanceOf(SpaceCreationError);
  });

  it("accepts overrides that satisfy the schema", async () => {
    const fakeDb = makeDb();
    fakeDb.db.exec(
      `INSERT INTO spacetypes (id, schema_json) VALUES ('launchpad', '${JSON.stringify({
        required: ["storefront_name"],
        properties: { storefront_name: { type: "string", minLength: 3 } },
      })}')`
    );
    await expect(
      createSpaceRecord({ PLATFORM_DB: fakeDb }, { tenantId: "t1", name: "A", spacetypeId: "launchpad", configOverrides: { storefront_name: "My Shop" } })
    ).resolves.toBeDefined();
  });
});
