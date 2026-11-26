import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AgentsEnv } from "../../index.js";
import { registerTelnyxWebhook } from "../telnyx-webhook.js";
import { dispatchAgentPortProviderEvent } from "../../channels/agentport-provider-event-dispatch.js";
import type { ProviderEventReferenceQueueMessage } from "../../channels/session-queue.js";
import { ensureIdentity, sealCommunication } from "../core.js";
import { receiveAgentMailWebhook } from "../agentmail.js";
import { fixture, enableProviderEventModuleFixture, scope } from "../../../../../tests/fixtures/assistant-communications.js";
import { agentGrantIsActive, agentMailProviderEventAdapter, ingestProviderEvent, metaProviderEventAdapter, telnyxProviderEventAdapter, providerEventModuleEnabled } from "./index.js";
import type { ProviderEventAdapter } from "./index.js";

const b64 = (bytes: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
async function hmacHex(secret: string, text: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text)))].map(x => x.toString(16).padStart(2, "0")).join("");
}
const SVIX_SECRET = "whsec_dGVzdA==";
async function svixHeaders(raw: string, id = "msg_1", timestamp = String(Math.floor(Date.now() / 1000))) {
  const key = await crypto.subtle.importKey("raw", Uint8Array.from(atob("dGVzdA=="), c => c.charCodeAt(0)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = b64(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${raw}`)));
  return { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${sig}` };
}
async function telnyxSigned(body: object, tsOffset = 0) {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const raw = JSON.stringify(body), timestamp = String(Math.floor(Date.now() / 1000) + tsOffset);
  const signature = b64(await crypto.subtle.sign("Ed25519", pair.privateKey, new TextEncoder().encode(`${timestamp}|${raw}`)));
  return { raw, publicKey: b64(await crypto.subtle.exportKey("raw", pair.publicKey)), headers: { "telnyx-signature-ed25519": signature, "telnyx-timestamp": timestamp } };
}
const telnyxBody = { data: { id: "ev-1", event_type: "message.received", occurred_at: "2026-01-01T00:00:00Z",
  payload: { id: "msg-1", to: [{ phone_number: "+15550001111" }], from: { phone_number: "+15559998888" }, text: "private body" } } };

describe("provider verifiers move into the module (MR-EVT-1, MR-EVT-6)", () => {
  it("Telnyx: accepts a signed event, rejects forged, wrong-key and stale timestamps, and normalizes references only", async () => {
    const good = await telnyxSigned(telnyxBody);
    expect(await telnyxProviderEventAdapter.verifyWebhook({ rawBody: good.raw, headers: good.headers, secret: good.publicKey })).toBe(true);
    expect(await telnyxProviderEventAdapter.verifyWebhook({ rawBody: good.raw.replace("msg-1", "msg-2"), headers: good.headers, secret: good.publicKey })).toBe(false);
    const other = await telnyxSigned(telnyxBody);
    expect(await telnyxProviderEventAdapter.verifyWebhook({ rawBody: good.raw, headers: good.headers, secret: other.publicKey })).toBe(false);
    const stale = await telnyxSigned(telnyxBody, -1000);
    expect(await telnyxProviderEventAdapter.verifyWebhook({ rawBody: stale.raw, headers: stale.headers, secret: stale.publicKey })).toBe(false);
    const event = await telnyxProviderEventAdapter.normalizeWebhook(good.raw);
    expect(event).toMatchObject({ eventId: "ev-1", eventType: "message.received", resourceRef: "+15550001111", data: { message_id: "msg-1" } });
    expect(JSON.stringify(event)).not.toContain("private body");
  });

  it("Meta: verifies x-hub-signature-256, rejects forged and replayed (old) messages, and normalizes references only", async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const raw = JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: "pn-1" }, messages: [{ id: "wamid.1", from: "15550", timestamp: ts, type: "text", text: { body: "secret text" } }] } }] }] });
    const headers = { "x-hub-signature-256": `sha256=${await hmacHex("app-secret", raw)}` };
    expect(await metaProviderEventAdapter.verifyWebhook({ rawBody: raw, headers, secret: "app-secret" })).toBe(true);
    expect(await metaProviderEventAdapter.verifyWebhook({ rawBody: raw, headers, secret: "wrong" })).toBe(false);
    expect(await metaProviderEventAdapter.verifyWebhook({ rawBody: raw, headers: {}, secret: "app-secret" })).toBe(false);
    const old = raw.replace(ts, String(Number(ts) - 1000));
    expect(await metaProviderEventAdapter.verifyWebhook({ rawBody: old, headers: { "x-hub-signature-256": `sha256=${await hmacHex("app-secret", old)}` }, secret: "app-secret" })).toBe(false);
    const event = await metaProviderEventAdapter.normalizeWebhook(raw);
    expect(event).toMatchObject({ eventId: "wamid.1", resourceRef: "pn-1", data: { message_id: "wamid.1", message_type: "text" } });
    expect(JSON.stringify(event)).not.toContain("secret text");
    expect(await metaProviderEventAdapter.normalizeWebhook(JSON.stringify({ entry: [{ changes: [{ value: { statuses: [] } }] }] }))).toBeNull();
  });

  it("AgentMail: verifies svix, rejects forged and stale, and normalizes references only", async () => {
    const raw = JSON.stringify({ event_type: "message.received", event_id: "evt-1", message: { message_id: "m1", thread_id: "t1", inbox_id: "inbox-1", text: "mail body" } });
    const headers = await svixHeaders(raw);
    expect(await agentMailProviderEventAdapter.verifyWebhook({ rawBody: raw, headers, secret: SVIX_SECRET })).toBe(true);
    expect(await agentMailProviderEventAdapter.verifyWebhook({ rawBody: raw + " ", headers, secret: SVIX_SECRET })).toBe(false);
    expect(await agentMailProviderEventAdapter.verifyWebhook({ rawBody: raw, headers: await svixHeaders(raw, "msg_1", String(Math.floor(Date.now() / 1000) - 1000)), secret: SVIX_SECRET })).toBe(false);
    const event = await agentMailProviderEventAdapter.normalizeWebhook(raw);
    expect(event).toMatchObject({ eventId: "evt-1", resourceRef: "inbox-1", data: { message_id: "m1", thread_id: "t1" } });
    expect(JSON.stringify(event)).not.toContain("mail body");
  });
});

function addAccount(f: ReturnType<typeof fixture>, id: string, tenant: string, ref: string, state = "active") {
  f.db.db.prepare(`INSERT INTO managed_service_accounts(id,tenant_id,space_id,provider,service_id,connection_mode,provider_resource_ref,owner_type,owner_id,provider_payer_type,lifecycle_state,created_at,updated_at)
    VALUES(?,?,'space','agentmail','agentmail','naelao_managed',?,'user','user','user',?,'t','t')`).run(id, tenant, ref, state);
}

describe("ingestProviderEvent gateway (MR-EVT-1..4)", () => {
  const raw = JSON.stringify({ event_type: "message.received", event_id: "evt-1", message: { message_id: "m1", thread_id: "t1", inbox_id: "inbox-1" } });
  async function run(f: ReturnType<typeof fixture>, deliver: (e: unknown) => Promise<void>, body = raw, headers?: Record<string, string>) {
    return ingestProviderEvent(f.env, agentMailProviderEventAdapter, { rawBody: body, headers: headers ?? await svixHeaders(body), secret: SVIX_SECRET, deliver: async e => deliver(e) });
  }
  function harness() { const f = fixture(); enableProviderEventModuleFixture(f.db, f.env); return f; }

  it("rejects a forged event with 401 before parsing, delivery or any write", async () => {
    const f = harness(); addAccount(f, "res-1", "tenant", "inbox-1");
    const deliver = vi.fn(async () => undefined);
    const result = await run(f, deliver, raw, { ...(await svixHeaders(raw)), "svix-signature": "v1,AAAA" });
    expect(result).toMatchObject({ outcome: "unauthorized", status: 401 });
    expect(deliver).not.toHaveBeenCalled();
    expect((await f.db.prepare("SELECT COUNT(*) n FROM processed_webhook_events").first<{ n: number }>())?.n).toBe(0);
    expect((await f.db.prepare("SELECT COUNT(*) n FROM provider_event_dead_letters").first<{ n: number }>())?.n).toBe(0);
  });

  it("resolves the tenant from provider_resource_ref and delivers a references-only canonical envelope", async () => {
    const f = harness(); addAccount(f, "res-1", "tenant-x", "inbox-1");
    const deliver = vi.fn(async (_e: unknown) => undefined);
    const result = await run(f, deliver);
    expect(result).toMatchObject({ outcome: "delivered", status: 204 });
    expect(deliver.mock.calls[0]![0]).toEqual({ id: "evt-1", type: "message.received", version: 1, tenant_id: "tenant-x", resource_id: "res-1", provider: "agentmail",
      occurred_at: expect.any(String), data: { message_id: "m1", thread_id: "t1" } });
  });

  it("rejects a replayed event: the second delivery of the same id is a duplicate and has no side effect", async () => {
    const f = harness(); addAccount(f, "res-1", "tenant", "inbox-1");
    const deliver = vi.fn(async () => undefined);
    expect((await run(f, deliver)).outcome).toBe("delivered");
    expect((await run(f, deliver)).outcome).toBe("duplicate");
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("releases the dedup claim when delivery fails so the provider retry is processed", async () => {
    const f = harness(); addAccount(f, "res-1", "tenant", "inbox-1");
    expect((await run(f, async () => { throw new Error("down"); })).outcome).toBe("failed");
    const deliver = vi.fn(async () => undefined);
    expect((await run(f, deliver)).outcome).toBe("delivered");
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("dead-letters an unknown resource, an ambiguous resource and a retired resource, never guessing, without storing the body", async () => {
    const f = harness(); const deliver = vi.fn(async () => undefined);
    expect(await run(f, deliver)).toMatchObject({ outcome: "dead_lettered", status: 202 });
    addAccount(f, "res-a", "tenant-a", "inbox-1"); addAccount(f, "res-b", "tenant-b", "inbox-1");
    expect((await run(f, deliver)).outcome).toBe("dead_lettered");
    const g = harness(); addAccount(g, "res-r", "tenant", "inbox-1", "retired");
    expect((await run(g, deliver)).outcome).toBe("dead_lettered");
    expect(deliver).not.toHaveBeenCalled();
    const rows = await f.db.prepare("SELECT provider,event_id,reason,resource_ref,body_sha256 FROM provider_event_dead_letters").all<Record<string, string>>();
    expect(rows.results[0]).toMatchObject({ provider: "agentmail", event_id: "evt-1", reason: "unknown_resource", resource_ref: "inbox-1" });
    expect(rows.results[0]!.body_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(rows.results)).not.toContain("thread_id");
  });

  it("falls back to a body hash when an adapter supplies no event id (MR-EVT-2)", async () => {
    const f = harness(); addAccount(f, "res-1", "tenant", "inbox-1");
    const adapter: ProviderEventAdapter = { provider: "agentmail", verifyWebhook: async () => true,
      normalizeWebhook: async () => ({ eventId: "", eventType: "x.y", occurredAt: "t", resourceRef: "inbox-1", data: {} }) };
    const deliver = vi.fn(async () => undefined);
    await ingestProviderEvent(f.env, adapter, { rawBody: "{}", headers: {}, secret: "s", deliver });
    expect(deliver.mock.calls.length).toBe(1);
    expect((await f.db.prepare("SELECT event_id FROM processed_webhook_events").first<{ event_id: string }>())?.event_id).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("grant re-check before a wake (MR-EVT-5)", () => {
  const event: ProviderEventReferenceQueueMessage = { type: "provider_event_reference", tenantId: "tenant", spaceId: "space", agentId: "agent-a", connectionId: "c",
    accountId: "acct-1", subscriptionId: "s", eventId: "e", deliveryId: "d", serviceId: "agentmail:tenant", eventType: "message.received", threadRef: "t", dataRef: "m" };
  const deps = (grantActive: (e: ProviderEventReferenceQueueMessage) => Promise<boolean>) => ({
    grantActive,
    currentSubscription: vi.fn(async () => ({ subscriptionId: "s", agentId: "agent-a", accountId: "acct-1", serviceId: "agentmail:tenant", status: "active" })),
    resolveAssistant: vi.fn(async () => ({ assistantId: "naelao-agent", wakeEnabled: true, routeRevision: 0 })), persistAssistant: vi.fn(async () => "naelao-agent"),
    stableSessionId: vi.fn(async () => "sess"), persistSessionId: vi.fn(async () => undefined), ensureSession: vi.fn(async () => undefined),
    appendReference: vi.fn(async () => undefined), wake: vi.fn(async () => true), markAccepted: vi.fn(async () => undefined), markFailed: vi.fn(async () => undefined),
  });

  it("a revoked grant stops the wake and the session work, and the delivery is acknowledged", async () => {
    const d = deps(async () => false);
    await dispatchAgentPortProviderEvent(event, d);
    expect(d.wake).not.toHaveBeenCalled(); expect(d.ensureSession).not.toHaveBeenCalled(); expect(d.markAccepted).toHaveBeenCalledOnce();
  });
  it("a grant revoked between preparation and the wake still stops it", async () => {
    let calls = 0; const d = deps(async () => ++calls < 2);
    await dispatchAgentPortProviderEvent(event, d);
    expect(d.appendReference).toHaveBeenCalled(); expect(d.wake).not.toHaveBeenCalled(); expect(d.markAccepted).toHaveBeenCalledOnce();
  });
  it("an active grant wakes as before, and no grant dependency keeps the previous behavior", async () => {
    const on = deps(async () => true); await dispatchAgentPortProviderEvent(event, on); expect(on.wake).toHaveBeenCalledOnce();
    const { grantActive: _omit, ...off } = deps(async () => false); await dispatchAgentPortProviderEvent(event, off); expect(off.wake).toHaveBeenCalledOnce();
  });
  it("agentGrantIsActive reads active, unexpired grants for this tenant, account and agent only", async () => {
    const f = fixture(); f.db.db.exec(`CREATE TABLE agentport_account_grants (id TEXT PRIMARY KEY, tenant_id TEXT, account_id TEXT, agent_id TEXT, granted_by TEXT, permissions_json TEXT, expires_at TEXT, status TEXT, created_at TEXT, updated_at TEXT)`);
    const ins = f.db.db.prepare("INSERT INTO agentport_account_grants VALUES(?,?,?,?,?,?,?,?,?,?)");
    ins.run("g1", "tenant", "acct-1", "agent-a", "u", "[]", null, "active", "t", "t");
    ins.run("g2", "tenant", "acct-1", "agent-b", "u", "[]", null, "revoked", "t", "t");
    ins.run("g3", "tenant", "acct-1", "agent-c", "u", "[]", "2000-01-01T00:00:00.000Z", "active", "t", "t");
    expect(await agentGrantIsActive(f.db as unknown as D1Database, "tenant", "acct-1", "agent-a")).toBe(true);
    expect(await agentGrantIsActive(f.db as unknown as D1Database, "tenant", "acct-1", "agent-b")).toBe(false);
    expect(await agentGrantIsActive(f.db as unknown as D1Database, "tenant", "acct-1", "agent-c")).toBe(false);
    expect(await agentGrantIsActive(f.db as unknown as D1Database, "other", "acct-1", "agent-a")).toBe(false);
  });
});

describe("AgentMail webhook route, flag off and on (identical responses)", () => {
  async function routeHarness(flag: boolean) {
    const f = fixture(); if (flag) enableProviderEventModuleFixture(f.db, f.env);
    const identity = await ensureIdentity(f.env, scope);
    const sealed = await sealCommunication(f.env, identity, "acct-1", { secret: SVIX_SECRET });
    f.db.db.prepare(`INSERT INTO assistant_agentmail_accounts(id,tenant_id,space_id,assistant_identity_id,agentport_agent_id,agentport_account_id,owner_user_id,mode,inbox_id,email_address,
      agentmail_webhook_secret_ciphertext,agentmail_webhook_secret_iv,status,created_at,updated_at) VALUES('acct-1',?,?,?,'agent-a','ap_account','user','user_connected','inbox-1','a@example.test',?,?,'active','t','t')`)
      .run(identity.tenant_id, identity.space_id, identity.id, sealed.ciphertext, sealed.iv);
    const post = async (event: object, tamper = false) => {
      const raw = JSON.stringify(event); const headers = await svixHeaders(raw);
      return receiveAgentMailWebhook(f.env, "acct-1", new Request("http://x/internal/agentmail/webhook/acct-1", { method: "POST", body: tamper ? raw + " " : raw, headers }));
    };
    return { f, post };
  }
  const good = { event_type: "message.received", event_id: "evt-1", message: { message_id: "m1", thread_id: "t1", inbox_id: "inbox-1" } };
  for (const flag of [false, true]) {
    it(`flag ${flag ? "on" : "off"}: forged 401, ignored type 204, bad reference 400, delivery 204, replay 204`, async () => {
      const { f, post } = await routeHarness(flag);
      expect((await post(good, true)).status).toBe(401);
      expect((await post({ event_type: "message.read", event_id: "x" })).status).toBe(204);
      expect((await post({ ...good, message: { ...good.message, inbox_id: "someone-else" } })).status).toBe(400);
      expect((await post(good)).status).toBe(204);
      expect((await post(good)).status).toBe(204);
      expect((await f.db.prepare("SELECT status FROM assistant_agentmail_event_receipts WHERE event_id='evt-1'").first<{ status: string }>())?.status).toBe("queued");
      const dead = flag ? (await f.db.prepare("SELECT reason,resource_ref FROM provider_event_dead_letters").all<Record<string, string>>()).results : [];
      if (flag) {
        expect(dead).toEqual([{ reason: "unknown_resource", resource_ref: "someone-else" }]);
        expect((await f.db.prepare("SELECT COUNT(*) n FROM processed_webhook_events WHERE provider='agentmail'").first<{ n: number }>())?.n).toBe(1);
      }
    });
  }
  it("flag on: a failed AgentPort hand-off (error or non-delivery status) releases the dedup record, and the retry succeeds", async () => {
    const { f, post } = await routeHarness(true);
    const original = f.env.AGENTPORT_WORKER.fetch;
    (f.env.AGENTPORT_WORKER as unknown as { fetch: unknown }).fetch = vi.fn(async () => Response.json({ error: "down" }, { status: 500 }));
    await expect(post(good)).rejects.toThrow("agentport_request_failed");
    expect((await f.db.prepare("SELECT COUNT(*) n FROM processed_webhook_events").first<{ n: number }>())?.n).toBe(0);
    (f.env.AGENTPORT_WORKER as unknown as { fetch: unknown }).fetch = vi.fn(async () => Response.json({}, { status: 201 }));
    expect((await post(good)).status).toBe(503);
    expect((await f.db.prepare("SELECT COUNT(*) n FROM processed_webhook_events").first<{ n: number }>())?.n).toBe(0);
    (f.env.AGENTPORT_WORKER as unknown as { fetch: unknown }).fetch = original;
    expect((await post(good)).status).toBe(204);
  });
  it("the module flag is read as exactly 'true'", () => {
    expect(providerEventModuleEnabled({})).toBe(false); expect(providerEventModuleEnabled({ PROVIDER_EVENT_MODULE_ENABLED: "false" })).toBe(false);
    expect(providerEventModuleEnabled({ PROVIDER_EVENT_MODULE_ENABLED: "true" })).toBe(true);
  });
});

describe("Telnyx managed webhook route, flag off and on", () => {
  for (const flag of [false, true]) {
    it(`flag ${flag ? "on" : "off"}: forged 401; a verified event for an unknown number answers 404 and is dead-lettered only when on`, async () => {
      const f = fixture(); if (flag) enableProviderEventModuleFixture(f.db, f.env);
      const signed = await telnyxSigned(telnyxBody);
      Object.assign(f.env, { TELNYX_MANAGED_API_KEY: "k".repeat(24), TELNYX_MANAGED_PUBLIC_KEY: signed.publicKey });
      const app = new Hono<{ Bindings: AgentsEnv }>(); registerTelnyxWebhook(app);
      const forged = await app.request("/assistant-phone/telnyx-managed", { method: "POST", body: signed.raw.replace("msg-1", "msg-9"), headers: signed.headers }, f.env);
      expect(forged.status).toBe(401);
      const response = await app.request("/assistant-phone/telnyx-managed", { method: "POST", body: signed.raw, headers: signed.headers }, f.env);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error_code: "unsupported_message" });
      if (flag) {
        const rows = await f.db.prepare("SELECT provider,event_id,reason,resource_ref FROM provider_event_dead_letters").all<Record<string, string>>();
        expect(rows.results).toEqual([{ provider: "telnyx", event_id: "ev-1", reason: "unknown_resource", resource_ref: "+15550001111" }]);
      }
    });
  }
});
