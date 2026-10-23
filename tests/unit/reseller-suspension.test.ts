import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import spacesWorker from "../../workers/spaces/src/index.js";
import { createFakeD1 } from "../stubs/d1-sqlite.js";

const migrations = ["0001_users.sql", "0002_orgs.sql", "0003_spaces.sql", "0033_reseller_accounts.sql", "0034_space_hierarchy.sql", "0035_commerce.sql", "0061_reseller_ledger_kind.sql", "0116_space_suspension_reason.sql"]
  .map((name) => readFileSync(join(__dirname, `../../infra/migrations/${name}`), "utf8"));
const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function setup() {
  const db = createFakeD1(migrations);
  db.db.exec("INSERT INTO orgs (id, name, owner_id, plan_tier) VALUES ('parent', 'Parent', 'owner-p', 'free'), ('child', 'Child', 'owner-c', 'free')");
  db.db.exec("INSERT INTO spaces (id, tenant_id, spacetype_id, name, status, parent_space_id, scenario_type, depth) VALUES ('reseller-space', 'parent', 'launchpad', 'Reseller', 'active', NULL, NULL, 0), ('child-active', 'child', 'launchpad', 'Active', 'active', 'reseller-space', 'agency-child', 1)");
  db.db.exec("INSERT INTO spaces (id, tenant_id, spacetype_id, name, status, suspension_reason) VALUES ('child-abuse', 'child', 'launchpad', 'Abuse hold', 'suspended', 'admin_product')");
  db.db.exec("INSERT INTO tenant_hierarchy (child_tenant_id, parent_tenant_id, reseller_product_space_id, child_space_id) VALUES ('child', 'parent', 'reseller-space', 'child-active')");
  return db;
}

function request(status: "active" | "suspended", role = "owner") {
  return new Request("https://spaces/reseller/clients/child/status", {
    method: "POST",
    headers: { "content-type": "application/json", "x-naelao-tenant-id": "parent", "x-naelao-role": role },
    body: JSON.stringify({ status }),
  });
}

function promoteRequest(body = JSON.stringify({ acknowledge_irreversible: true }), role = "owner") {
  return new Request("https://spaces/reseller/clients/child/promote", {
    method: "POST",
    headers: { "content-type": "application/json", "x-naelao-tenant-id": "parent", "x-naelao-role": role },
    body,
  });
}

describe("reseller client suspension reason preservation", () => {
  it("suspends only active Spaces and restores only Spaces suspended by this reseller", async () => {
    const db = setup();
    const env = { ENVIRONMENT: "test", PLATFORM_SECRET: "secret", PLATFORM_DB: db };

    const suspended = await spacesWorker.fetch(request("suspended"), env as never, execCtx);
    expect(suspended.status).toBe(200);
    expect(db.db.prepare("SELECT status, suspension_reason FROM spaces WHERE id = 'child-active'").get())
      .toEqual({ status: "suspended", suspension_reason: "reseller" });
    expect(db.db.prepare("SELECT status, suspension_reason FROM spaces WHERE id = 'child-abuse'").get())
      .toEqual({ status: "suspended", suspension_reason: "admin_product" });

    const restored = await spacesWorker.fetch(request("active"), env as never, execCtx);
    expect(restored.status).toBe(200);
    expect(db.db.prepare("SELECT status, suspension_reason FROM spaces WHERE id = 'child-active'").get())
      .toEqual({ status: "active", suspension_reason: null });
    expect(db.db.prepare("SELECT status, suspension_reason FROM spaces WHERE id = 'child-abuse'").get())
      .toEqual({ status: "suspended", suspension_reason: "admin_product" });
  });

  it("does not reactivate a terminated reseller relationship", async () => {
    const db = setup();
    db.db.exec("UPDATE tenant_hierarchy SET status = 'terminated' WHERE child_tenant_id = 'child'");
    const response = await spacesWorker.fetch(request("active"), {
      ENVIRONMENT: "test", PLATFORM_SECRET: "secret", PLATFORM_DB: db,
    } as never, execCtx);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error_code: "client_terminated" });
    expect(db.db.prepare("SELECT status FROM spaces WHERE id = 'child-active'").get())
      .toEqual({ status: "active" });
  });

  it("rejects malformed or missing confirmation bodies without an internal error", async () => {
    const db = setup();
    const env = { ENVIRONMENT: "test", PLATFORM_SECRET: "secret", PLATFORM_DB: db };

    const malformed = await spacesWorker.fetch(promoteRequest("{"), env as never, execCtx);
    expect(malformed.status).toBe(400);
    const missing = await spacesWorker.fetch(
      promoteRequest(JSON.stringify({ acknowledge_irreversible: false })), env as never, execCtx,
    );
    expect(missing.status).toBe(400);
    expect(db.db.prepare("SELECT status FROM tenant_hierarchy WHERE child_tenant_id = 'child'").get())
      .toEqual({ status: "active" });
  });

  it("keeps reseller portfolios, billing, and client mutations out of viewer roles", async () => {
    const db = setup();
    const env = { ENVIRONMENT: "test", PLATFORM_SECRET: "secret", PLATFORM_DB: db };
    const requests = [
      new Request("https://spaces/reseller/clients", { headers: { "x-naelao-tenant-id": "parent", "x-naelao-role": "viewer" } }),
      new Request("https://spaces/reseller/statement", { headers: { "x-naelao-tenant-id": "parent", "x-naelao-role": "viewer" } }),
      new Request("https://spaces/reseller/clients/child", { headers: { "x-naelao-tenant-id": "parent", "x-naelao-role": "viewer" } }),
      request("suspended", "viewer"),
      promoteRequest(undefined, "viewer"),
    ];
    for (const req of requests) {
      const response = await spacesWorker.fetch(req, env as never, execCtx);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error_code: "forbidden" });
    }
    expect(db.db.prepare("SELECT status FROM tenant_hierarchy WHERE child_tenant_id = 'child'").get())
      .toEqual({ status: "active" });
    expect(db.db.prepare("SELECT status FROM spaces WHERE id = 'child-active'").get())
      .toEqual({ status: "active" });
  });

  it("pages large client portfolios without hiding rows or reporting a page-local total", async () => {
    const db = setup();
    for (let i = 0; i < 204; i++) {
      db.db.prepare(`INSERT INTO tenant_hierarchy
        (child_tenant_id, parent_tenant_id, reseller_product_space_id, child_space_id)
        VALUES (?, 'parent', 'reseller-space', ?)`)
        .run(`child-${String(i).padStart(3, "0")}`, `space-${i}`);
    }
    const env = { ENVIRONMENT: "test", PLATFORM_SECRET: "secret", PLATFORM_DB: db };
    const fetchPage = async (page: number) => {
      const response = await spacesWorker.fetch(new Request(`https://spaces/reseller/clients?page=${page}`, {
        headers: { "x-naelao-tenant-id": "parent", "x-naelao-role": "owner" },
      }), env as never, execCtx);
      expect(response.status).toBe(200);
      return response.json() as Promise<{ clients: unknown[]; client_count: number; page: number; page_size: number; page_count: number }>;
    };

    const first = await fetchPage(1);
    const second = await fetchPage(2);
    const third = await fetchPage(3);
    expect(first).toMatchObject({ client_count: 205, page: 1, page_size: 100, page_count: 3 });
    expect(first.clients).toHaveLength(100);
    expect(second.clients).toHaveLength(100);
    expect(third.clients).toHaveLength(5);
    const ids = [...first.clients, ...second.clients, ...third.clients] as Array<{ child_tenant_id: string }>;
    expect(new Set(ids.map((client) => client.child_tenant_id)).size).toBe(205);

    const invalid = await spacesWorker.fetch(new Request("https://spaces/reseller/clients?page=1.5", {
      headers: { "x-naelao-tenant-id": "parent", "x-naelao-role": "owner" },
    }), env as never, execCtx);
    expect(invalid.status).toBe(400);
  });

  it("promotes atomically so a failed space update preserves the reseller relationship", async () => {
    const db = setup();
    db.db.exec(`CREATE TRIGGER reject_space_detach BEFORE UPDATE OF parent_space_id ON spaces
      BEGIN SELECT RAISE(ABORT, 'simulated detach failure'); END`);
    const response = await spacesWorker.fetch(promoteRequest(), {
      ENVIRONMENT: "test", PLATFORM_SECRET: "secret", PLATFORM_DB: db,
    } as never, execCtx);

    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(db.db.prepare("SELECT status FROM tenant_hierarchy WHERE child_tenant_id = 'child'").get())
      .toEqual({ status: "active" });
    expect(db.db.prepare("SELECT parent_space_id FROM spaces WHERE id = 'child-active'").get())
      .toEqual({ parent_space_id: "reseller-space" });
  });

  it("detaches the hierarchy and child spaces together after explicit confirmation", async () => {
    const db = setup();
    const response = await spacesWorker.fetch(promoteRequest(), {
      ENVIRONMENT: "test", PLATFORM_SECRET: "secret", PLATFORM_DB: db,
    } as never, execCtx);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ promoted: true, child_tenant_id: "child" });
    expect(db.db.prepare("SELECT status FROM tenant_hierarchy WHERE child_tenant_id = 'child'").get())
      .toEqual({ status: "terminated" });
    expect(db.db.prepare("SELECT parent_space_id, scenario_type, depth FROM spaces WHERE id = 'child-active'").get())
      .toEqual({ parent_space_id: null, scenario_type: null, depth: 0 });
  });
});
