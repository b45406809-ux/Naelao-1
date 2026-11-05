import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeD1 } from "../../../tests/stubs/d1-sqlite.js";

describe("Product registry migration", () => {
  it("preserves existing Product identities and excludes end-user Spaces", () => {
    const { db } = createFakeD1([`CREATE TABLE spaces (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, spacetype_id TEXT NOT NULL,
      name TEXT NOT NULL, product_slug TEXT, parent_space_id TEXT, status TEXT NOT NULL,
      config_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, depth INTEGER NOT NULL DEFAULT 0
    )`]);
    db.exec("CREATE UNIQUE INDEX idx_spaces_product_slug ON spaces(product_slug) WHERE product_slug IS NOT NULL");
    db.exec(`INSERT INTO spaces VALUES
      ('product','team','launchpad','Naelao','launchpad',NULL,'active','{}','t1','t1',0),
      ('workspace','team','launchpad','Workspace',NULL,'product','active','{}','t1','t1',1)`);
    db.exec(readFileSync(join(__dirname, "../../../infra/migrations/0156_product_registry.sql"), "utf8"));
    expect(db.prepare("SELECT id, product_slug FROM products").all()).toEqual([
      expect.objectContaining({ id: "product", product_slug: "launchpad" }),
    ]);
    expect(db.prepare("SELECT product_id FROM spaces WHERE id = 'workspace'").get())
      .toEqual(expect.objectContaining({ product_id: "product" }));

    db.exec("UPDATE spaces SET name = 'Naelao updated', status = 'suspended', updated_at = 't2' WHERE id = 'product'");
    expect(db.prepare("SELECT name, status, updated_at FROM products WHERE id = 'product'").get())
      .toEqual(expect.objectContaining({ name: "Naelao updated", status: "suspended", updated_at: "t2" }));
    db.exec("DELETE FROM spaces WHERE id = 'workspace'");
    expect(db.prepare("SELECT count(*) AS count FROM products").get()).toEqual(expect.objectContaining({ count: 1 }));
    db.exec("DELETE FROM spaces WHERE id = 'product'");
    expect(db.prepare("SELECT count(*) AS count FROM products").get()).toEqual(expect.objectContaining({ count: 0 }));
  });

  it("retires backing-row synchronization, migrates only consistent links, and records conflicts", () => {
    const { db } = createFakeD1([`CREATE TABLE spaces (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, spacetype_id TEXT NOT NULL,
      name TEXT NOT NULL, product_slug TEXT, parent_space_id TEXT, status TEXT NOT NULL,
      config_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, depth INTEGER NOT NULL DEFAULT 0
    )`]);
    db.exec("CREATE UNIQUE INDEX idx_spaces_product_slug ON spaces(product_slug) WHERE product_slug IS NOT NULL");
    db.exec("CREATE TABLE orgs(id TEXT PRIMARY KEY, status TEXT)");
    db.exec("CREATE TABLE space_provisioning_outbox(space_id TEXT PRIMARY KEY,status TEXT,last_error TEXT,updated_at TEXT)");
    db.exec("INSERT INTO orgs VALUES ('team','active')");
    db.exec(`INSERT INTO spaces VALUES
      ('product','team','launchpad','Launchpad','launchpad',NULL,'active','{}','t1','t1',0),
      ('good','team','launchpad','Good',NULL,'product','active','{}','t1','t1',1),
      ('other','other-team','launchpad','Other',NULL,'product','active','{}','t1','t1',1),
      ('orphan','team','launchpad','Orphan',NULL,'missing','active','{}','t1','t1',1),
      ('legacy-product','team','launchpad','Legacy Product','legacy-shop','product','active','{}','t1','t1',1)`);
    db.exec(readFileSync(join(__dirname, "../../../infra/migrations/0156_product_registry.sql"), "utf8"));
    db.exec("INSERT INTO space_provisioning_outbox(space_id,status) VALUES ('product','pending'),('good','pending')");
    db.exec(readFileSync(join(__dirname, "../../../infra/migrations/0157_product_registry_cutover.sql"), "utf8"));
    expect(db.prepare("SELECT product_id,parent_space_id,depth FROM spaces WHERE id='good'").get()).toMatchObject({ product_id: "product", parent_space_id: null, depth: 0 });
    expect(db.prepare("SELECT product_id,parent_space_id FROM spaces WHERE id='other'").get()).toMatchObject({ product_id: null, parent_space_id: "product" });
    expect(db.prepare("SELECT product_id,parent_space_id FROM spaces WHERE id='orphan'").get()).toMatchObject({ product_id: null, parent_space_id: "missing" });
    expect(db.prepare("SELECT product_id,parent_space_id FROM spaces WHERE id='legacy-product'").get()).toMatchObject({ product_id: null, parent_space_id: "product" });
    expect(db.prepare("SELECT reason,recorded_product_slug FROM product_link_migration_issues WHERE space_id='legacy-product'").get())
      .toMatchObject({ reason: "legacy_product_row_not_registered", recorded_product_slug: "legacy-shop" });
    expect(db.prepare("SELECT reason FROM product_link_migration_issues WHERE space_id='other'").get()).toMatchObject({ reason: "parent_product_tenant_mismatch" });
    expect(db.prepare("SELECT reason FROM product_link_migration_issues WHERE space_id='orphan'").get()).toMatchObject({ reason: "parent_space_missing" });
    expect(db.prepare("SELECT status FROM space_provisioning_outbox WHERE space_id='product'").get()).toMatchObject({ status: "cancelled" });
    expect(db.prepare("SELECT status FROM space_provisioning_outbox WHERE space_id='good'").get()).toMatchObject({ status: "pending" });
    db.exec("UPDATE spaces SET name='Changed' WHERE id='product'");
    expect(db.prepare("SELECT name FROM products WHERE id='product'").get()).toMatchObject({ name: "Launchpad" });
  });
});
