import { describe, expect, it } from "vitest";
import { signJwt } from "@naelao/auth";
import { createFakeD1 } from "../../../tests/stubs/d1-sqlite.js";
import { app, type Env } from "./index.js";

function database() {
  return createFakeD1([
    "CREATE TABLE orgs(id TEXT PRIMARY KEY,status TEXT NOT NULL,reseller_status TEXT NOT NULL DEFAULT 'active')",
    "INSERT INTO orgs VALUES('tenant-a','active','active'),('tenant-b','active','active')",
    `CREATE TABLE notifications (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, type TEXT NOT NULL,
      title TEXT NOT NULL, body TEXT NOT NULL, read_at TEXT, action_url TEXT, created_at TEXT NOT NULL
    )`,
    `INSERT INTO notifications VALUES
      ('notice-a','tenant-a','user-a','billing','Private title','Private body',NULL,'javascript:alert(1)','2026-11-15 12:00:00'),
      ('notice-b','tenant-a','user-b','billing','Sibling title','Sibling body',NULL,NULL,'2026-11-15 13:00:00'),
      ('notice-c','tenant-b','user-a','billing','Tenant title','Tenant body',NULL,NULL,'2026-11-15 14:00:00')`,
  ]);
}

async function request(role: "owner" | "product_end_user" | "agent", method: "GET" | "POST", path: string) {
  const secret = "platform-notifications-test-secret";
  const token = await signJwt({ sub: "user-a", tid: "tenant-a", email: "user@example.test", role, scopes: [] }, secret);
  const db = database();
  const env = { ENVIRONMENT: "test", JWT_SECRET: secret, PLATFORM_SECRET: secret, PLATFORM_DB: db } as unknown as Env;
  const response = await app.request(path, { method, headers: { authorization: `Bearer ${token}` } }, env);
  return { response, db };
}

describe("authenticated platform notification routes", () => {
  it("serves only the verified platform user's private inbox without action URLs", async () => {
    const { response } = await request("owner", "GET", "/v1/me/notifications?status=all");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      data: [{ id: "notice-a", type: "billing", title: "Private title", body: "Private body", read_at: null,
        created_at: "2026-11-15 12:00:00" }],
      has_more: false,
      next_cursor: null,
    });
  });

  it("marks a notice read only in the current tenant and user scope", async () => {
    const own = await request("owner", "POST", "/v1/me/notifications/notice-a/read");
    expect(own.response.status).toBe(204);
    expect((own.db.db.prepare("SELECT read_at FROM notifications WHERE id='notice-a'").get() as { read_at: string }).read_at).toBeTruthy();

    const sibling = await request("owner", "POST", "/v1/me/notifications/notice-b/read");
    expect(sibling.response.status).toBe(404);
    const otherTenant = await request("owner", "POST", "/v1/me/notifications/notice-c/read");
    expect(otherTenant.response.status).toBe(404);
  });

  it("rejects product-user and agent identities instead of reading platform-user rows", async () => {
    const productUser = await request("product_end_user", "GET", "/v1/me/notifications");
    const agent = await request("agent", "GET", "/v1/me/notifications");
    expect(productUser.response.status).toBe(403);
    expect(agent.response.status).toBe(403);
  });

  it("rejects malformed status, limit and cursor parameters", async () => {
    const status = await request("owner", "GET", "/v1/me/notifications?status=unread%20OR%201%3D1");
    const limit = await request("owner", "GET", "/v1/me/notifications?limit=101");
    const cursor = await request("owner", "GET", "/v1/me/notifications?cursor=bad");
    expect(status.response.status).toBe(400);
    expect(limit.response.status).toBe(400);
    expect(cursor.response.status).toBe(400);
  });
});
