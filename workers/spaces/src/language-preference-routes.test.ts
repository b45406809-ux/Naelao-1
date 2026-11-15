import { describe, expect, it } from "vitest";
import { mintInternalToken } from "@naelao/http";
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
  let currentDunning = true;
  const members = new Map([["member-a", null as string | null], ["member-b", null as string | null]]);
  const clearedAuthData: string[] = [];
  const PLATFORM_DB = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async first() {
              if (sql.includes("SELECT 1 AS current FROM products")) return currentDunning ? { current: 1 } : null;
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
  const productInboxRequests: Array<{ method: string; body: unknown }> = [];
  const billingRequests: Request[] = [];
  const billingStatus = {
    subscription: { plan_tier: "growth", status: "past_due", current_period_end: "2026-12-01T00:00:00.000Z" },
    notifications: [{ provider_outcome: "provider_accepted", attempt_count: 2, last_attempt_at: "2026-11-14T00:00:00.000Z", accepted_at: "2026-11-14T00:00:00.000Z" }],
    dispatches: [{ status: "pending", attempt_count: 2, updated_at: "2026-11-14T00:00:00.000Z", sent_at: null }],
    purchase_history: { purchases: [{ provider: "lemon_squeezy", plan_tier: "growth", amount_cents: 2900, currency: "USD", purchased_at: "2026-11-13T00:00:00.000Z" }], has_more: false },
  };
  let billingStatusResponse = Response.json(billingStatus);
  const BILLING_WORKER = { fetch: async (request: Request) => {
    billingRequests.push(request);
    return billingStatusResponse.clone();
  } };
  let productUserEraseResponse: Response | null = null;
  const spaceDoCalls: Array<{ path: string; userId: string | null }> = [];
  const microAppArchiveSpaceIds: string[] = [];
  const chatHistoryRequests: Array<{ spaceId: string; userId: string | null; tenantId: string | null; internalToken: string | null }> = [];
  const chatHistoryResponses = new Map<string, Response>();
  const spaceDataEraseUsers: string[] = [];
  const microAppErasureResponses: Response[] = [];
  const PRODUCT_USER_DO = {
    idFromName: (name: string) => name,
    get: () => ({ fetch: async (request: Request) => {
      productUserCalls.push(new URL(request.url).pathname);
      if (new URL(request.url).pathname === "/export") return Response.json({ conversations: [], preferences: {}, notifications: [], inbox_notifications: [] });
      if (new URL(request.url).pathname === "/inbox-notifications") {
        const body = await request.clone().json().catch(() => ({}));
        productInboxRequests.push({ method: request.method, body });
        return request.method === "GET" ? Response.json({ data: [{ id: `dunning-${"a".repeat(64)}`, kind: "billing_payment_failed",
          title: "Payment needs attention", body: "Review your subscription.", status: "unread", read_at: null, created_at: "now" }] })
          : Response.json({ ok: true }, { status: body && typeof body === "object" && "action" in body && body.action === "deliver" ? 201 : 200 });
      }
      if (new URL(request.url).pathname === "/erase") {
        const response = productUserEraseResponse ?? Response.json({ erased_at: "now", sessions_deleted: 1, conversations_deleted: 2, notifications_deleted: 3, inbox_notifications_deleted: 0 });
        productUserEraseResponse = null;
        return response;
      }
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
      if (path === "/product-user-chat-history-export") {
        const spaceId = query.get("space_id") ?? "";
        chatHistoryRequests.push({ spaceId, userId: request.headers.get("x-naelao-user-id"), tenantId: request.headers.get("x-naelao-tenant-id"),
          internalToken: request.headers.get("x-naelao-internal-token") });
        const configured = chatHistoryResponses.get(spaceId);
        return configured ? configured.clone() : Response.json({ space_id: spaceId, sessions: [], messages: [] });
      }
      if (path === "/product-user-micro-app-archives") microAppArchiveSpaceIds.push(query.get("space_id") ?? "");
      if (path === "/product-user-micro-app-erasure" && request.method === "POST")
        return microAppErasureResponses.shift() ?? Response.json({ erased: true, status: "complete" });
      if (path === "/me/data" && request.method === "DELETE") {
        spaceDataEraseUsers.push(query.get("user_id") ?? "");
        return Response.json({ erased: true, sessions_deleted: 1, messages_deleted: 2 });
      }
      if (path.endsWith("/preview")) return Response.json({ preview_id: "preview-a", results: [] });
      if (path.endsWith("/restore")) return Response.json({ status: "applied", results: [] });
      return Response.json({ snapshots: [], omissions: { privateScopeInstallations: 0, uninitializedActors: 0, unsupportedInstallations: 0 } });
    } }),
  };
  return { PLATFORM_DB, PRODUCT_USER_DO, SPACE_DO, BILLING_WORKER, productProfiles, productUserCalls, productInboxRequests, billingRequests, billingStatus,
    setCurrentDunning(value: boolean) { currentDunning = value; },
    setBillingStatusResponse(response: Response) { billingStatusResponse = response; }, spaceDoCalls, microAppErasureResponses,
    setProductUserEraseResponse(response: Response) { productUserEraseResponse = response; },
    microAppArchiveSpaceIds, chatHistoryRequests,
    setChatHistoryResponse(spaceId: string, response: Response) { chatHistoryResponses.set(spaceId, response); },
    spaceDataEraseUsers, clearedAuthData, PLATFORM_SECRET: "test-secret" };
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

async function internalProductInboxCall(targetEnv: ReturnType<typeof testEnv>, body: unknown, secret = "test-secret") {
  const tenantId = "tenant-a";
  const token = await mintInternalToken(secret, tenantId);
  return worker.fetch(new Request("https://worker.test/internal/product-user-inbox-notifications", {
    method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": tenantId,
      "x-naelao-internal-token": token }, body: JSON.stringify(body),
  }), targetEnv as never, { waitUntil: () => undefined } as never);
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
    const exportEnv = testEnv();
    const transcript = { space_id: "business-a", sessions: ["session-user-a"], messages: [{ id: "message-user-a",
      session_id: "session-user-a", role: "user", content: "my transcript", tool_call_id: null, tool_name: null,
      token_count: 3, created_at: "2026-11-14T00:00:00.000Z", author_type: "user", author_id: "user-a", metadata: "{}" }] };
    exportEnv.setChatHistoryResponse("business-a", Response.json(transcript));
    const child = await call("/spaces/business-a/product-users/me/export", "GET", "product_end_user", "user-a", undefined, "tenant-a", exportEnv);
    expect(child.status).toBe(200);
    const data = await child.json() as { export_version: string; profile: { end_user_id: string; email: string; phone_e164: string };
      product_user_data: { conversations: unknown[]; preferences: Record<string, unknown>; notifications: unknown[]; inbox_notifications: unknown[] };
      billing_status: typeof env.billingStatus;
      chat_history: Array<typeof transcript>;
      micro_app_archives: unknown[]; micro_app_archive_omissions: { privateScopeInstallations: number; uninitializedActors: number; unsupportedInstallations: number } };
    expect(data.export_version).toBe("3");
    expect(child.headers.get("cache-control")).toBe("private, no-store");
    expect(data.profile).toMatchObject({ end_user_id: "user-a", email: "a@example.invalid", phone_e164: "+14155550100" });
    expect(data.product_user_data).toEqual({ conversations: [], preferences: {}, notifications: [], inbox_notifications: [] });
    expect(data.billing_status).toEqual(env.billingStatus);
    expect(data.chat_history).toEqual([transcript,
      { space_id: "business-b", sessions: [], messages: [] },
      { space_id: "department-a", sessions: [], messages: [] }]);
    expect(data.micro_app_archives).toEqual([]);
    expect(data.micro_app_archive_omissions).toEqual({ privateScopeInstallations: 0, uninitializedActors: 0, unsupportedInstallations: 0 });
    expect(exportEnv.productUserCalls).toContain("/export");
    expect(exportEnv.billingRequests).toHaveLength(1);
    expect(new URL(exportEnv.billingRequests[0]!.url).pathname).toBe("/internal/product-user-billing-status");
    expect(exportEnv.billingRequests[0]!.headers.get("x-naelao-tenant-id")).toBe("tenant-a");
    expect(exportEnv.billingRequests[0]!.headers.get("x-naelao-internal-token")).toBeTruthy();
    expect(await exportEnv.billingRequests[0]!.json()).toEqual({ product_id: "product-a", end_user_id: "user-a" });
    expect(exportEnv.spaceDoCalls).toContainEqual({ path: "/product-user-micro-app-archives", userId: "user-a" });
    expect(exportEnv.microAppArchiveSpaceIds.sort()).toEqual(["business-a", "business-b", "department-a"]);
    expect(exportEnv.chatHistoryRequests).toEqual(["business-a", "business-b", "department-a"].map(spaceId => ({
      spaceId, userId: "user-a", tenantId: "tenant-a", internalToken: expect.any(String),
    })));
  });

  it("reads and marks only the authenticated Product user's private billing inbox", async () => {
    const response = await call("/spaces/product-a/product-users/me/inbox?status=unread", "GET", "product_end_user", "user-a");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ data: [{ id: `dunning-${"a".repeat(64)}`, status: "unread" }] });
    expect(env.productUserCalls).toContain("/inbox-notifications");
    const denied = await call("/spaces/product-a/product-users/me/inbox", "GET", "owner", "user-a");
    expect(denied.status).toBe(404);
    const marked = await call("/spaces/product-a/product-users/me/inbox", "POST", "product_end_user", "user-a",
      { action: "mark_read", notification_id: `dunning-${"a".repeat(64)}` });
    expect(marked.status).toBe(200);
    expect(env.productInboxRequests.at(-1)).toEqual({ method: "POST", body: { action: "mark_read", notification_id: `dunning-${"a".repeat(64)}` } });
  });

  it("accepts dunning inbox delivery only through tenant HMAC and the current exact subscription", async () => {
    const targetEnv = testEnv();
    const notice = { product_id: "product-a", end_user_id: "user-a", provider: "lemon_squeezy",
      provider_subscription_id: "subscription-a", provider_updated_at: "2026-11-14T00:00:00.000Z",
      notification_id: `dunning-${"a".repeat(64)}`, title: "Payment needs attention",
      body: "A payment for your product subscription failed. Sign in to review your current plan status and payment options." };
    const accepted = await internalProductInboxCall(targetEnv, notice);
    expect(accepted.status).toBe(201);
    expect(targetEnv.productInboxRequests.at(-1)).toEqual({ method: "POST", body: {
      action: "deliver", notification_id: notice.notification_id, kind: "billing_payment_failed",
      title: notice.title, body: notice.body,
    } });

    const denied = await internalProductInboxCall(targetEnv, notice, "wrong-secret");
    expect(denied.status).toBe(403);
    targetEnv.setCurrentDunning(false);
    const stale = await internalProductInboxCall(targetEnv, { ...notice, notification_id: `dunning-${"b".repeat(64)}` });
    expect(stale.status).toBe(204);
    expect(targetEnv.productInboxRequests).toHaveLength(1);
  });

  it("fails closed when Billing is missing, unavailable, or returns malformed or excessive status data", async () => {
    const noBinding = { ...testEnv(), BILLING_WORKER: undefined };
    const missing = await call("/spaces/business-a/product-users/me/export", "GET", "product_end_user", "user-a", undefined,
      "tenant-a", noBinding as never);
    expect(missing.status).toBe(503);
    expect(await missing.json()).toMatchObject({ error_code: "billing_status_export_unavailable" });

    const failedEnv = testEnv();
    failedEnv.setBillingStatusResponse(Response.json({ error_code: "temporary_failure" }, { status: 503 }));
    const failed = await call("/spaces/business-a/product-users/me/export", "GET", "product_end_user", "user-a", undefined,
      "tenant-a", failedEnv);
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ error_code: "billing_status_export_unavailable" });

    const malformedEnv = testEnv();
    malformedEnv.setBillingStatusResponse(Response.json({ ...malformedEnv.billingStatus, provider_subscription_id: "must-not-leak" }));
    const malformed = await call("/spaces/business-a/product-users/me/export", "GET", "product_end_user", "user-a", undefined,
      "tenant-a", malformedEnv);
    expect(malformed.status).toBe(502);
    expect(await malformed.json()).toMatchObject({ error_code: "billing_status_export_invalid" });
    expect(malformedEnv.productUserCalls).toHaveLength(0);

    const excessiveEnv = testEnv();
    excessiveEnv.setBillingStatusResponse(Response.json({ ...excessiveEnv.billingStatus,
      notifications: Array.from({ length: 11 }, () => excessiveEnv.billingStatus.notifications[0]) }));
    const excessive = await call("/spaces/business-a/product-users/me/export", "GET", "product_end_user", "user-a", undefined,
      "tenant-a", excessiveEnv);
    expect(excessive.status).toBe(502);
    expect(await excessive.json()).toMatchObject({ error_code: "billing_status_export_invalid" });
    expect(excessiveEnv.productUserCalls).toHaveLength(0);
  });

  it("does not export a silently truncated purchase history", async () => {
    const truncatedEnv = testEnv();
    truncatedEnv.setBillingStatusResponse(Response.json({ ...truncatedEnv.billingStatus,
      purchase_history: { ...truncatedEnv.billingStatus.purchase_history, has_more: true } }));
    const response = await call("/spaces/business-a/product-users/me/export", "GET", "product_end_user", "user-a", undefined,
      "tenant-a", truncatedEnv);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error_code: "billing_purchase_history_limit_exceeded" });
    expect(truncatedEnv.productUserCalls).toHaveLength(0);

    const malformedEnv = testEnv();
    malformedEnv.setBillingStatusResponse(Response.json({ ...malformedEnv.billingStatus,
      purchase_history: { purchases: [{ provider_event_id: "must-not-leak" }], has_more: false } }));
    const malformed = await call("/spaces/business-a/product-users/me/export", "GET", "product_end_user", "user-a", undefined,
      "tenant-a", malformedEnv);
    expect(malformed.status).toBe(502);
    expect(await malformed.json()).toMatchObject({ error_code: "billing_status_export_invalid" });
    expect(malformedEnv.productUserCalls).toHaveLength(0);
  });

  it("fails closed when a Space transcript export is malformed or exceeds the response ceiling", async () => {
    const malformedEnv = testEnv();
    malformedEnv.setChatHistoryResponse("business-a", Response.json({ space_id: "business-b", sessions: [], messages: [] }));
    const malformed = await call("/spaces/business-a/product-users/me/export", "GET", "product_end_user", "user-a", undefined,
      "tenant-a", malformedEnv);
    expect(malformed.status).toBe(502);
    expect(await malformed.json()).toMatchObject({ error_code: "chat_history_export_response_invalid" });

    const oversizedEnv = testEnv();
    oversizedEnv.setChatHistoryResponse("business-a", new Response("{}", {
      headers: { "content-length": String(4 * 1024 * 1024 + 1) },
    }));
    const oversized = await call("/spaces/business-a/product-users/me/export", "GET", "product_end_user", "user-a", undefined,
      "tenant-a", oversizedEnv);
    expect(oversized.status).toBe(502);
    expect(await oversized.json()).toMatchObject({ error_code: "chat_history_export_response_invalid" });
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
    expect(env.spaceDataEraseUsers).toEqual(["user-a", "user-a", "user-a"]);
    expect(await response.json()).toMatchObject({ erased: true, sessions_deleted: 1, conversations_deleted: 2, notifications_deleted: 3 });
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
    expect(localEnv.spaceDataEraseUsers).toHaveLength(3);

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
    expect(localEnv.spaceDataEraseUsers).toHaveLength(3);
  });

  it("keeps PII and recovery rows fenced when ProductUserDO does not confirm erasure", async () => {
    const localEnv = testEnv();
    localEnv.setProductUserEraseResponse(Response.json({ error_code: "temporary_failure" }, { status: 503 }));
    const response = await call("/spaces/business-a/product-users/me", "DELETE", "product_end_user", "user-a",
      undefined, "tenant-a", localEnv);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error_code: "product_user_record_erasure_failed" });
    expect(localEnv.productProfiles.get("product-a:user-a")).toMatchObject({
      erasure_started_at: "now", email: "a@example.invalid", password_hash: "private", deleted_at: null,
    });
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
