import { afterEach, describe, expect, it, vi } from "vitest";
import { fixture, scope } from "../../../../tests/fixtures/assistant-communications.js";
import { ensureIdentity, storeBody } from "./core.js";
import { defaultPhonePolicy, type AssistantPhoneBinding } from "./phones.js";
import { observeTelnyxSmsCost, reconcileTelnyxSms, sendApprovedTelnyxSms } from "./telnyx-send.js";

afterEach(() => vi.unstubAllGlobals());
describe("approved Telnyx SMS", () => {
  it("reserves the persisted managed SMS maximum and settles only the verified final cost", async () => {
    const f = fixture(), identity = await ensureIdentity(f.env, scope);
    f.fetch.mockImplementation(async (r: Request) => r.url.includes("assistant-access")
      ? Response.json({ effective_role: "owner" })
      : Response.json({ preferences: { enabled: { phone: true, email: true } } }));
    f.env.TELNYX_MANAGED_API_KEY = "managed-test-api-key-123456";
    f.env.TELNYX_MANAGED_PUBLIC_KEY = btoa("x".repeat(32));
    f.env.TELNYX_MANAGED_SMS_CREDITS_PER_SEGMENT = "99";
    f.env.TELNYX_MANAGED_PRICE_VERSION = "retail-v2";
    const billingBodies: Record<string, unknown>[] = [];
    const billing = vi.fn(async (request: Request) => {
      const body = await request.json() as Record<string, unknown>;
      billingBodies.push(body);
      return Response.json(new URL(request.url).pathname.endsWith("/reserve")
        ? { reserved: true, ...body } : { settled: true, ...body });
    });
    f.env.BILLING_WORKER = { fetch: billing } as unknown as Fetcher;
    await f.db.prepare(`INSERT INTO assistant_phone_bindings(id,identity_id,purpose,payer,provider,provider_account_sid,provider_number_sid,
      phone_number,capabilities_json,previous_callbacks_json,policy_json,status,managed_price_version,managed_rental_credits_per_month,
      managed_sms_credits_per_segment,managed_call_credits_per_minute)
      VALUES('managed-send-binding',?,'assistant','managed','telnyx','managed-account','12345','+14155550100','{"sms":true,"voice":true}','{}',?,'active','retail-v1',100,7,11)`)
      .bind(identity.id, JSON.stringify(defaultPhonePolicy)).run();
    const binding = (await f.db.prepare("SELECT * FROM assistant_phone_bindings WHERE id='managed-send-binding'").first<AssistantPhoneBinding>())!;
    const text = "A".repeat(161), key = await storeBody(f.env, identity, "managed-action", { text });
    await f.db.prepare(`INSERT INTO assistant_phone_actions(id,binding_id,actor_id,kind,recipient,body_key,status,managed_price_version,managed_reserved_credits)
      VALUES('managed-action','managed-send-binding','user','sms','+14155550101',?,'approved','retail-v1',14)`).bind(key).run();
    const provider = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/v2/messages" && init?.method === "POST") return Response.json({ data: { id: "message-1" } });
      if (url.pathname === "/v2/messages/message-1") return Response.json({ data: { id: "message-1", direction: "outbound",
        from: { phone_number: "+14155550100" }, to: [{ phone_number: "+14155550101" }], text,
        cost: { amount: "0.04", currency: "USD" }, completed_at: "2026-11-12T12:00:00Z" } });
      throw new Error(`unexpected Telnyx request ${url.pathname}`);
    });
    vi.stubGlobal("fetch", provider);

    await expect(sendApprovedTelnyxSms(f.env, identity, binding, "managed-action", scope)).resolves.toMatchObject({ status: "sent" });
    const reservation = billingBodies[0]!;
    expect(reservation).toMatchObject({ credits: 14, budget_key: "managed-phone:managed-send-binding:retail-v1" });
    expect(await f.db.prepare("SELECT managed_price_version,managed_reserved_credits,carrier_reservation_id FROM assistant_phone_actions WHERE id='managed-action'").first())
      .toMatchObject({ managed_price_version: "retail-v1", managed_reserved_credits: 14, carrier_reservation_id: expect.stringMatching(/^telnyx_sms_/) });

    await expect(observeTelnyxSmsCost(f.env, identity, binding, "managed-action")).resolves.toMatchObject({ tenant_charge_credits: 5, billed_by: "naelao_plan" });
    const settlement = billingBodies[1]!;
    expect(settlement).toMatchObject({ quantity: 5 });
    expect(billing).toHaveBeenCalledTimes(2);
  });

  it("requires a matching provider receipt to resolve an indeterminate send", async () => {
    const f = fixture(), identity = await ensureIdentity(f.env, scope);
    f.env.CREDENTIALS_WORKER = { fetch: vi.fn(async () => Response.json({ value: JSON.stringify({ apiKey: "test-api-key-123456", publicKey: btoa("x".repeat(32)), verifiedNumberId: "12345", verifiedPhoneNumber: "+14155550100" }) })) } as unknown as Fetcher;
    await f.db.prepare("INSERT INTO assistant_phone_bindings(id,identity_id,purpose,payer,provider,provider_account_sid,provider_number_sid,phone_number,policy_json,status) VALUES(?,?,'assistant','byo','telnyx','account','12345','+14155550100',?,'active')").bind("binding-1", identity.id, JSON.stringify(defaultPhonePolicy)).run();
    const binding = (await f.db.prepare("SELECT * FROM assistant_phone_bindings WHERE id='binding-1'").first<AssistantPhoneBinding>())!;
    const key = await storeBody(f.env, identity, "action-1", { text: "Hello" });
    await f.db.prepare("INSERT INTO assistant_phone_actions(id,binding_id,actor_id,kind,recipient,body_key,status) VALUES('action-1','binding-1','user','sms','+14155550101',?,'indeterminate')").bind(key).run();
    let text = "Wrong", amount: string | undefined;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: { id: "message-1", direction: "outbound", from: { phone_number: "+14155550100" }, to: [{ phone_number: "+14155550101" }], text, ...(amount ? { cost: { amount, currency: "USD" }, completed_at: "2026-10-27T12:00:00Z" } : {}) } })));
    await expect(reconcileTelnyxSms(f.env, identity, binding, "action-1", "message-1")).rejects.toThrow("telnyx_reconciliation_record_mismatch");
    expect((await f.db.prepare("SELECT status FROM assistant_phone_actions WHERE id='action-1'").first<{ status: string }>())?.status).toBe("indeterminate");
    text = "Hello";
    await expect(reconcileTelnyxSms(f.env, identity, binding, "action-1", "message-1")).resolves.toMatchObject({ reconciled: true, status: "sent" });
    await expect(observeTelnyxSmsCost(f.env, identity, binding, "action-1")).resolves.toEqual({ status: "pending" });
    amount = "0.004500";
    await expect(observeTelnyxSmsCost(f.env, identity, binding, "action-1")).resolves.toMatchObject({ status: "observed", amount: "0.004500", currency: "USD", billed_by: "telnyx" });
    await observeTelnyxSmsCost(f.env, identity, binding, "action-1");
    amount = "0.005000";
    await observeTelnyxSmsCost(f.env, identity, binding, "action-1");
    const receipts = await f.db.prepare("SELECT amount FROM assistant_telnyx_usage_receipts WHERE action_id='action-1' ORDER BY amount").all<{ amount: string }>();
    expect(receipts.results).toEqual([{ amount: "0.004500" }, { amount: "0.005000" }]);
    const observations = await f.db.prepare("SELECT provider_cost_micros,source_api FROM managed_service_provider_cost_observations ORDER BY provider_cost_micros")
      .all<{ provider_cost_micros: number; source_api: string }>();
    expect(observations.results).toEqual([
      { provider_cost_micros: 4500, source_api: "telnyx.messages.get" },
      { provider_cost_micros: 5000, source_api: "telnyx.messages.get" },
    ]);
  });
  it("keeps an uncertain send indeterminate and never sends it a second time", async () => {
    const f = fixture(), identity = await ensureIdentity(f.env, scope);
    f.fetch.mockImplementation(async (r: Request) => r.url.includes("assistant-access") ? Response.json({ effective_role: "owner" }) : Response.json({ preferences: { enabled: { phone: true, email: true } } }));
    f.env.CREDENTIALS_WORKER = { fetch: vi.fn(async () => Response.json({ value: JSON.stringify({ apiKey: "test-api-key-123456", publicKey: btoa("x".repeat(32)), verifiedNumberId: "12345", verifiedPhoneNumber: "+14155550100" }) })) } as unknown as Fetcher;
    await f.db.prepare("INSERT INTO assistant_phone_bindings(id,identity_id,purpose,payer,provider,provider_account_sid,provider_number_sid,phone_number,policy_json,status) VALUES(?,?,'assistant','byo','telnyx','account','12345','+14155550100',?,'active')")
      .bind("binding-1", identity.id, JSON.stringify(defaultPhonePolicy)).run();
    const binding = (await f.db.prepare("SELECT * FROM assistant_phone_bindings WHERE id='binding-1'").first<AssistantPhoneBinding>())!;
    const key = await storeBody(f.env, identity, "action-1", { text: "Hello" });
    await f.db.prepare("INSERT INTO assistant_phone_actions(id,binding_id,actor_id,kind,recipient,body_key,status) VALUES('action-1','binding-1','user','sms','+14155550101',?,'approved')").bind(key).run();
    const provider = vi.fn(async () => { throw new Error("connection lost"); }); vi.stubGlobal("fetch", provider);
    await expect(sendApprovedTelnyxSms(f.env, identity, binding, "action-1", scope)).rejects.toMatchObject({ uncertain: true });
    expect((await f.db.prepare("SELECT status FROM assistant_phone_actions WHERE id='action-1'").first<{ status: string }>())?.status).toBe("indeterminate");
    await expect(sendApprovedTelnyxSms(f.env, identity, binding, "action-1", scope)).rejects.toThrow("phone_action_approval_required");
    expect(provider).toHaveBeenCalledTimes(1);
  });
});
