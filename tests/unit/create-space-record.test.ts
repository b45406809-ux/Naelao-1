import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createSpaceRecord, SpaceCreationError } from "../../workers/spaces/src/create-space.js";
import { dispatchPendingProvisioningOutbox } from "../../workers/spaces/src/provisioning-outbox.js";
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
  CREATE TABLE space_members (id TEXT PRIMARY KEY, space_id TEXT NOT NULL, tenant_id TEXT NOT NULL,
    end_user_id TEXT NOT NULL, role TEXT NOT NULL, UNIQUE(space_id, end_user_id));
`;

function makeDb() {
  const outboxMigration = readFileSync(new URL("../../infra/migrations/0126_space_provisioning_outbox.sql", import.meta.url), "utf8");
  const productMigration = readFileSync(new URL("../../infra/migrations/0156_product_registry.sql", import.meta.url), "utf8");
  return createFakeD1([SPACES_TABLE_SQL, outboxMigration, productMigration]);
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

  it.each([["growth", 25], ["business", 100]])("uses the configured %s space ceiling instead of silently applying free tier", async (tier, limit) => {
    const fakeDb = makeDb();
    fakeDb.db.exec(`INSERT INTO orgs (id, plan_tier) VALUES ('tenant-1', '${tier}')`);
    for (let i = 0; i < limit; i++) {
      await createSpaceRecord({ PLATFORM_DB: fakeDb }, { tenantId: "tenant-1", name: `Space ${i}`, spacetypeId: "launchpad" });
    }
    await expect(createSpaceRecord({ PLATFORM_DB: fakeDb }, { tenantId: "tenant-1", name: "Over limit", spacetypeId: "launchpad" }))
      .rejects.toMatchObject({ error_code: "quota_exceeded", status: 402 });
  });
});

describe("createSpaceRecord — bounded inputs and tenant quota serialization", () => {
  it("binds an end-user Space and its owner membership to the registered Product", async () => {
    const fakeDb = makeDb();
    const product = await createSpaceRecord({ PLATFORM_DB: fakeDb }, { tenantId: "tenant", name: "Naelao", spacetypeId: "launchpad", productSlug: "launchpad" });
    const workspace = await createSpaceRecord({ PLATFORM_DB: fakeDb }, {
      tenantId: "tenant", userId: "owner", name: "My Space", spacetypeId: "launchpad", parentSpaceId: product.id,
      initialMembership: { productSpaceId: product.id, endUserId: "owner" },
    });
    const row = fakeDb.db.prepare("SELECT product_id FROM spaces WHERE id = ?").get(workspace.id);
    expect(row).toEqual(expect.objectContaining({ product_id: product.id }));
    expect(fakeDb.db.prepare("SELECT role FROM space_members WHERE space_id = ? AND end_user_id = ?").get(workspace.id, "owner"))
      .toEqual(expect.objectContaining({ role: "owner" }));
    await expect(createSpaceRecord({ PLATFORM_DB: fakeDb }, {
      tenantId: "tenant", userId: "attacker", name: "Invalid", spacetypeId: "launchpad", parentSpaceId: product.id,
      initialMembership: { productSpaceId: product.id, endUserId: "owner" },
    })).rejects.toMatchObject({ error_code: "invalid_product_membership" });
  });
  it("rejects oversized names and config overrides before inserting", async () => {
    const fakeDb = makeDb();
    await expect(createSpaceRecord({ PLATFORM_DB: fakeDb }, { tenantId: "t1", name: "x".repeat(101), spacetypeId: "launchpad" }))
      .rejects.toMatchObject({ error_code: "bad_request", status: 400 });
    await expect(createSpaceRecord({ PLATFORM_DB: fakeDb }, { tenantId: "t1", name: "A", spacetypeId: "launchpad", configOverrides: { data: "x".repeat(65 * 1024) } }))
      .rejects.toMatchObject({ error_code: "bad_request", status: 400 });
    const row = await fakeDb.prepare("SELECT COUNT(*) AS count FROM spaces").first<{ count: number }>();
    expect(row?.count).toBe(0);
  });

  it("does not insert when the tenant creation lock is held", async () => {
    const fakeDb = makeDb();
    const lockFetch = vi.fn(async () => Response.json({ acquired: false }));
    const env = {
      PLATFORM_DB: fakeDb,
      PLATFORM_SECRET: "secret",
      LOCK_DO: { idFromName: (name: string) => name, get: () => ({ fetch: lockFetch }) },
    } as never;
    await expect(createSpaceRecord(env, { tenantId: "t1", name: "A", spacetypeId: "launchpad" }))
      .rejects.toMatchObject({ error_code: "creation_busy", status: 429 });
    expect(lockFetch).toHaveBeenCalledOnce();
    const row = await fakeDb.prepare("SELECT COUNT(*) AS count FROM spaces").first<{ count: number }>();
    expect(row?.count).toBe(0);
  });

  it("releases the tenant lock after a successful insert", async () => {
    const fakeDb = makeDb();
    const lockFetch = vi.fn(async (request: Request) => request.url.endsWith("/acquire")
      ? Response.json({ acquired: true })
      : Response.json({ released: true }));
    const env = {
      PLATFORM_DB: fakeDb,
      PLATFORM_SECRET: "secret",
      LOCK_DO: { idFromName: (name: string) => name, get: () => ({ fetch: lockFetch }) },
    } as never;
    await createSpaceRecord(env, { tenantId: "t1", name: "A", spacetypeId: "launchpad" });
    expect(lockFetch).toHaveBeenCalledTimes(2);
    expect(lockFetch.mock.calls.map(([request]) => new URL(request.url).pathname)).toEqual(["/acquire", "/release"]);
  });

  it("keeps the space and retries a rejected queue send from the durable outbox", async () => {
    const fakeDb = makeDb();
    const send = vi.fn(async () => { throw new Error("queue unavailable"); });
    const env = {
      PLATFORM_DB: fakeDb,
      ENVIRONMENT: "production",
      PROVISION_QUEUE: { send },
    } as never;
    const result = await createSpaceRecord(env, { tenantId: "t1", name: "A", spacetypeId: "launchpad" });
    expect(result.status).toBe("provisioning");
    const row = await fakeDb.prepare("SELECT status FROM spaces WHERE id = ?").bind(result.id).first<{ status: string }>();
    const outbox = await fakeDb.prepare("SELECT status, attempt_count FROM space_provisioning_outbox WHERE space_id = ?").bind(result.id)
      .first<{ status: string; attempt_count: number }>();
    expect(row?.status).toBe("provisioning");
    expect(outbox).toMatchObject({ status: "pending", attempt_count: 1 });
    expect(send).toHaveBeenCalledOnce();
  });

  it("redelivers due provisioning outbox entries and marks successful sends", async () => {
    const fakeDb = makeDb();
    const send = vi.fn(async () => {});
    const result = await createSpaceRecord(
      { PLATFORM_DB: fakeDb, ENVIRONMENT: "production", PROVISION_QUEUE: { send: async () => { throw new Error("offline"); } } as never },
      { tenantId: "t1", name: "A", spacetypeId: "launchpad" },
    );
    fakeDb.db.prepare("UPDATE space_provisioning_outbox SET next_attempt_at = datetime('now', '-1 second') WHERE space_id = ?").run(result.id);
    expect(await dispatchPendingProvisioningOutbox(fakeDb, { send })).toEqual({ sent: 1, deferred: 0 });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "space_provision", spaceId: result.id }));
    const state = await fakeDb.prepare("SELECT status, attempt_count FROM space_provisioning_outbox WHERE space_id = ?").bind(result.id)
      .first<{ status: string; attempt_count: number }>();
    expect(state).toMatchObject({ status: "sent", attempt_count: 1 });
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
    await createSpaceRecord({ PLATFORM_DB: fakeDb }, { tenantId: "t1", name: "A", spacetypeId: "launchpad", productSlug: "launchpad" });
    await expect(
      createSpaceRecord({ PLATFORM_DB: fakeDb }, { tenantId: "t2", name: "B", spacetypeId: "launchpad", productSlug: "launchpad" })
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

  it("accepts the platform Launchpad Product slug", async () => {
    const fakeDb = makeDb();
    const result = await createSpaceRecord({ PLATFORM_DB: fakeDb }, { tenantId: "t1", name: "A", spacetypeId: "launchpad", productSlug: "launchpad" });
    expect(result.id).toBeTruthy();
  });

  it("does not turn a generic Space into a Product", async () => {
    const fakeDb = makeDb();
    const result = await createSpaceRecord({ PLATFORM_DB: fakeDb }, { tenantId: "t1", name: "Acme Creator Store", spacetypeId: "launchpad" });
    const row = await fakeDb.prepare("SELECT product_slug FROM spaces WHERE id = ?").bind(result.id).first<{ product_slug: string | null }>();
    expect(row?.product_slug).toBeNull();
    expect(fakeDb.db.prepare("SELECT COUNT(*) AS count FROM products").get()).toEqual({ count: 0 });
  });

  it("allows Spaces with the same name without inventing Products", async () => {
    const fakeDb = makeDb();
    await createSpaceRecord({ PLATFORM_DB: fakeDb }, { tenantId: "t1", name: "Launchpad", spacetypeId: "launchpad" });
    const second = await createSpaceRecord({ PLATFORM_DB: fakeDb }, { tenantId: "t2", name: "Launchpad", spacetypeId: "launchpad" });
    const row = await fakeDb.prepare("SELECT product_slug FROM spaces WHERE id = ?").bind(second.id).first<{ product_slug: string | null }>();
    expect(row?.product_slug).toBeNull();
  });

  it("rejects attempts to create another Product", async () => {
    const fakeDb = makeDb();
    await expect(createSpaceRecord({ PLATFORM_DB: fakeDb }, { tenantId: "t1", name: "Other", spacetypeId: "launchpad", productSlug: "other-product" }))
      .rejects.toMatchObject({ error_code: "product_creation_retired", status: 400 });
    const row = await fakeDb.prepare("SELECT COUNT(*) AS count FROM spaces").first<{ count: number }>();
    expect(row?.count).toBe(0);
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

  it("keeps a certified template pending for owner review in queued Spaces", async () => {
    const fakeDb = makeDb();
    const send = vi.fn(async (_message: unknown) => {});
    const result = await createSpaceRecord(
      { PLATFORM_DB: fakeDb, ENVIRONMENT: "production", PROVISION_QUEUE: { send } as never },
      { tenantId: "tenant-a", userId: "owner-a", name: "Fresh Space", spacetypeId: "launchpad", blueprintId: "tpl_certified" },
    );
    const row = await fakeDb.prepare("SELECT config_json FROM spaces WHERE id = ?").bind(result.id).first<{ config_json: string }>();
    expect(JSON.parse(row!.config_json)).toMatchObject({ pending_blueprint_id: "tpl_certified" });
    expect(send.mock.calls[0]?.[0]).not.toHaveProperty("blueprintId");
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
