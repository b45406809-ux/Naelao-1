// Regression test for the Phase E precondition (§A1.17): workers/admin queried a nonexistent
// `organizations` table (real: `orgs`), UPDATEd a nonexistent `orgs.updated_at` column, and its
// feature-flags routes used a `key`/`value_json`/`tenant_id` shape that migration
// 0023_feature_flags.sql never created (real: `name`/`enabled`/`rollout_pct`/`overrides_json`) —
// every one of these routes would have thrown against a real D1 database. Seeds the ACTUAL
// migrations via node:sqlite so a regression fails loudly here.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createFakeD1 } from "../stubs/d1-sqlite.js";
import adminWorker from "../../workers/admin/src/index.js";

const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function readMigration(name: string): string {
  return readFileSync(join(__dirname, "../../infra/migrations", name), "utf8");
}

function makeEnv() {
  const fakeDb = createFakeD1([
    readMigration("0001_users.sql"),
    readMigration("0002_orgs.sql"),
    readMigration("0003_spaces.sql"),
    readMigration("0004_billing.sql"),
    readMigration("0023_feature_flags.sql"),
    readMigration("0048_admin_schema_fixes.sql"),
  ]);
  return {
    ENVIRONMENT: "test",
    PLATFORM_SECRET: "test-platform-secret",
    ADMIN_SECRET: "test-admin-secret",
    PLATFORM_DB: fakeDb,
    ANALYTICS: {} as unknown,
  };
}

function adminReq(path: string, init: RequestInit = {}) {
  return new Request(`http://internal${path}`, {
    ...init,
    headers: {
      "x-naelao-role": "platform_admin",
      "x-naelao-admin-secret": "test-admin-secret",
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

describe("admin worker against the real platform schema", () => {
  it("GET /admin/tenants reads from `orgs`, not a nonexistent `organizations` table", async () => {
    const env = makeEnv();
    (env.PLATFORM_DB as ReturnType<typeof createFakeD1>).db.exec(
      `INSERT INTO orgs (id, name, owner_id, plan_tier) VALUES ('org-1', 'Acme', 'u1', 'growth')`
    );
    const res = await adminWorker.fetch(adminReq("/admin/tenants"), env as never, execCtx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string; name: string }> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.name).toBe("Acme");
  });

  it("GET /admin/tenants/:id joins user + space counts by the right foreign keys", async () => {
    const env = makeEnv();
    const db = (env.PLATFORM_DB as ReturnType<typeof createFakeD1>).db;
    db.exec(`INSERT INTO orgs (id, name, owner_id, plan_tier) VALUES ('org-1', 'Acme', 'u1', 'free')`);
    db.exec(`INSERT INTO users (id, email, org_id, status) VALUES ('u1', 'a@x.com', 'org-1', 'active')`);
    db.exec(`INSERT INTO spaces (id, tenant_id, spacetype_id, name, status) VALUES ('s1', 'org-1', 'launchpad', 'S1', 'active')`);
    const res = await adminWorker.fetch(adminReq("/admin/tenants/org-1"), env as never, execCtx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stats: { users: number; spaces: number } };
    expect(body.stats.users).toBe(1);
    expect(body.stats.spaces).toBe(1);
  });

  it("PATCH /admin/tenants/:id updates plan_tier and orgs.updated_at without throwing", async () => {
    const env = makeEnv();
    (env.PLATFORM_DB as ReturnType<typeof createFakeD1>).db.exec(
      `INSERT INTO orgs (id, name, owner_id, plan_tier) VALUES ('org-1', 'Acme', 'u1', 'free')`
    );
    const res = await adminWorker.fetch(
      adminReq("/admin/tenants/org-1", { method: "PATCH", body: JSON.stringify({ plan_tier: "business" }) }),
      env as never,
      execCtx
    );
    expect(res.status).toBe(200);
    const row = (env.PLATFORM_DB as ReturnType<typeof createFakeD1>).db
      .prepare("SELECT plan_tier, updated_at FROM orgs WHERE id = ?")
      .get("org-1") as { plan_tier: string; updated_at: string | null };
    expect(row.plan_tier).toBe("business");
    expect(row.updated_at).not.toBeNull();
  });

  it("POST then GET /admin/feature-flags round-trips against the real name/enabled/rollout_pct schema", async () => {
    const env = makeEnv();
    const postRes = await adminWorker.fetch(
      adminReq("/admin/feature-flags", {
        method: "POST",
        body: JSON.stringify({ name: "new-checkout-flow", enabled: true, rollout_pct: 50, overrides: { "org-1": false } }),
      }),
      env as never,
      execCtx
    );
    expect(postRes.status).toBe(200);

    const getRes = await adminWorker.fetch(adminReq("/admin/feature-flags"), env as never, execCtx);
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as {
      data: Array<{ name: string; enabled: boolean; rollout_pct: number; overrides: Record<string, boolean> }>;
    };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ name: "new-checkout-flow", enabled: true, rollout_pct: 50, overrides: { "org-1": false } });
  });

  it("POST /admin/feature-flags upserts on a second call for the same name (real UNIQUE constraint)", async () => {
    const env = makeEnv();
    await adminWorker.fetch(
      adminReq("/admin/feature-flags", { method: "POST", body: JSON.stringify({ name: "flag-a", enabled: false, rollout_pct: 0 }) }),
      env as never,
      execCtx
    );
    await adminWorker.fetch(
      adminReq("/admin/feature-flags", { method: "POST", body: JSON.stringify({ name: "flag-a", enabled: true, rollout_pct: 100 }) }),
      env as never,
      execCtx
    );
    const rows = (env.PLATFORM_DB as ReturnType<typeof createFakeD1>).db
      .prepare("SELECT * FROM feature_flags WHERE name = ?")
      .all("flag-a");
    expect(rows).toHaveLength(1);
    expect((rows[0] as { enabled: number }).enabled).toBe(1);
  });

  it("GET /admin/stats returns real counts and an honest null for the unaggregatable sessions_24h", async () => {
    const env = makeEnv();
    (env.PLATFORM_DB as ReturnType<typeof createFakeD1>).db.exec(
      `INSERT INTO orgs (id, name, owner_id, plan_tier, status) VALUES ('org-1', 'Acme', 'u1', 'free', 'active')`
    );
    const res = await adminWorker.fetch(adminReq("/admin/stats"), env as never, execCtx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { active_tenants: number; sessions_24h: unknown };
    expect(body.active_tenants).toBe(1);
    expect(body.sessions_24h).toBeNull();
  });

  it("does not restore a product space while its parent tenant is suspended", async () => {
    const env = makeEnv();
    const db = (env.PLATFORM_DB as ReturnType<typeof createFakeD1>).db;
    db.exec(`INSERT INTO orgs (id, name, owner_id, plan_tier, status) VALUES ('org-1', 'Acme', 'u1', 'free', 'suspended')`);
    db.exec(`INSERT INTO spaces (id, tenant_id, spacetype_id, name, status) VALUES ('space-1', 'org-1', 'launchpad', 'Product', 'suspended')`);

    const res = await adminWorker.fetch(adminReq("/admin/products/space-1/restore", { method: "POST" }), env as never, execCtx);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error_code: "tenant_suspended" });
    expect((db.prepare("SELECT status FROM spaces WHERE id = ?").get("space-1") as { status: string }).status).toBe("suspended");
  });

  it("restores only a suspended space under an active tenant", async () => {
    const env = makeEnv();
    const db = (env.PLATFORM_DB as ReturnType<typeof createFakeD1>).db;
    db.exec(`INSERT INTO orgs (id, name, owner_id, plan_tier, status) VALUES ('org-1', 'Acme', 'u1', 'free', 'active')`);
    db.exec(`INSERT INTO spaces (id, tenant_id, spacetype_id, name, status) VALUES ('space-1', 'org-1', 'launchpad', 'Product', 'suspended')`);

    const res = await adminWorker.fetch(adminReq("/admin/products/space-1/restore", { method: "POST" }), env as never, execCtx);
    expect(res.status).toBe(200);
    expect((db.prepare("SELECT status FROM spaces WHERE id = ?").get("space-1") as { status: string }).status).toBe("active");
  });
});
