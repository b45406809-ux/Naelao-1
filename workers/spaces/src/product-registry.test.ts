import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeD1 } from "../../../tests/stubs/d1-sqlite.js";

describe("Product registry migration", () => {
  it("preserves existing Product identities and excludes end-user Spaces", () => {
    const { db } = createFakeD1([`CREATE TABLE spaces (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, spacetype_id TEXT NOT NULL,
      name TEXT NOT NULL, product_slug TEXT, parent_space_id TEXT, status TEXT NOT NULL,
      config_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`]);
    db.exec(`INSERT INTO spaces VALUES
      ('product','team','launchpad','Naelao','launchpad',NULL,'active','{}','t1','t1'),
      ('workspace','team','launchpad','Workspace',NULL,'product','active','{}','t1','t1')`);
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
});
