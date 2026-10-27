import { afterEach, describe, expect, it, vi } from "vitest";
import { fixture, scope } from "../../../../tests/fixtures/assistant-communications.js";
import { ensureIdentity, storeBody } from "./core.js";
import { defaultPhonePolicy, type AssistantPhoneBinding } from "./phones.js";
import { observeTelnyxSmsCost, reconcileTelnyxSms, sendApprovedTelnyxSms } from "./telnyx-send.js";

afterEach(() => vi.unstubAllGlobals());
describe("approved Telnyx SMS", () => {
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
