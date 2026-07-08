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
    config_json TEXT NOT NULL DEFAULT '{}', product_slug TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_by TEXT
  );
  CREATE UNIQUE INDEX idx_spaces_product_slug ON spaces(product_slug) WHERE product_slug IS NOT NULL;
  CREATE TABLE orgs (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', owner_id TEXT NOT NULL DEFAULT '', plan_tier TEXT NOT NULL DEFAULT 'free');
  CREATE TABLE spacetypes (id TEXT PRIMARY KEY, config_schema TEXT);
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
});

describe("createSpaceRecord — config schema validation (G-AV02)", () => {
  it("rejects overrides that fail the SpaceType's declared config_schema", async () => {
    const fakeDb = makeDb();
    fakeDb.db.exec(
      `INSERT INTO spacetypes (id, config_schema) VALUES ('launchpad', '${JSON.stringify({
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
      `INSERT INTO spacetypes (id, config_schema) VALUES ('launchpad', '${JSON.stringify({
        required: ["storefront_name"],
        properties: { storefront_name: { type: "string", minLength: 3 } },
      })}')`
    );
    await expect(
      createSpaceRecord({ PLATFORM_DB: fakeDb }, { tenantId: "t1", name: "A", spacetypeId: "launchpad", configOverrides: { storefront_name: "My Shop" } })
    ).resolves.toBeDefined();
  });
});
