import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import spacesWorker from "../../workers/spaces/src/index.js";
import { createFakeD1 } from "../stubs/d1-sqlite.js";

const migrations = ["0001_users.sql", "0002_orgs.sql", "0003_spaces.sql", "0033_reseller_accounts.sql", "0116_space_suspension_reason.sql"]
  .map((name) => readFileSync(join(__dirname, `../../infra/migrations/${name}`), "utf8"));
const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function setup() {
  const db = createFakeD1(migrations);
  db.db.exec("INSERT INTO orgs (id, name, owner_id, plan_tier) VALUES ('parent', 'Parent', 'owner-p', 'free'), ('child', 'Child', 'owner-c', 'free')");
  db.db.exec("INSERT INTO spaces (id, tenant_id, spacetype_id, name, status) VALUES ('reseller-space', 'parent', 'launchpad', 'Reseller', 'active'), ('child-active', 'child', 'launchpad', 'Active', 'active')");
  db.db.exec("INSERT INTO spaces (id, tenant_id, spacetype_id, name, status, suspension_reason) VALUES ('child-abuse', 'child', 'launchpad', 'Abuse hold', 'suspended', 'admin_product')");
  db.db.exec("INSERT INTO tenant_hierarchy (child_tenant_id, parent_tenant_id, reseller_product_space_id, child_space_id) VALUES ('child', 'parent', 'reseller-space', 'child-active')");
  return db;
}

function request(status: "active" | "suspended") {
  return new Request("https://spaces/reseller/clients/child/status", {
    method: "POST",
    headers: { "content-type": "application/json", "x-naelao-tenant-id": "parent", "x-naelao-role": "owner" },
    body: JSON.stringify({ status }),
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
});
