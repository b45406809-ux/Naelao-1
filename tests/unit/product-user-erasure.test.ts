import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { eraseProductUsersForSpace } from "../../workers/spaces/src/product-user-erasure.js";
import { createFakeD1 } from "../stubs/d1-sqlite.js";

const migration = (name: string) => readFileSync(join(__dirname, `../../infra/migrations/${name}`), "utf8");
const migrations = readdirSync(join(__dirname, "../../infra/migrations"))
  .filter((name) => /^\d+.*\.sql$/.test(name)).sort().map(migration);

describe("ProductUserDO erasure discovery", () => {
  it("paginates a large product roster and removes D1 rows only after each DO is erased", async () => {
    const db = createFakeD1(migrations);
    db.db.prepare("INSERT INTO orgs (id, name, owner_id, plan_tier) VALUES (?, ?, ?, ?)")
      .run("tenant-a", "Acme", "owner-a", "free");
    db.db.prepare("INSERT INTO spaces (id, tenant_id, spacetype_id, name) VALUES (?, ?, ?, ?)")
      .run("product-a", "tenant-a", "type-a", "Product");
    const insert = db.db.prepare("INSERT INTO product_end_users (product_space_id, end_user_id) VALUES (?, ?)");
    for (let index = 0; index < 205; index++) insert.run("product-a", `user-${String(index).padStart(3, "0")}`);

    const erased: string[] = [];
    const count = await eraseProductUsersForSpace(db as never, "tenant-a", "product-a", async (_spaceId, userId) => {
      erased.push(userId);
    });

    expect(count).toBe(205);
    expect(erased).toHaveLength(205);
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM product_end_users WHERE product_space_id = ?").get("product-a"))
      .toEqual({ count: 0 });
  });

  it("keeps a roster row when DO erasure fails and rejects cross-tenant spaces", async () => {
    const db = createFakeD1(migrations);
    db.db.prepare("INSERT INTO orgs (id, name, owner_id, plan_tier) VALUES (?, ?, ?, ?)")
      .run("tenant-a", "Acme", "owner-a", "free");
    db.db.prepare("INSERT INTO spaces (id, tenant_id, spacetype_id, name) VALUES (?, ?, ?, ?)")
      .run("product-a", "tenant-a", "type-a", "Product");
    db.db.prepare("INSERT INTO product_end_users (product_space_id, end_user_id) VALUES (?, ?)")
      .run("product-a", "user-a");

    await expect(eraseProductUsersForSpace(db as never, "tenant-b", "product-a", async () => undefined))
      .rejects.toThrow(/outside the tenant/);
    await expect(eraseProductUsersForSpace(db as never, "tenant-a", "product-a", async () => {
      throw new Error("DO unavailable");
    })).rejects.toThrow("DO unavailable");
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM product_end_users WHERE product_space_id = ?").get("product-a"))
      .toEqual({ count: 1 });
  });
});
