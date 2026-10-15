import { describe, expect, it } from "vitest";
import worker from "./index.js";

type Profile = {
  email: string | null;
  display_name: string | null;
  first_seen_at: string;
  last_seen_at: string | null;
  suspended_at: string | null;
  email_verified_at: string | null;
  deleted_at: string | null;
  preferred_language: string | null;
};

function testEnv() {
  const productProfiles = new Map<string, Profile>([
    ["product-a:user-a", { email: "a@example.invalid", display_name: null, first_seen_at: "now", last_seen_at: null, suspended_at: null, email_verified_at: "now", deleted_at: null, preferred_language: null }],
    ["product-a:user-b", { email: "b@example.invalid", display_name: null, first_seen_at: "now", last_seen_at: null, suspended_at: null, email_verified_at: "now", deleted_at: null, preferred_language: null }],
    ["product-b:user-a", { email: "a@example.invalid", display_name: null, first_seen_at: "now", last_seen_at: null, suspended_at: null, email_verified_at: "now", deleted_at: null, preferred_language: null }],
  ]);
  const members = new Map([["member-a", null as string | null], ["member-b", null as string | null]]);
  const PLATFORM_DB = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async first() {
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
                if (sql.includes("preferred_language = ?")) profile.preferred_language = values[0] as string | null;
                return { meta: { changes: 1 } };
              }
              return { meta: { changes: 0 } };
            },
          };
        },
      };
    },
  };
  const PRODUCT_USER_DO = {
    idFromName: (name: string) => name,
    get: () => ({ fetch: async () => Response.json({ balance_credits: 4 }) }),
  };
  return { PLATFORM_DB, PRODUCT_USER_DO, PLATFORM_SECRET: "test-secret" } as never;
}

const env = testEnv();

async function call(path: string, method: string, role: string, userId: string, body?: unknown) {
  const request = new Request(`https://worker.test${path}`, {
    method,
    headers: { "x-naelao-role": role, "x-naelao-user-id": userId, "x-naelao-tenant-id": "tenant-a", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return worker.fetch(request, env, { waitUntil: () => undefined } as never);
}

describe("language preference profile routes", () => {
  it("round-trips, clears, rejects malformed tags, and ignores a supplied product user id", async () => {
    const path = "/spaces/product-a/product-users/me";
    const updated = await call(path, "PATCH", "product_end_user", "user-a", { preferred_language: "fr-ca", end_user_id: "user-b" });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ preferred_language: "fr-CA" });
    const read = await call(path, "GET", "product_end_user", "user-a");
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
