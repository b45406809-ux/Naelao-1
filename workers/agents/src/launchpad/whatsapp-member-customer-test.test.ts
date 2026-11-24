import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeD1 } from "../../../../tests/stubs/d1-sqlite.js";
import { opaqueExternalSubject } from "../channel-external-quota.js";
import { app } from "../index.js";

const platformSecret = "whatsapp-customer-test-platform-secret";
const appSecret = "whatsapp-customer-test-meta-app-secret";
const tenantId = "tenant-a";
const spaceId = "space-a";
const userId = "member-a";
const projectId = "project-a";
const phoneNumberId = "123456789012345";
const senderId = "15551234567";
const installationId = "install-a";
const handlerHash = "a".repeat(64);
const packageVersion = "1.2.3";
const challengeCode = "deadbeefcafebabe";

const migrationFiles = [
  "0002_orgs.sql", "0003_spaces.sql", "0021_space_members.sql", "0034_space_hierarchy.sql",
  "0038_channel_links.sql", "0039_channel_links_project.sql", "0044_naelao_product.sql",
  "0045_builder_dashboard_api.sql", "0058_product_end_users_deleted_at.sql", "0099_channel_model_overrides.sql",
  "0103_channel_extension_bindings.sql", "0285_whatsapp_member_channel_access.sql",
  "0156_product_registry.sql", "0261_product_user_erasure_fence.sql", "0286_whatsapp_member_contact_verification.sql", "0288_whatsapp_member_routing_mode.sql",
  "0289_whatsapp_member_customer_test.sql",
];

function fixture() {
  const db = createFakeD1(migrationFiles.map(name => readFileSync(new URL(`../../../../infra/migrations/${name}`, import.meta.url), "utf8")));
  const queries: string[] = [];
  const prepare = db.prepare.bind(db);
  db.prepare = (sql: string) => { queries.push(sql); return prepare(sql); };
  db.db.exec(`
    INSERT INTO orgs(id,name,owner_id,status) VALUES('${tenantId}','Test tenant','owner-a','active');
    INSERT INTO spaces(id,tenant_id,spacetype_id,name,status,config_json) VALUES('${spaceId}','${tenantId}','type-a','Test space','active','{}');
    INSERT INTO space_members(id,space_id,tenant_id,end_user_id,role) VALUES('membership-a','${spaceId}','${tenantId}','${userId}','member');
    INSERT INTO channel_links(space_id,tenant_id,channel,enabled,member_routing_mode,project_id,extension_instance_id,extension_script_sha256)
      VALUES('${spaceId}','${tenantId}','whatsapp',1,'staff_and_customers','${projectId}','${installationId}','${handlerHash}');
    INSERT INTO assistant_channel_member_access(tenant_id,space_id,user_id,channel,project_id,status,granted_by)
      VALUES('${tenantId}','${spaceId}','${userId}','whatsapp','${projectId}','enabled','owner-a');
  `);

  const agentRequests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const agentFetch = vi.fn(async (request: Request) => {
    agentRequests.push({ path: new URL(request.url).pathname, body: await request.clone().json() as Record<string, unknown> });
    return Response.json({ ok: true });
  });
  const providerFetch = vi.fn(async () => Response.json({ messages: [{ id: "provider-message" }] }));
  vi.stubGlobal("fetch", providerFetch);
  const spacesFetch = vi.fn(async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path.endsWith(`/projects/${projectId}/members`))
      return Response.json({ data: [{ user_id: userId, role: "owner" }] });
    if (path.endsWith(`/workflow-installations/${installationId}`)) return Response.json({
      instance: { instance_id: installationId, tenant_id: tenantId, space_id: spaceId, project_id: projectId,
        status: "active", scope: "PROJECT_SHARED" },
      manifest: { id: "customer-handler", bundle: { version: packageVersion },
        channels: [{ kind: "channel", provider: "whatsapp", handlerScript: "handler.ts" }] },
      release: { signatureValid: true },
    });
    return Response.json({ error_code: "not_found" }, { status: 404 });
  });
  const env = {
    PLATFORM_SECRET: platformSecret,
    WHATSAPP_ACCESS_TOKEN: "local-test-token",
    WHATSAPP_PHONE_NUMBER_ID: phoneNumberId,
    WHATSAPP_APP_SECRET: appSecret,
    PUBLIC_AGENTS_URL: "https://agents.example.test",
    PLATFORM_DB: db,
    SPACES_WORKER: { fetch: spacesFetch },
    NAELAO_AGENT_DO: { idFromName: (name: string) => name, get: () => ({ fetch: agentFetch }) },
  };
  return { db, env, queries, agentFetch, agentRequests, providerFetch, spacesFetch };
}

async function opaqueSha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function signature(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const hex = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return `sha256=${hex}`;
}

async function inbound(f: ReturnType<typeof fixture>, text: string, eventId = "wamid-phone-test-1") {
  const body = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "waba-a", changes: [{ field: "messages", value: {
    metadata: { phone_number_id: phoneNumberId, display_phone_number: "+15550000000" },
    contacts: [{ wa_id: senderId }],
    messages: [{ id: eventId, from: senderId, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }],
  } }] }] });
  return app.request("/channels/platform-inbound/whatsapp", {
    method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": await signature(appSecret, body) }, body,
  }, f.env as never);
}

async function scopedKeys() {
  const providerRouteKey = await opaqueExternalSubject(platformSecret, ["whatsapp-platform-destination", "meta", phoneNumberId]);
  const senderKey = await opaqueExternalSubject(platformSecret, ["whatsapp-member-sender", providerRouteKey, senderId]);
  return { providerRouteKey, senderKey };
}

async function seedMemberContact(f: ReturnType<typeof fixture>, status = "active") {
  const { providerRouteKey, senderKey } = await scopedKeys();
  f.db.db.prepare(`INSERT INTO assistant_channel_member_contacts
    (contact_id,tenant_id,space_id,user_id,channel,provider_route_key,sender_key,status,verified_at,created_at,updated_at)
    VALUES('contact-a',?,?,?,?,?,?,?,datetime('now'),datetime('now'),datetime('now'))`)
    .run(tenantId, spaceId, userId, "whatsapp", providerRouteKey, senderKey, status);
  return { providerRouteKey, senderKey };
}

async function seedChallenge(f: ReturnType<typeof fixture>, expiresAt = new Date(Date.now() + 5 * 60_000).toISOString()) {
  const { providerRouteKey, senderKey } = await seedMemberContact(f);
  const challengeHash = await opaqueSha256(challengeCode);
  f.db.db.prepare(`INSERT INTO assistant_channel_member_customer_test_challenges
    (challenge_hash,test_session_id,tenant_id,space_id,user_id,channel,provider_route_key,sender_key,contact_id,
      project_id,installation_id,package_version,handler_sha256,created_at,expires_at)
    VALUES(?, 'test-session-a', ?, ?, ?, 'whatsapp', ?, ?, 'contact-a', ?, ?, ?, ?, ?, ?)`)
    .run(challengeHash, tenantId, spaceId, userId, providerRouteKey, senderKey, projectId, installationId,
      packageVersion, handlerHash, new Date().toISOString(), expiresAt);
  return { challengeHash, providerRouteKey, senderKey };
}

async function seedActiveSession(f: ReturnType<typeof fixture>, options: { expiresAt?: string; contactStatus?: string } = {}) {
  const { providerRouteKey, senderKey } = await seedMemberContact(f, options.contactStatus ?? "active");
  f.db.db.prepare(`INSERT INTO assistant_channel_member_customer_test_sessions
    (test_session_id,tenant_id,space_id,user_id,channel,provider_route_key,sender_key,contact_id,project_id,
      installation_id,package_version,handler_sha256,status,started_at,expires_at,updated_at,started_event_key)
    VALUES('test-session-a', ?, ?, ?, 'whatsapp', ?, ?, 'contact-a', ?, ?, ?, ?, 'active', ?, ?, ?, 'start-event')`)
    .run(tenantId, spaceId, userId, providerRouteKey, senderKey, projectId, installationId, packageVersion,
      handlerHash, new Date(Date.now() - 60_000).toISOString(), options.expiresAt ?? new Date(Date.now() + 30 * 60_000).toISOString(), new Date().toISOString());
  return { providerRouteKey, senderKey };
}

afterEach(() => vi.unstubAllGlobals());

describe("WhatsApp member customer phone test routing", () => {
  it("redeems a single-use code before pairing and deduplicates the provider retry", async () => {
    const f = fixture();
    const { challengeHash } = await seedChallenge(f);
    const first = await inbound(f, `TEST ${challengeCode}`);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, internal_customer_test: true, duplicate_event: false });
    expect(f.db.db.prepare(`SELECT status,started_event_key FROM assistant_channel_member_customer_test_sessions`).get())
      .toMatchObject({ status: "active", started_event_key: expect.any(String) });
    expect(f.db.db.prepare(`SELECT consumed_at FROM assistant_channel_member_customer_test_challenges WHERE challenge_hash=?`).get(challengeHash))
      .toMatchObject({ consumed_at: expect.any(String) });
    expect(f.agentFetch).not.toHaveBeenCalled();
    expect(f.queries.some(sql => sql.includes("FROM channel_pairings"))).toBe(false);
    expect(f.providerFetch).toHaveBeenCalledOnce();

    const retry = await inbound(f, `TEST ${challengeCode}`);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ ok: true, internal_customer_test: true, duplicate_event: true });
    expect(f.db.db.prepare(`SELECT COUNT(*) AS count FROM assistant_channel_member_customer_test_sessions`).get())
      .toMatchObject({ count: 1 });
    expect(f.agentFetch).not.toHaveBeenCalled();
    expect(f.providerFetch).toHaveBeenCalledOnce();
    expect(f.queries.some(sql => sql.includes("FROM channel_pairings"))).toBe(false);
  });

  it("rejects an expired entry code without activating a session or falling through to pairing", async () => {
    const f = fixture();
    const { challengeHash } = await seedChallenge(f, new Date(Date.now() - 1_000).toISOString());
    const response = await inbound(f, `TEST ${challengeCode}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ internal_customer_test: true });
    expect(f.db.db.prepare(`SELECT COUNT(*) AS count FROM assistant_channel_member_customer_test_sessions`).get())
      .toMatchObject({ count: 0 });
    expect(f.db.db.prepare(`SELECT consumed_at FROM assistant_channel_member_customer_test_challenges WHERE challenge_hash=?`).get(challengeHash))
      .toMatchObject({ consumed_at: null });
    expect(f.queries.some(sql => sql.includes("FROM channel_pairings"))).toBe(false);
    expect(f.agentFetch).not.toHaveBeenCalled();
  });

  it("forwards active test turns only to the pinned handler with executive routing disabled", async () => {
    const f = fixture();
    await seedActiveSession(f);
    const executiveLookingText = `ad_${"f".repeat(48)}`;
    const response = await inbound(f, executiveLookingText, "wamid-phone-test-active");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, internal_customer_test: true });
    expect(f.agentRequests).toHaveLength(1);
    expect(f.agentRequests[0]).toMatchObject({ path: "/channels/whatsapp/inbound", body: {
      raw: expect.any(Object), projectId, spaceId, tenantId, taskId: "wamid-phone-test-active",
      extensionInstanceId: installationId, extensionScriptSha256: handlerHash,
      customerTestSessionId: "test-session-a", customerTestProviderRouteKey: expect.any(String),
      allowExecutiveRouting: false,
    } });
    expect(f.db.db.prepare(`SELECT COUNT(*) AS count FROM assistant_channel_member_customer_test_events`).get())
      .toMatchObject({ count: 1 });
    expect(f.queries.some(sql => sql.includes("FROM channel_pairings"))).toBe(false);
  });

  it("ends active tests on expiry or changed contact authority before dispatch", async () => {
    for (const scenario of ["expired", "revoked"] as const) {
      const f = fixture();
      await seedActiveSession(f, scenario === "expired"
        ? { expiresAt: new Date(Date.now() - 1_000).toISOString() }
        : { contactStatus: "revoked" });
      const response = await inbound(f, "hello", `wamid-phone-test-${scenario}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, internal_customer_test: true });
      expect(f.agentFetch).not.toHaveBeenCalled();
      expect(f.queries.some(sql => sql.includes("FROM channel_pairings"))).toBe(false);
      expect(f.db.db.prepare(`SELECT status,ended_reason FROM assistant_channel_member_customer_test_sessions`).get())
        .toMatchObject({ status: scenario === "expired" ? "expired" : "revoked",
          ended_reason: scenario === "expired" ? "expired" : "access_changed" });
    }
  });

  it("handles explicit exit before routing and makes an exit retry idempotent", async () => {
    const f = fixture();
    await seedActiveSession(f);
    const eventId = "wamid-phone-test-exit";
    const exit = await inbound(f, "TEST EXIT", eventId);
    expect(exit.status).toBe(200);
    expect(await exit.json()).toMatchObject({ ok: true, internal_customer_test: true, duplicate_event: false });
    expect(f.db.db.prepare(`SELECT status,ended_reason,ended_event_key FROM assistant_channel_member_customer_test_sessions`).get())
      .toMatchObject({ status: "exited", ended_reason: "member_exit", ended_event_key: expect.any(String) });

    const retry = await inbound(f, "TEST EXIT", eventId);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ ok: true, internal_customer_test: true, duplicate_event: true });
    expect(f.providerFetch).toHaveBeenCalledOnce();
    expect(f.agentFetch).not.toHaveBeenCalled();
    expect(f.queries.some(sql => sql.includes("FROM channel_pairings"))).toBe(false);
  });
});
