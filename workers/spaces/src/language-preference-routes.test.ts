import { describe, expect, it } from "vitest";
import worker from "./index.js";

type Profile = {
  email: string | null;
  display_name: string | null;
  first_seen_at: string;
  last_seen_at: string | null;
  suspended_at: string | null;
  email_verified_at: string | null;
  phone_e164?: string | null;
  phone_verified_at?: string | null;
  password_hash?: string | null;
  deleted_at: string | null;
  preferred_language: string | null;
};

function testEnv() {
  const spaces = new Map([
    ["product-a", { tenant_id: "tenant-a", parent_space_id: null as string | null }],
    ["business-a", { tenant_id: "tenant-a", parent_space_id: "product-a" }],
    ["product-b", { tenant_id: "tenant-a", parent_space_id: null as string | null }],
    ["product-c", { tenant_id: "tenant-b", parent_space_id: null as string | null }],
  ]);
  const productProfiles = new Map<string, Profile>([
    ["product-a:user-a", { email: "a@example.invalid", display_name: "A", first_seen_at: "now", last_seen_at: "recent", suspended_at: null, email_verified_at: "now", phone_e164: "+14155550100", phone_verified_at: "now", password_hash: "private", deleted_at: null, preferred_language: null }],
    ["product-a:user-b", { email: "b@example.invalid", display_name: null, first_seen_at: "now", last_seen_at: null, suspended_at: null, email_verified_at: "now", deleted_at: null, preferred_language: null }],
    ["product-b:user-a", { email: "a@example.invalid", display_name: null, first_seen_at: "now", last_seen_at: null, suspended_at: null, email_verified_at: "now", deleted_at: null, preferred_language: null }],
  ]);
  const members = new Map([["member-a", null as string | null], ["member-b", null as string | null]]);
  const clearedAuthData: string[] = [];
  const PLATFORM_DB = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async first() {
              if (sql.includes("SELECT tenant_id, parent_space_id FROM spaces")) return spaces.get(String(values[0])) ?? null;
              if (sql.includes("SELECT id, tenant_id FROM spaces")) {
                const root = [...spaces.entries()].find(([id, row]) => id === String(values[0]) && row.parent_space_id === null);
                return root ? { id: root[0], tenant_id: root[1].tenant_id } : null;
              }
              if (sql.includes("FROM users WHERE id")) return members.has(String(values[0])) ? { preferred_language: members.get(String(values[0])) } : null;
              if (sql.includes("FROM product_end_users")) {
                const key = `${String(values[0])}:${String(values[1])}`;
                const profile = productProfiles.get(key);
                return sql.includes("SELECT deleted_at") ? (profile ? { deleted_at: profile.deleted_at } : null) : profile ?? null;
              }
              return null;
            },
            async run() {
              if (sql.startsWith("UPDATE users")) {
                const id = String(values[1]);
                if (!members.has(id)) return { meta: { changes: 0 } };
                members.set(id, values[0] as string | null);
                return { meta: { changes: 1 } };
              }
              if (sql.startsWith("UPDATE product_end_users")) {
                const spaceId = String(values.at(-2));
                const userId = String(values.at(-1));
                const profile = productProfiles.get(`${spaceId}:${userId}`);
                if (!profile) return { meta: { changes: 0 } };
                if (sql.includes("phone_e164 = NULL")) {
                  profile.email = null;
                  profile.display_name = null;
                  profile.phone_e164 = null;
                  profile.phone_verified_at = null;
                  profile.email_verified_at = null;
                  profile.preferred_language = null;
                  profile.password_hash = null;
                  profile.last_seen_at = null;
                  profile.deleted_at = "now";
                }
                if (sql.includes("preferred_language = ?")) profile.preferred_language = values[0] as string | null;
                return { meta: { changes: 1 } };
              }
              if (sql.startsWith("DELETE FROM ")) {
                clearedAuthData.push(sql);
                return { meta: { changes: 1 } };
              }
              return { meta: { changes: 0 } };
            },
            async all() { return { results: [] }; },
          };
        },
      };
    },
  };
  const productUserCalls: string[] = [];
  const PRODUCT_USER_DO = {
    idFromName: (name: string) => name,
    get: () => ({ fetch: async (request: Request) => {
      productUserCalls.push(new URL(request.url).pathname);
      if (new URL(request.url).pathname === "/export") return Response.json({ conversations: [], preferences: {} });
      if (new URL(request.url).pathname === "/erase") return Response.json({ erased_at: "now", sessions_deleted: 1, conversations_deleted: 2 });
      return Response.json({});
    } }),
  };
  return { PLATFORM_DB, PRODUCT_USER_DO, productUserCalls, clearedAuthData, PLATFORM_SECRET: "test-secret" };
}

const env = testEnv();

async function call(path: string, method: string, role: string, userId: string, body?: unknown, tenantId = "tenant-a") {
  const request = new Request(`https://worker.test${path}`, {
    method,
    headers: { "x-naelao-role": role, "x-naelao-user-id": userId, "x-naelao-tenant-id": tenantId, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return worker.fetch(request, env as never, { waitUntil: () => undefined } as never);
}

describe("language preference profile routes", () => {
  it("round-trips, clears, rejects malformed tags, and ignores a supplied product user id", async () => {
    const path = "/spaces/business-a/product-users/me";
    const updated = await call(path, "PATCH", "product_end_user", "user-a", { preferred_language: "fr-ca", end_user_id: "user-b" });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ preferred_language: "fr-CA" });
    const read = await call("/spaces/product-a/product-users/me", "GET", "product_end_user", "user-a");
    expect(await read.json()).toMatchObject({ preferred_language: "fr-CA" });
    const isolated = await call("/spaces/product-a/product-users/me", "GET", "product_end_user", "user-b");
    expect(await isolated.json()).toMatchObject({ preferred_language: null });
    const otherProduct = await call("/spaces/product-b/product-users/me", "GET", "product_end_user", "user-a");
    expect(await otherProduct.json()).toMatchObject({ preferred_language: null });
    const invalid = await call(path, "PATCH", "product_end_user", "user-a", { preferred_language: "en_US" });
    expect(invalid.status).toBe(400);
    const cleared = await call(path, "PATCH", "product_end_user", "user-a", { preferred_language: null });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({ preferred_language: null });
  });

  it("exports the authenticated Space user's profile and active DO data from the Space root", async () => {
    const child = await call("/spaces/business-a/product-users/me/export", "GET", "product_end_user", "user-a");
    expect(child.status).toBe(200);
    const data = await child.json() as { profile: { end_user_id: string; email: string; phone_e164: string }; product_user_data: { conversations: unknown[]; preferences: Record<string, unknown> } };
    expect(data.profile).toMatchObject({ end_user_id: "user-a", email: "a@example.invalid", phone_e164: "+14155550100" });
    expect(data.product_user_data).toEqual({ conversations: [], preferences: {} });
    expect(env.productUserCalls).toContain("/export");
  });

  it("erases the product-root identity and phone data when requested from a child business", async () => {
    const response = await call("/spaces/business-a/product-users/me", "DELETE", "product_end_user", "user-a");
    expect(response.status).toBe(200);
    expect(env.productUserCalls).toContain("/erase");
    expect(await response.json()).toMatchObject({ erased: true, sessions_deleted: 1, conversations_deleted: 2 });
    expect(env.clearedAuthData.map((sql) => sql.split(" ")[2])).toEqual([
      "password_reset_tokens", "email_verification_tokens", "whatsapp_auth_challenges",
    ]);
    const readAfterErase = await call("/spaces/product-a/product-users/me/export", "GET", "product_end_user", "user-a");
    expect(await readAfterErase.json()).toMatchObject({ profile: { email: null, phone_e164: null, phone_verified_at: null } });
  });

  it("does not resolve a product user's profile across a tenant boundary", async () => {
    const response = await call("/spaces/product-c/product-users/me/export", "GET", "product_end_user", "user-a");
    expect(response.status).toBe(404);
    const noTenant = await call("/spaces/product-a/product-users/me/export", "GET", "product_end_user", "user-a", undefined, "");
    expect(noTenant.status).toBe(404);
  });

  it("round-trips and clears a platform member preference on their own account", async () => {
    const path = "/me/preferences";
    const updated = await call(path, "PATCH", "owner", "member-a", { preferred_language: "sw-ke" });
    expect(await updated.json()).toMatchObject({ preferred_language: "sw-KE" });
    const read = await call(path, "GET", "owner", "member-a");
    expect(await read.json()).toMatchObject({ preferred_language: "sw-KE" });
    const otherMember = await call(path, "GET", "owner", "member-b");
    expect(await otherMember.json()).toMatchObject({ preferred_language: null });
    const cleared = await call(path, "PATCH", "owner", "member-a", { preferred_language: null });
    expect(await cleared.json()).toMatchObject({ preferred_language: null });
    const invalid = await call(path, "PATCH", "owner", "member-a", { preferred_language: "en_US" });
    expect(invalid.status).toBe(400);
  });
});
