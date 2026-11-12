import { afterEach, describe, expect, it, vi } from "vitest";
import { fixture, scope } from "../../../../tests/fixtures/assistant-communications.js";
import { ensureIdentity, storeBody } from "./core.js";
import { defaultPhonePolicy } from "./phones.js";
import { sweepTelnyxSmsCosts } from "./telnyx-cost-poller.js";
import { sweepManagedTelnyxInboundSmsCosts } from "./managed-carrier-billing.js";

afterEach(() => vi.unstubAllGlobals());
describe("Telnyx cost collection", () => {
  it("collects finalized costs once under concurrent scheduled sweeps", async () => {
    const f = fixture();
    f.fetch.mockImplementation(async (r: Request) => r.url.includes("assistant-access") ? Response.json({ effective_role: "owner" }) : Response.json({ preferences: { enabled: { phone: true, email: true } } }));
    const identity = await ensureIdentity(f.env, scope);
    f.env.CREDENTIALS_WORKER = { fetch: vi.fn(async () => Response.json({ value: JSON.stringify({ apiKey: "test-api-key-123456", publicKey: btoa("x".repeat(32)), verifiedNumberId: "12345", verifiedPhoneNumber: "+14155550100" }) })) } as unknown as Fetcher;
    await f.db.prepare("INSERT INTO assistant_phone_bindings(id,identity_id,purpose,payer,provider,provider_account_sid,provider_number_sid,phone_number,policy_json,status) VALUES(?,?,'assistant','byo','telnyx','account','12345','+14155550100',?,'active')").bind("binding-1", identity.id, JSON.stringify(defaultPhonePolicy)).run();
    const key = await storeBody(f.env, identity, "action-1", { text: "Hello" });
    await f.db.prepare("INSERT INTO assistant_phone_actions(id,binding_id,actor_id,kind,recipient,body_key,status,provider_sid) VALUES('action-1','binding-1','user','sms','+14155550101',?,'sent','message-1')").bind(key).run();
    const provider = vi.fn(async () => Response.json({ data: { id: "message-1", direction: "outbound", from: { phone_number: "+14155550100" }, to: [{ phone_number: "+14155550101" }], text: "Hello", cost: { amount: "0.0045", currency: "USD" }, completed_at: "2026-10-27T12:00:00Z" } }));
    vi.stubGlobal("fetch", provider);
    await Promise.all(Array.from({ length: 8 }, () => sweepTelnyxSmsCosts(f.env)));
    expect(provider).toHaveBeenCalledTimes(1);
    expect(await f.db.prepare("SELECT status,attempts FROM assistant_telnyx_cost_polls WHERE action_id='action-1'").first()).toMatchObject({ status: "observed", attempts: 1 });
    expect((await f.db.prepare("SELECT count(*) AS n FROM assistant_telnyx_usage_receipts").first<{ n: number }>())?.n).toBe(1);
  });

  it("records managed inbound message cost provenance as well as settling customer credits", async () => {
    const f = fixture();
    const identity = await ensureIdentity(f.env, scope);
    f.env.TELNYX_MANAGED_API_KEY = "test-api-key-123456";
    f.env.TELNYX_MANAGED_PUBLIC_KEY = btoa("x".repeat(32));
    f.env.TELNYX_MANAGED_SMS_CREDITS_PER_SEGMENT = "10";
    const billing = vi.fn(async () => Response.json({ settled: true }));
    f.env.BILLING_WORKER = { fetch: billing } as unknown as Fetcher;
    await f.db.prepare(`INSERT INTO assistant_phone_bindings(id,identity_id,purpose,payer,provider,provider_account_sid,
      provider_number_sid,phone_number,policy_json,status,managed_price_version,managed_rental_credits_per_month,
      managed_sms_credits_per_segment,managed_call_credits_per_minute) VALUES(?,?,'assistant','managed','telnyx','managed-account','12345','+14155550100',?,'active','retail-v1',100,10,20)`)
      .bind("managed-binding", identity.id, JSON.stringify(defaultPhonePolicy)).run();
    const now = Math.floor(Date.now() / 1000);
    await f.db.prepare(`INSERT INTO assistant_managed_telnyx_message_costs(provider_message_id,binding_id,direction,sender,
      carrier_reservation_id,reserved_credits,price_version,status,created_at,next_at,updated_at)
      VALUES('inbound-message','managed-binding','inbound','+14155550101','reservation-inbound',10,'retail-v1','pending',?,?,?)`)
      .bind(now, now, now).run();
    const provider = vi.fn(async () => Response.json({ data: { id: "inbound-message", direction: "inbound",
      from: { phone_number: "+14155550101" }, to: [{ phone_number: "+14155550100" }],
      cost: { amount: "0.0045", currency: "USD" }, completed_at: "2026-11-12T12:00:00Z" } }));
    vi.stubGlobal("fetch", provider);

    const result = await sweepManagedTelnyxInboundSmsCosts(f.env, now);

    expect(result).toMatchObject({ checked: 1, observed: 1, held: 0 });
    expect(billing).toHaveBeenCalledOnce();
    expect(await f.db.prepare(`SELECT provider,service_id,usage_kind,quantity_unit,quantity_micros,provider_cost_micros,currency,source_api
      FROM managed_service_provider_cost_observations`).first()).toMatchObject({ provider: "telnyx", service_id: "phone-number",
      usage_kind: "sms", quantity_unit: "message", quantity_micros: 1_000_000, provider_cost_micros: 4500,
      currency: "USD", source_api: "telnyx.messages.get" });
    expect(await f.db.prepare("SELECT status FROM assistant_managed_telnyx_message_costs WHERE provider_message_id='inbound-message'").first())
      .toMatchObject({ status: "observed" });
  });
});
