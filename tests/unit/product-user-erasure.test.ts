import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { eraseProductUsersForSpace } from "../../workers/spaces/src/product-user-erasure.js";
import { eraseBusinessServiceProviders } from "../../workers/spaces/src/business-erasure.js";
import { cancelPendingErasure, createPendingErasureRequest } from "../../workers/spaces/src/erasure-request-state.js";
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

describe("business provider erasure", () => {
  it("deletes custom hostnames before the tenant's business-service rows are removed", async () => {
    const db = createFakeD1(migrations);
    db.db.prepare("INSERT INTO spaces (id, tenant_id, spacetype_id, name) VALUES (?, ?, ?, ?)")
      .run("space-a", "tenant-a", "type-a", "Store");
    db.db.prepare("INSERT INTO business_services (id, space_id, tenant_id, kind, cf_hostname_id) VALUES (?, ?, ?, ?, ?)")
      .run("service-a", "space-a", "tenant-a", "custom_domain", "cf-host-a");
    const deleted: string[] = [];
    const count = await eraseBusinessServiceProviders(db as never, "tenant-a", "space-a", async (id) => { deleted.push(id); });
    expect(count).toBe(1);
    expect(deleted).toEqual(["cf-host-a"]);
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM business_services WHERE id = ?").get("service-a"))
      .toEqual({ count: 1 });
  });

  it("stops on a provider failure and rejects a cross-tenant space", async () => {
    const db = createFakeD1(migrations);
    db.db.prepare("INSERT INTO spaces (id, tenant_id, spacetype_id, name) VALUES (?, ?, ?, ?)")
      .run("space-a", "tenant-a", "type-a", "Store");
    db.db.prepare("INSERT INTO business_services (id, space_id, tenant_id, kind, cf_hostname_id) VALUES (?, ?, ?, ?, ?)")
      .run("service-a", "space-a", "tenant-a", "custom_domain", "cf-host-a");
    await expect(eraseBusinessServiceProviders(db as never, "tenant-b", "space-a", async () => undefined))
      .rejects.toThrow(/outside the tenant/);
    await expect(eraseBusinessServiceProviders(db as never, "tenant-a", "space-a", async () => {
      throw new Error("Cloudflare unavailable");
    })).rejects.toThrow("Cloudflare unavailable");
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM business_services WHERE id = ?").get("service-a"))
      .toEqual({ count: 1 });
  });
});

describe("organization erasure cancellation", () => {
  it("persists an owner request before queueing it and marks a failed send", async () => {
    const db = createFakeD1(migrations);
    const messages: unknown[] = [];
    await createPendingErasureRequest(db as never, { send: async (message: unknown) => { messages.push(message); } }, {
      id: "request-a", tenantId: "tenant-a", userId: "owner-a", reason: "Close account",
    });
    expect(messages).toEqual([{
      type: "data.erasure", orgId: "tenant-a", requestedBy: "owner-a", reason: "Close account", requestId: "request-a",
    }]);
    expect(db.db.prepare("SELECT status FROM gdpr_requests WHERE id = ?").get("request-a")).toEqual({ status: "pending" });

    await expect(createPendingErasureRequest(db as never, { send: async () => { throw new Error("queue unavailable"); } }, {
      id: "request-b", tenantId: "tenant-b", userId: "owner-b", reason: "Close account",
    })).rejects.toThrow("queue unavailable");
    expect(db.db.prepare("SELECT status FROM gdpr_requests WHERE id = ?").get("request-b")).toEqual({ status: "failed" });
    await expect(createPendingErasureRequest(db as never, { send: async () => undefined }, {
      id: "request-c", tenantId: "tenant-a", userId: "owner-a", reason: "Duplicate request",
    })).resolves.toBe(false);
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM gdpr_requests WHERE tenant_id = ? AND status = 'pending'").get("tenant-a"))
      .toEqual({ count: 1 });
  });

  it("cancels once and restores only erasure-owned suspension reasons", async () => {
    const db = createFakeD1(migrations);
    db.db.prepare("INSERT INTO orgs (id, name, owner_id, plan_tier, status, suspension_reason) VALUES (?, ?, ?, ?, ?, ?)")
      .run("tenant-a", "Acme", "owner-a", "free", "suspended", "erasure");
    db.db.prepare("INSERT INTO spaces (id, tenant_id, spacetype_id, name, status, suspension_reason) VALUES (?, ?, ?, ?, ?, ?)")
      .run("space-a", "tenant-a", "type-a", "Space A", "suspended", "erasure");
    db.db.prepare("INSERT INTO spaces (id, tenant_id, spacetype_id, name, status, suspension_reason) VALUES (?, ?, ?, ?, ?, ?)")
      .run("space-b", "tenant-a", "type-a", "Space B", "suspended", "admin_product");
    db.db.prepare("INSERT INTO gdpr_requests (id, tenant_id, request_type, subject_type, subject_id, requested_by, status) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("request-a", "tenant-a", "erasure", "org_member", "owner-a", "owner-a", "pending");

    await expect(cancelPendingErasure(db as never, "tenant-a", "owner-a", "request-a")).resolves.toBe(true);
    await expect(cancelPendingErasure(db as never, "tenant-a", "owner-a", "request-a")).resolves.toBe(false);
    expect(db.db.prepare("SELECT status, suspension_reason FROM orgs WHERE id = ?").get("tenant-a"))
      .toEqual({ status: "active", suspension_reason: null });
    expect(db.db.prepare("SELECT status, suspension_reason FROM spaces WHERE id = ?").get("space-a"))
      .toEqual({ status: "active", suspension_reason: null });
    expect(db.db.prepare("SELECT status, suspension_reason FROM spaces WHERE id = ?").get("space-b"))
      .toEqual({ status: "suspended", suspension_reason: "admin_product" });

    // A retry of an old cancelled ID must not release a later erasure's holds.
    db.db.prepare("UPDATE orgs SET status = 'suspended', suspension_reason = 'erasure' WHERE id = ?").run("tenant-a");
    db.db.prepare("UPDATE spaces SET status = 'suspended', suspension_reason = 'erasure' WHERE id = ?").run("space-a");
    db.db.prepare("INSERT INTO gdpr_requests (id, tenant_id, request_type, subject_type, subject_id, requested_by, status) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("request-b", "tenant-a", "erasure", "org_member", "owner-a", "owner-a", "pending");
    await expect(cancelPendingErasure(db as never, "tenant-a", "owner-a", "request-a")).resolves.toBe(false);
    expect(db.db.prepare("SELECT status, suspension_reason FROM orgs WHERE id = ?").get("tenant-a"))
      .toEqual({ status: "suspended", suspension_reason: "erasure" });
    expect(db.db.prepare("SELECT status, suspension_reason FROM spaces WHERE id = ?").get("space-a"))
      .toEqual({ status: "suspended", suspension_reason: "erasure" });
  });

  it("cannot cancel after the workflow atomically claims the request", async () => {
    const db = createFakeD1(migrations);
    db.db.prepare("INSERT INTO orgs (id, name, owner_id, plan_tier, status, suspension_reason) VALUES (?, ?, ?, ?, ?, ?)")
      .run("tenant-a", "Acme", "owner-a", "free", "suspended", "erasure");
    db.db.prepare("INSERT INTO gdpr_requests (id, tenant_id, request_type, subject_type, subject_id, requested_by, status) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("request-a", "tenant-a", "erasure", "org_member", "owner-a", "owner-a", "processing");
    await expect(cancelPendingErasure(db as never, "tenant-a", "owner-a", "request-a")).resolves.toBe(false);
    expect(db.db.prepare("SELECT status, suspension_reason FROM orgs WHERE id = ?").get("tenant-a"))
      .toEqual({ status: "suspended", suspension_reason: "erasure" });
  });
});
