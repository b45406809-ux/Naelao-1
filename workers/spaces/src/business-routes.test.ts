import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { registerBusinessRoutes } from "./business-routes.js";

function routeApp() {
  const app = new Hono();
  registerBusinessRoutes(app);
  return app;
}

function invitationEnv(options: { accountEmail?: string } = {}) {
  let claimed = false;
  let membershipWrites = 0;
  const db = {
    prepare(sql: string) {
      return {
        bind(..._args: unknown[]) {
          return {
            async first() {
              if (sql.includes("SELECT tenant_id, parent_space_id FROM spaces")) return { tenant_id: "tenant-a", parent_space_id: "product-a" };
              if (sql.includes("SELECT tenant_id, spacetype_id, config_json FROM spaces")) return { tenant_id: "tenant-a", spacetype_id: "launchpad", config_json: null };
              if (sql.includes("SELECT tenant_id FROM spaces")) return { tenant_id: "tenant-a" };
              if (sql.includes("SELECT parent_space_id FROM spaces")) return { parent_space_id: "product-a" };
              if (sql.includes("SELECT 1 AS active FROM product_end_users")) return { active: 1 };
              if (sql.includes("SELECT role FROM space_members")) return { role: "owner" };
              if (sql.includes("SELECT id, role, email, expires_at, accepted_at FROM business_invites")) return { id: "invite-1", role: "member", email: "person@example.com", expires_at: new Date(Date.now() + 60_000).toISOString(), accepted_at: null };
              if (sql.includes("SELECT email FROM product_end_users")) return { email: options.accountEmail ?? "person@example.com" };
              if (sql.includes("SELECT COUNT(*) AS count FROM business_memberships")) return { count: 1 };
              return null;
            },
            async run() {
              if (sql.includes("UPDATE business_invites SET accepted_at")) {
                if (claimed) return { meta: { changes: 0 } };
                claimed = true;
                return { meta: { changes: 1 } };
              }
              if (sql.includes("INSERT INTO business_memberships")) membershipWrites++;
              return { meta: { changes: 1 } };
            },
            async all() { return { results: [] }; },
          };
        },
      };
    },
  };
  const env = {
    PLATFORM_SECRET: "secret",
    PLATFORM_DB: db,
    SPACE_DO: { idFromName: (name: string) => name, get: () => ({ fetch: async () => new Response(null, { status: 204 }) }) },
  } as never;
  return { env, membershipWrites: () => membershipWrites };
}

async function signedUserHeaders() {
  return {
    "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": "owner-a", "x-naelao-role": "product_end_user",
    "x-naelao-internal-token": await mintInternalToken("secret", "tenant-a"),
  };
}

describe("retired Launchpad business creation and directory routes", () => {
  it("does not expose the old business creation endpoint", async () => {
    const first = vi.fn();
    const env = { PLATFORM_SECRET: "secret", PLATFORM_DB: { prepare: vi.fn(() => ({ bind: vi.fn(() => ({ first })) })) } } as never;
    const response = await routeApp().request("/spaces/product-1/businesses", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": "user-a", "x-naelao-role": "product_end_user" },
      body: JSON.stringify({ name: "Business", spacetype_id: "launchpad" }),
    }, env);
    expect(response.status).toBe(404);
    expect(first).not.toHaveBeenCalled();
  });

  it("does not create child businesses for signed end-user sessions", async () => {
    const env = {
      PLATFORM_SECRET: "secret",
      PLATFORM_DB: { prepare: vi.fn(() => ({ bind: vi.fn(() => ({ first: vi.fn(async () => ({ tenant_id: "tenant-real" })) })) })) },
    } as never;
    const response = await routeApp().request("/spaces/product-1/businesses", {
      method: "POST", headers: {
        "content-type": "application/json", "x-naelao-tenant-id": "tenant-other", "x-naelao-user-id": "user-a", "x-naelao-role": "product_end_user",
        "x-naelao-internal-token": await mintInternalToken("secret", "tenant-other"),
      }, body: JSON.stringify({ name: "Business", spacetype_id: "launchpad" }),
    }, env);
    expect(response.status).toBe(404);
  });

  it("does not expose the cross-tenant business directory", async () => {
    const prepare = vi.fn();
    const env = { PLATFORM_SECRET: "secret", PLATFORM_DB: { prepare } } as never;
    const response = await routeApp().request("/spaces/product-1/directory", {
      headers: {
        "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": "owner-a", "x-naelao-role": "owner",
        "x-naelao-internal-token": await mintInternalToken("secret", "tenant-a"),
      },
    }, env);
    expect(response.status).toBe(404);
    expect(prepare).not.toHaveBeenCalled();
  });

  it.each([
    ["GET", "/spaces/product-1/my-businesses"],
    ["GET", "/spaces/product-1/directory"],
    ["POST", "/spaces/business-1/invites"],
    ["POST", "/spaces/business-1/invites/inv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/accept"],
    ["GET", "/spaces/business-1/business-members"],
    ["DELETE", "/spaces/business-1/business-members/member-2"],
  ] as const)("rejects or hides unsigned %s %s before database access", async (method, path) => {
    const prepare = vi.fn();
    const env = { PLATFORM_SECRET: "secret", PLATFORM_DB: { prepare } } as never;
    const response = await routeApp().request(path, {
      method, headers: { "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": "owner-a", "x-naelao-role": "owner" },
      ...(method === "POST" ? { body: JSON.stringify({ email: "invite@example.com", role: "owner" }) } : {}),
    }, env);
    expect([403, 404]).toContain(response.status);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("does not allow owners to mint owner-role invites", async () => {
    const { env } = invitationEnv();
    const response = await routeApp().request("/spaces/business-1/invites", {
      method: "POST", headers: await signedUserHeaders(), body: JSON.stringify({ email: "person@example.com", role: "owner" }),
    }, env);
    expect(response.status).toBe(400);
  });

  it("binds invite redemption to the invited email and atomically consumes the token", async () => {
    const mismatched = invitationEnv({ accountEmail: "different@example.com" });
    const path = "/spaces/business-1/invites/inv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/accept";
    const mismatchResponse = await routeApp().request(path, { method: "POST", headers: await signedUserHeaders() }, mismatched.env);
    expect(mismatchResponse.status).toBe(403);

    const env = invitationEnv();
    const app = routeApp();
    const headers = await signedUserHeaders();
    const responses = await Promise.all([
      app.request(path, { method: "POST", headers }, env.env),
      app.request(path, { method: "POST", headers }, env.env),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(env.membershipWrites()).toBe(1);
  });
});
