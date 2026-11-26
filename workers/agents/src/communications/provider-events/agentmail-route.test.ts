import { describe, expect, it, vi } from "vitest";
import { ensureIdentity, sealCommunication } from "../core.js";
import { receiveAgentMailWebhook } from "../agentmail.js";
import { fixture, enableProviderEventModuleFixture, scope } from "../../../../../tests/fixtures/assistant-communications.js";

// MS-49: the AgentMail webhook route calls ingestProviderEvent when PROVIDER_EVENT_MODULE_ENABLED is on; provider-facing statuses are unchanged.
const b64 = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const SECRET = "whsec_dGVzdA==";
async function svix(raw: string, id = "msg_1") {
  const ts = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey("raw", Uint8Array.from(atob("dGVzdA=="), c => c.charCodeAt(0)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return { "svix-id": id, "svix-timestamp": ts, "svix-signature": `v1,${b64(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${ts}.${raw}`)))}` };
}
const good = { event_type: "message.received", event_id: "evt-1", message: { message_id: "m1", thread_id: "t1", inbox_id: "inbox-1", text: "private mail body" } };

async function harness(flag: boolean) {
  const f = fixture(); if (flag) enableProviderEventModuleFixture(f.db, f.env); else (f.env as unknown as { PROVIDER_EVENT_MODULE_ENABLED: string }).PROVIDER_EVENT_MODULE_ENABLED = "false";
  f.db.db.exec(`CREATE TABLE IF NOT EXISTS agentport_account_grants (id TEXT PRIMARY KEY, tenant_id TEXT, account_id TEXT, agent_id TEXT, granted_by TEXT, permissions_json TEXT, expires_at TEXT, status TEXT, created_at TEXT, updated_at TEXT)`);
  const identity = await ensureIdentity(f.env, scope);
  const sealed = await sealCommunication(f.env, identity, "acct-1", { secret: SECRET });
  f.db.db.prepare(`INSERT INTO assistant_agentmail_accounts(id,tenant_id,space_id,assistant_identity_id,agentport_agent_id,agentport_account_id,owner_user_id,mode,inbox_id,email_address,
    agentmail_webhook_secret_ciphertext,agentmail_webhook_secret_iv,status,created_at,updated_at) VALUES('acct-1',?,?,?,'agent-a','ap_account','user','user_connected','inbox-1','a@example.test',?,?,'active','t','t')`)
    .run(identity.tenant_id, identity.space_id, identity.id, sealed.ciphertext, sealed.iv);
  const handoffs: Array<Record<string, unknown>> = [];
  (f.env.AGENTPORT_WORKER as unknown as { fetch: unknown }).fetch = vi.fn(async (r: Request) => { handoffs.push(await r.clone().json() as Record<string, unknown>); return Response.json({}, { status: 202 }); });
  const post = async (event: object | string, tamper = false) => {
    const raw = typeof event === "string" ? event : JSON.stringify(event);
    return receiveAgentMailWebhook(f.env, "acct-1", new Request("http://x/internal/agentmail/webhook/acct-1", { method: "POST", body: tamper ? raw + " " : raw, headers: await svix(raw) }));
  };
  const rows = async (sql: string) => (await f.db.prepare(sql).all<Record<string, unknown>>()).results;
  return { f, post, handoffs, rows, identity };
}

describe("AgentMail webhook route through the provider event module (MS-49)", () => {
  for (const flag of [false, true]) {
    it(`flag ${flag ? "on" : "off"}: statuses 401 / bad JSON 400 / ignored type 204 / missing reference 400 / foreign inbox 400 / delivery 204 / replay 204`, async () => {
      const h = await harness(flag);
      expect((await h.post(good, true)).status).toBe(401);
      expect((await h.post("{not json")).status).toBe(400);
      expect((await h.post({ event_type: "message.read", event_id: "x" })).status).toBe(204);
      const missing = await h.post({ ...good, message: { inbox_id: "inbox-1", message_id: "m1" } });
      expect(missing.status).toBe(400); expect(await missing.json()).toEqual({ error_code: "webhook_reference_invalid" });
      expect((await h.post({ ...good, message: { ...good.message, inbox_id: "other" } })).status).toBe(400);
      expect((await h.post(good)).status).toBe(204);
      expect((await h.post(good)).status).toBe(204);
      expect(h.handoffs).toHaveLength(1);
      expect(await h.rows("SELECT status FROM assistant_agentmail_event_receipts")).toEqual([{ status: "queued" }]);
      if (flag) {
        expect((await h.rows("SELECT reason FROM provider_event_dead_letters ORDER BY reason")).map(r => r.reason)).toEqual(["event_reference_invalid", "unknown_resource"]);
        expect(await h.rows("SELECT provider,event_id FROM processed_webhook_events")).toEqual([{ provider: "agentmail", event_id: "evt-1" }]);
      }
    });
  }

  it("flag on: the hand-off carries references only (event, thread and message ids), never the mail body", async () => {
    const h = await harness(true);
    await h.post(good);
    expect(h.handoffs[0]).toMatchObject({ providerEventId: "evt-1", eventType: "message.received", threadRef: "t1", dataRef: "m1", accountId: "ap_account" });
    expect(JSON.stringify(h.handoffs[0])).not.toContain("private mail body");
  });

  it("flag on: an event already in processed_webhook_events is a duplicate before any side effect (no receipt, no hand-off)", async () => {
    const h = await harness(true);
    await h.f.db.prepare("INSERT INTO processed_webhook_events(provider,event_id,event_type) VALUES('agentmail','evt-1','message.received')").run();
    expect((await h.post(good)).status).toBe(204);
    expect(h.handoffs).toHaveLength(0);
    expect(await h.rows("SELECT * FROM assistant_agentmail_event_receipts")).toEqual([]);
  });

  it("flag on: a revoked or expired grant is acknowledged with 204 and nothing is handed off or claimed; an active one is delivered", async () => {
    const h = await harness(true);
    const grant = (status: string, expires: string | null) => h.f.db.db.prepare("INSERT OR REPLACE INTO agentport_account_grants VALUES('g',?,?,?,?,?,?,?,'t','t')")
      .run(h.identity.tenant_id, "ap_account", "agent-a", "u", "[]", expires, status);
    grant("revoked", null);
    expect((await h.post(good)).status).toBe(204);
    grant("active", "2000-01-01T00:00:00.000Z");
    expect((await h.post(good)).status).toBe(204);
    expect(h.handoffs).toHaveLength(0);
    expect(await h.rows("SELECT * FROM processed_webhook_events")).toEqual([]);
    expect(await h.rows("SELECT * FROM assistant_agentmail_event_receipts")).toEqual([]);
    grant("active", null);
    expect((await h.post(good)).status).toBe(204);
    expect(h.handoffs).toHaveLength(1);
  });

  it("flag on: a failed hand-off (thrown or non-delivery status) keeps its legacy outcome and releases the claim; the retry succeeds", async () => {
    const h = await harness(true);
    const ok = (h.f.env.AGENTPORT_WORKER as unknown as { fetch: unknown }).fetch;
    (h.f.env.AGENTPORT_WORKER as unknown as { fetch: unknown }).fetch = vi.fn(async () => Response.json({}, { status: 201 }));
    const failed = await h.post(good);
    expect(failed.status).toBe(503); expect(await failed.json()).toEqual({ error_code: "agentport_event_ingest_failed" });
    expect(await h.rows("SELECT * FROM processed_webhook_events")).toEqual([]);
    (h.f.env.AGENTPORT_WORKER as unknown as { fetch: unknown }).fetch = ok;
    expect((await h.post(good)).status).toBe(204);
  });
});
