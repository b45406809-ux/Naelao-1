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
  erasure_started_at?: string | null;
  preferred_language: string | null;
};

function testEnv() {
  const spaces = new Map([
    ["product-a", { tenant_id: "tenant-a", product_id: null as string | null, parent_space_id: null as string | null }],
    ["business-a", { tenant_id: "tenant-a", product_id: "product-a", parent_space_id: null }],
    ["business-b", { tenant_id: "tenant-a", product_id: "product-a", parent_space_id: null }],
    ["department-a", { tenant_id: "tenant-a", product_id: null, parent_space_id: "business-a" }],
    ["product-b", { tenant_id: "tenant-a", product_id: null as string | null, parent_space_id: null as string | null }],
    ["product-c", { tenant_id: "tenant-b", product_id: null as string | null, parent_space_id: null as string | null }],
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
              if (sql.includes("JOIN space_members sm")) return { role: "owner" };
              if (sql.includes("SELECT tenant_id, product_id FROM spaces")) return spaces.get(String(values[0])) ?? null;
              if (sql.includes("SELECT id, tenant_id FROM products")) {
                const rootId = String(values[0]);
                const root = spaces.get(rootId);
                return root && root.product_id === null ? { id: rootId, tenant_id: root.tenant_id } : null;
              }
              if (sql.includes("FROM users WHERE id")) return members.has(String(values[0])) ? { preferred_language: members.get(String(values[0])) } : null;
              if (sql.includes("FROM product_end_users")) {
                const key = `${String(values[0])}:${String(values[1])}`;
                const profile = productProfiles.get(key);
                if (sql.includes("SELECT erasure_started_at")) return profile ? { erasure_started_at: profile.erasure_started_at ?? null } : null;
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
                if (sql.includes("erasure_started_at=COALESCE")) profile.erasure_started_at = "now";
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
            async all() {
              if (sql.includes("product_user_erasure_spaces")) {
                const selected = new Set([...spaces.entries()]
                  .filter(([, value]) => value.tenant_id === values[0]
                    && (value.product_id === values[1] || value.parent_space_id === values[2]))
                  .map(([id]) => id));
                for (let changed = true; changed;) {
                  changed = false;
                  for (const [id, value] of spaces) if (value.tenant_id === values[0]
                    && value.parent_space_id && selected.has(value.parent_space_id) && !selected.has(id)) {
                    selected.add(id);
                    changed = true;
                  }
                }
                return { results: [...selected].map(id => ({ id })) };
              }
              return { results: [] };
            },
          };
        },
      };
    },
    async batch(statements: Array<{ run: () => Promise<unknown> }>) {
      return Promise.all(statements.map((statement) => statement.run()));
    },
  };
  const productUserCalls: string[] = [];
  const spaceDoCalls: Array<{ path: string; userId: string | null }> = [];
  const microAppArchiveSpaceIds: string[] = [];
  const microAppErasureResponses: Response[] = [];
  const PRODUCT_USER_DO = {
    idFromName: (name: string) => name,
    get: () => ({ fetch: async (request: Request) => {
      productUserCalls.push(new URL(request.url).pathname);
      if (new URL(request.url).pathname === "/export") return Response.json({ conversations: [], preferences: {} });
      if (new URL(request.url).pathname === "/erase") return Response.json({ erased_at: "now", sessions_deleted: 1, conversations_deleted: 2 });
      return Response.json({});
    } }),
  };
  const SPACE_DO = {
    idFromName: (name: string) => name,
    get: () => ({ fetch: async (request: Request) => {
      const path = new URL(request.url).pathname;
      const query = new URL(request.url).searchParams;
      const body = await request.clone().json().catch(() => ({})) as { spaceId?: unknown };
      spaceDoCalls.push({ path, userId: request.headers.get("x-naelao-user-id"), ...(typeof body.spaceId === "string" ? { spaceId: body.spaceId } : {}) });
      if (path === "/product-user-micro-app-archives") microAppArchiveSpaceIds.push(query.get("space_id") ?? "");
      if (path === "/product-user-micro-app-erasure" && request.method === "POST")
        return microAppErasureResponses.shift() ?? Response.json({ erased: true, status: "complete" });
      if (path.endsWith("/preview")) return Response.json({ preview_id: "preview-a", results: [] });
      if (path.endsWith("/restore")) return Response.json({ status: "applied", results: [] });
      return Response.json({ snapshots: [], omissions: { privateScopeInstallations: 0, uninitializedActors: 0, unsupportedInstallations: 0 } });
    } }),
  };
  return { PLATFORM_DB, PRODUCT_USER_DO, SPACE_DO, productProfiles, productUserCalls, spaceDoCalls, microAppErasureResponses,
    microAppArchiveSpaceIds, clearedAuthData, PLATFORM_SECRET: "test-secret" };
}

const env = testEnv();

async function call(path: string, method: string, role: string, userId: string, body?: unknown, tenantId = "tenant-a", targetEnv = env) {
  const request = new Request(`https://worker.test${path}`, {
    method,
    headers: { "x-naelao-role": role, "x-naelao-user-id": userId, "x-naelao-tenant-id": tenantId, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return worker.fetch(request, targetEnv as never, { waitUntil: () => undefined } as never);
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
    const data = await child.json() as { export_version: string; profile: { end_user_id: string; email: string; phone_e164: string };
      product_user_data: { conversations: unknown[]; preferences: Record<string, unknown> };
      micro_app_archives: unknown[]; micro_app_archive_omissions: { privateScopeInstallations: number; uninitializedActors: number; unsupportedInstallations: number } };
    expect(data.export_version).toBe("2");
    expect(data.profile).toMatchObject({ end_user_id: "user-a", email: "a@example.invalid", phone_e164: "+14155550100" });
    expect(data.product_user_data).toEqual({ conversations: [], preferences: {} });
    expect(data.micro_app_archives).toEqual([]);
    expect(data.micro_app_archive_omissions).toEqual({ privateScopeInstallations: 0, uninitializedActors: 0, unsupportedInstallations: 0 });
    expect(env.productUserCalls).toContain("/export");
    expect(env.spaceDoCalls).toContainEqual({ path: "/product-user-micro-app-archives", userId: "user-a" });
    expect(env.microAppArchiveSpaceIds.sort()).toEqual(["business-a", "business-b", "department-a"]);
  });

  it("forwards only the verified product-user identity to archive preview and restore", async () => {
    const preview = await call("/spaces/business-a/product-users/me/micro-app-archives/preview", "POST", "product_end_user", "user-a",
      { snapshots: [], user_id: "user-b" });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ preview_id: "preview-a" });
    const restored = await call("/spaces/business-a/product-users/me/micro-app-archives/restore", "POST", "product_end_user", "user-a",
      { preview_id: "preview-a", snapshots: [], user_id: "user-b" });
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ status: "applied" });
    expect(env.spaceDoCalls.slice(-2)).toEqual([
      { path: "/product-user-micro-app-archives/preview", userId: "user-a" },
      { path: "/product-user-micro-app-archives/restore", userId: "user-a" },
    ]);
  });

  it("erases the product-root identity and phone data when requested from a child business", async () => {
    const response = await call("/spaces/business-a/product-users/me", "DELETE", "product_end_user", "user-a");
    expect(response.status).toBe(200);
    expect(env.productUserCalls).toContain("/erase");
    expect(await response.json()).toMatchObject({ erased: true, sessions_deleted: 1, conversations_deleted: 2 });
    expect(env.clearedAuthData.map((sql) => sql.split(" ")[2])).toEqual([
      "password_reset_tokens", "email_verification_tokens", "whatsapp_auth_challenges", "dunning_notification_attempts",
    ]);
    expect(env.clearedAuthData).toContain("DELETE FROM dunning_notification_attempts WHERE tenant_id = ? AND product_id = ? AND end_user_id = ? AND subscription_scope = 'product_user_subscription'");
    const readAfterErase = await call("/spaces/product-a/product-users/me/export", "GET", "product_end_user", "user-a");
    expect(readAfterErase.status).toBe(410);
    expect(await readAfterErase.json()).toMatchObject({ error_code: "product_user_erasure_started" });
  });

  it("resumes account erasure without deleting the profile until MicroApp cleanup finishes", async () => {
    const localEnv = testEnv();
    localEnv.microAppErasureResponses.push(Response.json({ erased: false, status: "pending", pending_actors: 1 }, { status: 202 }));
    const first = await call("/spaces/business-a/product-users/me", "DELETE", "product_end_user", "user-a", undefined, "tenant-a", localEnv);
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({ erased: false, erasure_status: "pending", pending_actors: 1 });
    expect(localEnv.productUserCalls).not.toContain("/erase");
    expect(localEnv.clearedAuthData).toHaveLength(0);
    expect(localEnv.productProfiles.get("product-a:user-a")?.email).toBe("a@example.invalid");

    const retry = await call("/spaces/business-a/product-users/me", "DELETE", "product_end_user", "user-a", undefined, "tenant-a", localEnv);
    expect(retry.status).toBe(200);
    expect(localEnv.productUserCalls).toContain("/erase");
    expect(localEnv.clearedAuthData).not.toHaveLength(0);
    expect(localEnv.productProfiles.get("product-a:user-a")?.email).toBeNull();
  });

  it("tombstones every product Space before completing account erasure", async () => {
    const localEnv = testEnv();
    localEnv.microAppErasureResponses.push(Response.json({ erased: false, status: "pending", pending_actors: 1 }, { status: 202 }));
    const response = await call("/spaces/business-a/product-users/me", "DELETE", "product_end_user", "user-a", undefined, "tenant-a", localEnv);
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ erasure_status: "pending", pending_spaces: 1, pending_actors: 1 });
    expect(localEnv.spaceDoCalls.filter(call => call.path === "/product-user-micro-app-erasure").map(call => call.spaceId).sort())
      .toEqual(["business-a", "business-b", "department-a"]);
    expect(localEnv.productUserCalls).not.toContain("/erase");
  });

  it("keeps the account fence and continues fan-out after a SpaceDO failure", async () => {
    const localEnv = testEnv();
    localEnv.microAppErasureResponses.push(Response.json({ error_code: "micro_app_storage_unavailable" }, { status: 503 }));
    const response = await call("/spaces/business-a/product-users/me", "DELETE", "product_end_user", "user-a", undefined, "tenant-a", localEnv);
    expect(response.status).toBe(503);
    expect(localEnv.spaceDoCalls.filter(call => call.path === "/product-user-micro-app-erasure").map(call => call.spaceId).sort())
      .toEqual(["business-a", "business-b", "department-a"]);
    expect(localEnv.productProfiles.get("product-a:user-a")?.erasure_started_at).toBe("now");
    expect(localEnv.productUserCalls).not.toContain("/erase");
    expect(localEnv.clearedAuthData).toHaveLength(0);
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
