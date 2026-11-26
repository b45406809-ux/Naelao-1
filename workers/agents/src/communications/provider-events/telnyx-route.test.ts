import { readFileSync } from "node:fs";
import { generateKeyPairSync, sign } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AgentsEnv } from "../../index.js";
import { ensureIdentity } from "../core.js";
import { defaultPhonePolicy } from "../phones.js";
import { registerTelnyxWebhook } from "../telnyx-webhook.js";
import { fixture, enableProviderEventModuleFixture, scope } from "../../../../../tests/fixtures/assistant-communications.js";

// MS-49: the Telnyx managed route calls ingestProviderEvent when PROVIDER_EVENT_MODULE_ENABLED is on. Status codes match the flag-off route.
async function harness(flag: boolean, bindingStatus = "active") {
  const f = fixture(); if (flag) enableProviderEventModuleFixture(f.db, f.env); else (f.env as unknown as { PROVIDER_EVENT_MODULE_ENABLED: string }).PROVIDER_EVENT_MODULE_ENABLED = "false";
  f.db.db.exec(readFileSync(new URL("../../../../../infra/migrations/0137_telnyx_ingress_receipts.sql", import.meta.url), "utf8"));
  f.fetch.mockImplementation(async (r: Request) => r.url.includes("assistant-access") ? Response.json({ effective_role: "owner" }) : Response.json({ preferences: { enabled: { phone: true, email: true } } }));
  const identity = await ensureIdentity(f.env, scope);
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
  const reserve = vi.fn(async () => Response.json({ reserved: true }));
  Object.assign(f.env, { TELNYX_MANAGED_API_KEY: "k".repeat(24), TELNYX_MANAGED_PUBLIC_KEY: publicKey, BILLING_WORKER: { fetch: reserve } });
  await f.db.prepare(`INSERT INTO assistant_phone_bindings(id,identity_id,purpose,payer,provider,provider_account_sid,provider_number_sid,phone_number,policy_json,status,
    managed_price_version,managed_rental_credits_per_month,managed_sms_credits_per_segment,managed_call_credits_per_minute)
    VALUES('binding-1',?,'assistant','managed','telnyx','account','12345','+14155550100',?, ?,'v1',100,10,20)`)
    .bind(identity.id, JSON.stringify(defaultPhonePolicy), bindingStatus).run();
  const app = new Hono<{ Bindings: AgentsEnv }>(); registerTelnyxWebhook(app);
  const event = (id: string, to = "+14155550100") => JSON.stringify({ data: { id, event_type: "message.received", occurred_at: "2026-01-01T00:00:00Z",
    payload: { id: `msg-${id}`, direction: "inbound", from: { phone_number: "+14155550101" }, to: [{ phone_number: to }], text: "hello", media: [] } } });
  const post = (raw: string, forge = false) => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign(null, Buffer.from(`${timestamp}|${raw}`), keys.privateKey).toString("base64");
    return app.request("http://example/assistant-phone/telnyx-managed", { method: "POST", headers: { "telnyx-signature-ed25519": signature, "telnyx-timestamp": timestamp }, body: forge ? raw + " " : raw }, f.env);
  };
  // A table the flag-off fixture never creates counts as zero.
  const count = async (sql: string) => { try { return (await f.db.prepare(sql).first<{ n: number }>())!.n; } catch { return 0; } };
  return { f, post, event, reserve, count };
}

describe("Telnyx managed route through the provider event module (MS-49)", () => {
  for (const flag of [false, true]) {
    it(`flag ${flag ? "on" : "off"}: forged 401, unknown number 404, delivery 200, replay 200 duplicate, one carrier reservation`, async () => {
      const h = await harness(flag);
      expect((await h.post(h.event("ev-1"), true)).status).toBe(401);
      const unknown = await h.post(h.event("ev-0", "+14155550199"));
      expect(unknown.status).toBe(404); expect(await unknown.json()).toEqual({ error_code: "unsupported_message" });
      const first = await h.post(h.event("ev-1"));
      expect(first.status).toBe(200); expect(await first.json()).toEqual({ accepted: true });
      const replay = await h.post(h.event("ev-1"));
      expect(replay.status).toBe(200); expect(await replay.json()).toEqual({ accepted: true, duplicate: true });
      expect(h.reserve).toHaveBeenCalledTimes(1);
      expect(await h.count("SELECT COUNT(*) n FROM assistant_telnyx_ingress_receipts")).toBe(1);
      expect(await h.count("SELECT COUNT(*) n FROM processed_webhook_events WHERE provider='telnyx'")).toBe(flag ? 1 : 0);
      expect(await h.count("SELECT COUNT(*) n FROM provider_event_dead_letters")).toBe(flag ? 1 : 0);
    });
  }

  it("flag on: an event already in processed_webhook_events is a duplicate before any side effect (no reservation, no journal row)", async () => {
    const h = await harness(true);
    await h.f.db.prepare("INSERT INTO processed_webhook_events(provider,event_id,event_type) VALUES('telnyx','ev-7','message.received')").run();
    const response = await h.post(h.event("ev-7"));
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ accepted: true, duplicate: true });
    expect(h.reserve).not.toHaveBeenCalled();
    expect(await h.count("SELECT COUNT(*) n FROM assistant_telnyx_ingress_receipts")).toBe(0);
  });

  it("flag on: a revoked line answers 404 like an unknown one, wakes nothing, and is dead-lettered", async () => {
    const h = await harness(true, "revoked");
    const response = await h.post(h.event("ev-2"));
    expect(response.status).toBe(404); expect(await response.json()).toEqual({ error_code: "unsupported_message" });
    expect(h.reserve).not.toHaveBeenCalled();
    expect(await h.count("SELECT COUNT(*) n FROM assistant_telnyx_ingress_receipts")).toBe(0);
    expect((await h.f.db.prepare("SELECT reason FROM provider_event_dead_letters").first<{ reason: string }>())?.reason).toBe("unknown_resource");
  });

  for (const flag of [false, true]) {
    it(`flag ${flag ? "on" : "off"}: a failed side effect answers 503 and the retry meets the journal (409), as before; the module claim is released`, async () => {
      const h = await harness(flag);
      h.reserve.mockImplementation(async () => Response.json({ error: "down" }, { status: 500 }));
      const failed = await h.post(h.event("ev-3"));
      expect(failed.status).toBe(503);
      expect(await h.count("SELECT COUNT(*) n FROM processed_webhook_events WHERE provider='telnyx'")).toBe(0);
      expect((await h.post(h.event("ev-3"))).status).toBe(409);
      expect(await h.count("SELECT COUNT(*) n FROM processed_webhook_events WHERE provider='telnyx'")).toBe(0);
    });
  }
});
