import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mintInternalToken } from "@naelao/http";
import { getExpectedTwilioSignature } from "twilio/lib/webhooks/webhooks.js";
import type { AgentsEnv } from "../index.js";
import {
  fixture,
  scope,
} from "../../../../tests/fixtures/assistant-communications.js";
import { ensureIdentity, readBody } from "./core.js";
import {
  handlePhoneAction,
  defaultPhonePolicy,
  sweepTelnyxNumberOrders,
  sweepTelnyxNumberReleases,
  validatePhonePolicy,
} from "./phones.js";
import { phoneProvider, PhoneProviderError } from "./phone-provider.js";
import { registerPhoneWebhooks } from "./phone-webhooks.js";
import { registerCommunicationRoutes } from "./routes.js";
import { detachAssistantPhonesForErasure } from "./phone-lifecycle.js";
import { telnyxCallControlIdHash } from "./telnyx-voice-cost.js";
const account = "AC" + "a".repeat(32),
  token = "b".repeat(32),
  pn = "PN" + "c".repeat(32),
  number = "+14155550100",
  other = "+14155550101";
const creds = { accountSid: account, authToken: token };
async function phoneFixture() {
  const f = fixture();
  f.env.PUBLIC_AGENTS_URL = "https://phone.example.com";
  f.fetch.mockImplementation(async (r: Request) =>
    r.url.includes("assistant-access")
      ? Response.json({
          effective_role: r.url.includes("other") ? "editor" : "owner",
        })
      : Response.json({
          preferences: { enabled: { email: true, phone: true } },
        })
  );
  f.env.CREDENTIALS_WORKER = {
    fetch: vi.fn(async () => Response.json({ value: JSON.stringify(creds) })),
  } as unknown as Fetcher;
  const identity = await ensureIdentity(f.env, scope);
  const provider = vi.fn(async (_url: unknown, init?: RequestInit) =>
    init?.method === "DELETE"
      ? new Response(null, { status: 204 })
      : Response.json({
          sid: pn,
          account_sid: account,
          phone_number: number,
          capabilities: { voice: true, sms: true, mms: true },
          voice_url: "https://old.example.com/voice",
          sms_url: "https://old.example.com/sms",
          voice_method: "POST",
          sms_method: "POST",
        })
  );
  vi.stubGlobal("fetch", provider);
  const act = (
    action: string,
    body: Record<string, unknown> = {},
    manager = true,
    agent = false
  ) => handlePhoneAction(f.env, scope, identity, action, body, manager, agent);
  await act("phone-import", { number_sid: pn, confirm: true });
  const binding = (await f.db
    .prepare("SELECT * FROM assistant_phone_bindings")
    .first<{ id: string }>())!;
  return { ...f, identity, provider, act, binding };
}
afterEach(() => vi.unstubAllGlobals());
describe("managed Telnyx rate agreements", () => {
  it("keeps managed number staging disabled even when provider credentials are present", async () => {
    const f = fixture();
    f.fetch.mockImplementation(async (r: Request) => r.url.includes("assistant-access") ? Response.json({ effective_role: "owner" }) : Response.json({ preferences: { enabled: { phone: true, email: true } } }));
    f.env.TELNYX_MANAGED_API_KEY = "managed-test-api-key-123456";
    f.env.TELNYX_MANAGED_PUBLIC_KEY = btoa("x".repeat(32));
    f.env.TELNYX_MANAGED_PRICE_VERSION = "retail-v1";
    f.env.TELNYX_MANAGED_RENTAL_CREDITS_PER_MONTH = "100";
    f.env.TELNYX_MANAGED_SMS_CREDITS_PER_SEGMENT = "10";
    f.env.TELNYX_MANAGED_CALL_CREDITS_PER_MINUTE = "20";
    const identity = await ensureIdentity(f.env, scope);
    const provider = vi.fn(); vi.stubGlobal("fetch", provider);
    await expect(handlePhoneAction(f.env, scope, identity, "phone-telnyx-managed-stage", {
      confirm: true, number_id: "12345", confirmed_price_version: "retail-v1",
    }, true, false)).rejects.toThrow("managed_telnyx_rollout_disabled");
    expect(provider).not.toHaveBeenCalled();
    expect(await f.db.prepare("SELECT id FROM assistant_phone_bindings").first()).toBeNull();
  });

  it("requires exact line-stage rate confirmation and persists the accepted schedule", async () => {
    const f = fixture(); f.env.PUBLIC_AGENTS_URL = "https://phone.example.com";
    f.fetch.mockImplementation(async (r: Request) => r.url.includes("assistant-access") ? Response.json({ effective_role: "owner" }) : Response.json({ preferences: { enabled: { phone: true, email: true } } }));
    f.env.TELNYX_MANAGED_ENABLED = "true";
    f.env.TELNYX_MANAGED_API_KEY = "managed-test-api-key-123456";
    f.env.TELNYX_MANAGED_PUBLIC_KEY = btoa("x".repeat(32));
    f.env.TELNYX_MANAGED_MESSAGING_PROFILE_ID = "profile-1";
    f.env.TELNYX_MANAGED_CALL_CONTROL_ID = "call-app-1";
    f.env.TELNYX_MANAGED_PRICE_VERSION = "retail-v1";
    f.env.TELNYX_MANAGED_RENTAL_CREDITS_PER_MONTH = "100";
    f.env.TELNYX_MANAGED_SMS_CREDITS_PER_SEGMENT = "10";
    f.env.TELNYX_MANAGED_CALL_CREDITS_PER_MINUTE = "20";
    const identity = await ensureIdentity(f.env, scope);
    const webhook = "https://phone.example.com/assistant-phone/telnyx-managed";
    const provider = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/v2/phone_numbers/12345") return Response.json({ data: { id: "12345", phone_number: number,
        messaging_profile_id: "profile-1", connection_id: "call-app-1" } });
      if (url.pathname === "/v2/messaging_profiles/profile-1") return Response.json({ data: { id: "profile-1", enabled: true, webhook_url: webhook, webhook_api_version: "2" } });
      if (url.pathname === "/v2/call_control_applications/call-app-1") return Response.json({ data: { id: "call-app-1", active: true,
        webhook_event_url: webhook, webhook_api_version: "2", call_cost_in_webhooks: false } });
      throw new Error(`unexpected Telnyx request ${url.pathname}`);
    });
    vi.stubGlobal("fetch", provider);
    const act = (confirmedPriceVersion: string, smsCreditsPerSegment = 10) => handlePhoneAction(f.env, scope, identity, "phone-telnyx-managed-stage", {
      confirm: true, number_id: "12345", confirmed_price_version: confirmedPriceVersion,
      confirmed_rental_credits_per_month: 100, confirmed_sms_credits_per_segment: smsCreditsPerSegment,
      confirmed_call_credits_per_minute: 20,
    }, true, false);
    await expect(act("retail-v0")).rejects.toThrow("managed_telnyx_rate_schedule_changed");
    expect(provider).not.toHaveBeenCalled();
    await expect(act("retail-v1", 9)).rejects.toThrow("managed_telnyx_rate_schedule_changed");
    expect(provider).not.toHaveBeenCalled();
    await expect(act("retail-v1")).resolves.toMatchObject({ managed: true, transport_active: false });
    const binding = await f.db.prepare("SELECT managed_price_version,managed_rental_credits_per_month,managed_sms_credits_per_segment,managed_call_credits_per_minute FROM assistant_phone_bindings")
      .first();
    expect(binding).toEqual({ managed_price_version: "retail-v1", managed_rental_credits_per_month: 100,
      managed_sms_credits_per_segment: 10, managed_call_credits_per_minute: 20 });
    f.env.TELNYX_MANAGED_PRICE_VERSION = "retail-v2";
    f.env.TELNYX_MANAGED_SMS_CREDITS_PER_SEGMENT = "99";
    expect(await f.db.prepare("SELECT managed_price_version,managed_sms_credits_per_segment FROM assistant_phone_bindings").first())
      .toEqual({ managed_price_version: "retail-v1", managed_sms_credits_per_segment: 10 });
  });

  it("persists and confirms SMS maximum against the binding price after config changes", async () => {
    const f = fixture(), identity = await ensureIdentity(f.env, scope);
    f.fetch.mockImplementation(async (r: Request) => r.url.includes("assistant-access") ? Response.json({ effective_role: "owner" }) : Response.json({ preferences: { enabled: { phone: true, email: true } } }));
    f.env.TELNYX_MANAGED_PRICE_VERSION = "retail-v2";
    f.env.TELNYX_MANAGED_SMS_CREDITS_PER_SEGMENT = "99";
    await f.db.prepare(`INSERT INTO assistant_phone_bindings(id,identity_id,purpose,payer,provider,provider_account_sid,provider_number_sid,
      phone_number,capabilities_json,previous_callbacks_json,policy_json,status,managed_price_version,managed_rental_credits_per_month,
      managed_sms_credits_per_segment,managed_call_credits_per_minute)
      VALUES('managed-sms-binding',?,'assistant','managed','telnyx','managed-account','12345','+14155550100','{"sms":true,"voice":true}','{}',?,'active','retail-v1',100,7,11)`)
      .bind(identity.id, JSON.stringify(defaultPhonePolicy)).run();
    const act = (action: string, body: Record<string, unknown>) => handlePhoneAction(f.env, scope, identity, action, body, true, false);
    const draft = await act("phone-draft", { kind: "sms", to: "+14155550101", text: "A".repeat(161) }) as { id: string; estimated_credits: number; price_version: string; segments: number };
    expect(draft).toMatchObject({ estimated_credits: 14, price_version: "retail-v1", segments: 2 });
    expect(await f.db.prepare("SELECT managed_price_version,managed_reserved_credits FROM assistant_phone_actions WHERE id=?").bind(draft.id).first())
      .toEqual({ managed_price_version: "retail-v1", managed_reserved_credits: 14 });
    await expect(act("phone-telnyx-approve", { id: draft.id, confirm: true,
      confirmed_price_version: "retail-v1", confirmed_max_charge_credits: 13 })).rejects.toThrow("managed_telnyx_sms_confirmation_mismatch");
    await expect(act("phone-telnyx-approve", { id: draft.id, confirm: true,
      confirmed_price_version: "retail-v1", confirmed_max_charge_credits: 14 })).resolves.toMatchObject({ status: "approved" });
  });

  it("requires the owner to confirm the persisted maximum before arming a managed call", async () => {
    const f = fixture(), identity = await ensureIdentity(f.env, scope);
    f.fetch.mockImplementation(async (r: Request) => r.url.includes("assistant-access") ? Response.json({ effective_role: "owner" }) : Response.json({ preferences: { enabled: { phone: true, email: true } } }));
    await f.db.prepare(`INSERT INTO assistant_phone_bindings(id,identity_id,purpose,payer,provider,provider_account_sid,provider_number_sid,
      phone_number,capabilities_json,previous_callbacks_json,policy_json,status,managed_price_version,managed_rental_credits_per_month,
      managed_sms_credits_per_segment,managed_call_credits_per_minute)
      VALUES('managed-call-binding',?,'assistant','managed','telnyx','managed-account','12345','+14155550100','{"sms":true,"voice":true}','{}',?,'active','retail-v1',100,7,11)`)
      .bind(identity.id, JSON.stringify(defaultPhonePolicy)).run();
    await expect(handlePhoneAction(f.env, scope, identity, "phone-live", {
      confirm: true, confirmed_price_version: "retail-v1", confirmed_max_charge_credits: 54,
    }, true, false)).rejects.toThrow("managed_telnyx_call_confirmation_mismatch");
    await expect(handlePhoneAction(f.env, scope, identity, "phone-live", {
      confirm: true, confirmed_price_version: "retail-v1", confirmed_max_charge_credits: 55,
    }, true, false)).rejects.toThrow("phone_provider_live_transport_unavailable");
  });
});
describe("assistant telephone safety and lifecycle", () => {
  it("quotes, journals and reconciles a customer-owned Telnyx number order without replay", async () => {
    const f = fixture(); f.env.PUBLIC_AGENTS_URL = "https://phone.example.com";
    f.fetch.mockImplementation(async (r: Request) => r.url.includes("assistant-access") ? Response.json({ effective_role: "owner" }) : Response.json({ preferences: { enabled: { phone: true, email: true } } }));
    const identity = await ensureIdentity(f.env, scope);
    const telnyx = { apiKey: "test-api-key-123456", publicKey: btoa("x".repeat(32)), verifiedNumberId: "12345", verifiedPhoneNumber: number, callControlId: "connection-1" };
    f.env.CREDENTIALS_WORKER = { fetch: vi.fn(async () => Response.json({ value: JSON.stringify(telnyx) })) } as unknown as Fetcher;
    const orderId = "123e4567-e89b-12d3-a456-426614174000", newNumberId = "67890", selectedNumber = "+14155550123";
    let customerReference = "";
    const provider = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input), method = init?.method ?? "GET";
      if (url.includes("available_phone_numbers")) return Response.json({ data: [{ phone_number: selectedNumber, phone_number_type: "local",
        features: [{ name: "voice" }, { name: "sms" }], region_information: [],
        cost_information: { upfront_cost: "1.25", monthly_cost: "2.00", currency: "USD" } }] });
      if (url.endsWith("/phone_numbers/12345")) return Response.json({ data: { id: "12345", phone_number: number, connection_id: "connection-1", messaging_profile_id: "profile-1" } });
      if (url.endsWith("/phone_numbers/67890")) return Response.json({ data: { id: newNumberId, phone_number: selectedNumber, connection_id: "connection-1", messaging_profile_id: "profile-1" } });
      if (url.endsWith("/number_orders") && method === "POST") { customerReference = JSON.parse(String(init?.body)).customer_reference; return Response.json({ data: { id: orderId, status: "pending", customer_reference: customerReference } }); }
      if (url.endsWith(`/number_orders/${orderId}`)) return Response.json({ data: { id: orderId, status: "success", customer_reference: customerReference,
        phone_numbers: [{ id: newNumberId, phone_number: selectedNumber }] } });
      throw new Error(`unexpected Telnyx request ${method} ${url}`);
    });
    vi.stubGlobal("fetch", provider);
    const act = (action: string, body: Record<string, unknown> = {}, manager = true) => handlePhoneAction(f.env, scope, identity, action, body, manager, false);
    await act("phone-telnyx-search",{country:"US",number_type:"local"});
    expect(String(provider.mock.calls[0]?.[0])).toContain("filter%5Bphone_number_type%5D=local");
    const quote = await act("phone-telnyx-quote", { country: "US", phone_number: selectedNumber }) as { quote_id: string; upfront_cost_minor: number; monthly_cost_minor: number };
    expect(quote).toMatchObject({ upfront_cost_minor: 125, monthly_cost_minor: 200 });
    await expect(act("phone-telnyx-order", { quote_id: quote.quote_id, confirm: true,
      confirm_upfront_cost_minor: quote.upfront_cost_minor, confirm_monthly_cost_minor: quote.monthly_cost_minor }))
      .resolves.toMatchObject({ status: "pending", phone_number: selectedNumber });
    const op = await f.db.prepare("SELECT id,status,provider_order_id FROM assistant_telnyx_number_order_operations").first<{ id: string; status: string; provider_order_id: string }>();
    expect(op).toMatchObject({ status: "pending", provider_order_id: orderId });
    await expect(act("phone-telnyx-order", { quote_id: quote.quote_id, confirm: true,
      confirm_upfront_cost_minor: quote.upfront_cost_minor, confirm_monthly_cost_minor: quote.monthly_cost_minor }))
      .rejects.toThrow("phone_quote_expired_or_price_not_confirmed");
    expect(provider.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    await f.db.prepare("UPDATE assistant_telnyx_number_order_operations SET next_reconcile_at='2000-01-01T00:00:00.000Z' WHERE id=?").bind(op!.id).run();
    await expect(sweepTelnyxNumberOrders(f.env,new Date("2026-11-11T12:00:00.000Z"),10))
      .resolves.toMatchObject({checked:1,reconciled:1,deferred:0,failed:0});
    expect(await f.db.prepare("SELECT status,provider_number_id FROM assistant_telnyx_number_order_operations WHERE id=?").bind(op!.id).first())
      .toMatchObject({ status: "succeeded", provider_number_id: newNumberId });
    expect(await f.db.prepare("SELECT provider,payer,status,provider_number_sid,phone_number FROM assistant_phone_bindings WHERE identity_id=?").bind(identity.id).first())
      .toMatchObject({ provider: "telnyx", payer: "byo", status: "configuring", provider_number_sid: newNumberId, phone_number: selectedNumber });
    expect(provider.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
  it("recovers a lost Telnyx order acknowledgement by customer reference without another purchase",async()=>{
    const f=fixture();f.env.PUBLIC_AGENTS_URL="https://phone.example.com";
    f.fetch.mockImplementation(async(request:Request)=>request.url.includes("assistant-access")?Response.json({effective_role:"owner"}):Response.json({preferences:{enabled:{phone:true,email:true}}}));
    const identity=await ensureIdentity(f.env,scope);
    const telnyx={apiKey:"test-api-key-123456",publicKey:btoa("x".repeat(32)),verifiedNumberId:"12345",verifiedPhoneNumber:number,callControlId:"connection-1"};
    f.env.CREDENTIALS_WORKER={fetch:vi.fn(async()=>Response.json({value:JSON.stringify(telnyx)}))} as unknown as Fetcher;
    const orderId="123e4567-e89b-12d3-a456-426614174000",newNumberId="67890",selectedNumber="+14155550124";
    let customerReference="";
    const provider=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
      const url=new URL(String(input)),method=init?.method??"GET";
      if(url.pathname.endsWith("/available_phone_numbers"))return Response.json({data:[{phone_number:selectedNumber,phone_number_type:"local",
        features:[{name:"voice"},{name:"sms"}],region_information:[],cost_information:{upfront_cost:"1.25",monthly_cost:"2.00",currency:"USD"}}]});
      if(url.pathname.endsWith("/phone_numbers/12345"))return Response.json({data:{id:"12345",phone_number:number,connection_id:"connection-1",messaging_profile_id:"profile-1"}});
      if(url.pathname.endsWith(`/phone_numbers/${newNumberId}`))return Response.json({data:{id:newNumberId,phone_number:selectedNumber,connection_id:"connection-1",messaging_profile_id:"profile-1"}});
      if(url.pathname.endsWith("/number_orders")&&method==="POST"){
        customerReference=String(JSON.parse(String(init?.body)).customer_reference);
        throw new Error("provider accepted order but acknowledgement was lost");
      }
      if(url.pathname.endsWith("/number_orders")&&method==="GET")return Response.json({data:[{id:orderId,status:"success",customer_reference:customerReference,
        phone_numbers:[{id:newNumberId,phone_number:selectedNumber}]}]});
      throw new Error(`unexpected Telnyx request ${method} ${url}`);
    });
    vi.stubGlobal("fetch",provider);
    const act=(action:string,body:Record<string,unknown>={})=>handlePhoneAction(f.env,scope,identity,action,body,true,false);
    const quote=await act("phone-telnyx-quote",{country:"US",phone_number:selectedNumber}) as {quote_id:string;upfront_cost_minor:number;monthly_cost_minor:number};
    await expect(act("phone-telnyx-order",{quote_id:quote.quote_id,confirm:true,confirm_upfront_cost_minor:quote.upfront_cost_minor,
      confirm_monthly_cost_minor:quote.monthly_cost_minor})).rejects.toThrow("telnyx_number_order_reconciliation_required");
    const operation=await f.db.prepare("SELECT id,status,customer_reference,next_reconcile_at FROM assistant_telnyx_number_order_operations")
      .first<{id:string;status:string;customer_reference:string;next_reconcile_at:string}>();
    expect(operation).toMatchObject({status:"uncertain",customer_reference:expect.stringMatching(/^naelao_tn_/),next_reconcile_at:expect.any(String)});
    await f.db.prepare("UPDATE assistant_telnyx_number_order_operations SET next_reconcile_at='2000-01-01T00:00:00.000Z' WHERE id=?").bind(operation!.id).run();
    await expect(sweepTelnyxNumberOrders(f.env,new Date("2026-11-11T12:00:00.000Z"),10))
      .resolves.toMatchObject({checked:1,reconciled:1,deferred:0,failed:0});
    expect(await f.db.prepare("SELECT status,provider_order_id,provider_number_id FROM assistant_telnyx_number_order_operations WHERE id=?")
      .bind(operation!.id).first()).toMatchObject({status:"succeeded",provider_order_id:orderId,provider_number_id:newNumberId});
    expect(provider.mock.calls.filter(([input,init])=>init?.method==="POST"&&new URL(String(input)).pathname.endsWith("/number_orders"))).toHaveLength(1);
  });
  it("journals a managed Telnyx release and confirms a lost DELETE by exact read-only inspection",async()=>{
    const f=fixture();f.env.PUBLIC_AGENTS_URL="https://phone.example.com";
    f.fetch.mockImplementation(async(request:Request)=>request.url.includes("assistant-access")?Response.json({effective_role:"owner"}):Response.json({preferences:{enabled:{phone:true,email:true}}}));
    f.env.TELNYX_MANAGED_API_KEY="managed-test-api-key-123456";
    f.env.TELNYX_MANAGED_PUBLIC_KEY=btoa("x".repeat(32));
    const identity=await ensureIdentity(f.env,scope),numberId="98765",providerNumber="+14155550987";
    await f.db.prepare(`INSERT INTO assistant_phone_bindings(id,identity_id,purpose,payer,provider,provider_account_sid,provider_number_sid,
      phone_number,country_code,capabilities_json,previous_callbacks_json,status,policy_json,monthly_cost_minor)
      VALUES('managed-release-binding',?,'assistant','managed','telnyx','managed-account',? ,?,'US','{"sms":true}', '{}','active',?,100)`)
      .bind(identity.id,numberId,providerNumber,JSON.stringify(defaultPhonePolicy)).run();
    let providerNumberExists=true;
    const provider=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
      const url=new URL(String(input)),method=init?.method??"GET";
      if(url.pathname===`/v2/phone_numbers/${numberId}`&&method==="DELETE"){
        providerNumberExists=false;
        throw new Error("DELETE accepted but acknowledgement was lost");
      }
      if(url.pathname===`/v2/phone_numbers/${numberId}`&&method==="GET"){
        if(!providerNumberExists)return new Response(null,{status:404});
        return Response.json({data:{id:numberId,phone_number:providerNumber}});
      }
      throw new Error(`unexpected Telnyx request ${method} ${url}`);
    });
    vi.stubGlobal("fetch",provider);
    const release=()=>handlePhoneAction(f.env,scope,identity,"phone-telnyx-detach",{
      binding_id:"managed-release-binding",confirm:true,provider_checked:true,
    },true,false);
    await expect(release()).resolves.toMatchObject({status:"uncertain",released:false,reconciliation_scheduled:true});
    const operation=await f.db.prepare("SELECT id,status,next_reconcile_at,provider_number_id FROM assistant_telnyx_number_release_operations")
      .first<{id:string;status:string;next_reconcile_at:string;provider_number_id:string}>();
    expect(operation).toMatchObject({status:"uncertain",next_reconcile_at:expect.any(String),provider_number_id:numberId});
    await expect(release()).resolves.toMatchObject({operation_id:operation!.id,status:"uncertain"});
    expect(provider.mock.calls.filter(([,init])=>init?.method==="DELETE")).toHaveLength(1);
    await f.db.prepare("UPDATE assistant_telnyx_number_release_operations SET next_reconcile_at='2000-01-01T00:00:00.000Z' WHERE id=?").bind(operation!.id).run();
    await expect(sweepTelnyxNumberReleases(f.env,new Date("2026-11-12T12:00:00.000Z"),10))
      .resolves.toMatchObject({checked:1,released:1,deferred:0,failed:0});
    expect(await f.db.prepare("SELECT status,last_error FROM assistant_telnyx_number_release_operations WHERE id=?").bind(operation!.id).first())
      .toEqual({status:"released",last_error:null});
    expect(await f.db.prepare("SELECT status FROM assistant_phone_bindings WHERE id='managed-release-binding'").first())
      .toEqual({status:"released"});
    expect(provider.mock.calls.filter(([,init])=>init?.method==="DELETE")).toHaveLength(1);
    expect(provider.mock.calls.filter(([,init])=>(init?.method??"GET")==="GET")).toHaveLength(1);
  });
  it("does not replay a legacy indeterminate managed Telnyx release",async()=>{
    const f=fixture();f.env.PUBLIC_AGENTS_URL="https://phone.example.com";
    f.fetch.mockImplementation(async(request:Request)=>request.url.includes("assistant-access")?Response.json({effective_role:"owner"}):Response.json({preferences:{enabled:{phone:true,email:true}}}));
    f.env.TELNYX_MANAGED_API_KEY="managed-test-api-key-123456";f.env.TELNYX_MANAGED_PUBLIC_KEY=btoa("x".repeat(32));
    const identity=await ensureIdentity(f.env,scope),numberId="98766",providerNumber="+14155550988";
    await f.db.prepare(`INSERT INTO assistant_phone_bindings(id,identity_id,purpose,payer,provider,provider_account_sid,provider_number_sid,
      phone_number,country_code,capabilities_json,previous_callbacks_json,status,policy_json,monthly_cost_minor)
      VALUES('legacy-indeterminate-binding',?,'assistant','managed','telnyx','managed-account',?,?,'US','{"sms":true}', '{}','indeterminate',?,100)`)
      .bind(identity.id,numberId,providerNumber,JSON.stringify(defaultPhonePolicy)).run();
    const provider=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
      const url=new URL(String(input)),method=init?.method??"GET";
      if(url.pathname===`/v2/phone_numbers/${numberId}`&&method==="GET")return Response.json({data:{id:numberId,phone_number:providerNumber}});
      throw new Error(`unexpected Telnyx request ${method} ${url}`);
    });
    vi.stubGlobal("fetch",provider);
    await expect(handlePhoneAction(f.env,scope,identity,"phone-telnyx-detach",{
      binding_id:"legacy-indeterminate-binding",confirm:true,provider_checked:true,
    },true,false)).resolves.toMatchObject({status:"uncertain",released:false,reconciliation_scheduled:true});
    const status=await handlePhoneAction(f.env,scope,identity,"phone-status",{},true,false);
    expect(status).toMatchObject({telnyx_release:{status:"uncertain",phone_number:providerNumber}});
    expect(provider.mock.calls.filter(([,init])=>init?.method==="DELETE")).toHaveLength(0);
    const operation=await f.db.prepare("SELECT id FROM assistant_telnyx_number_release_operations").first<{id:string}>();
    await f.db.prepare("UPDATE assistant_telnyx_number_release_operations SET next_reconcile_at='2000-01-01T00:00:00.000Z' WHERE id=?").bind(operation!.id).run();
    await expect(sweepTelnyxNumberReleases(f.env,new Date("2026-11-12T12:00:00.000Z"),10))
      .resolves.toMatchObject({checked:1,released:0,deferred:1,failed:0});
    expect(provider.mock.calls.filter(([,init])=>init?.method==="DELETE")).toHaveLength(0);
  });
  it("activates Telnyx SMS only after verifying the exact provider webhook", async () => {
    const f = fixture(); f.env.PUBLIC_AGENTS_URL = "https://phone.example.com";
    f.fetch.mockImplementation(async (r: Request) => r.url.includes("assistant-access") ? Response.json({ effective_role: "owner" }) : Response.json({ preferences: { enabled: { phone: true, email: true } } }));
    const identity = await ensureIdentity(f.env, scope);
    f.env.CREDENTIALS_WORKER = { fetch: vi.fn(async () => Response.json({ value: JSON.stringify({ apiKey: "test-api-key-123456", publicKey: btoa("x".repeat(32)), verifiedNumberId: "12345", verifiedPhoneNumber: number }) })) } as unknown as Fetcher;
    let webhook = "https://wrong.example.com";
    const provider = vi.fn(async (url: string) => url.includes("messaging_profiles") ? Response.json({ data: { id: "profile-1", enabled: true, webhook_url: webhook, webhook_api_version: "2" } }) : Response.json({ data: { id: "12345", phone_number: number, messaging_profile_id: "profile-1" } }));
    vi.stubGlobal("fetch", provider);
    const staged = await handlePhoneAction(f.env, scope, identity, "phone-telnyx-stage", { confirm: true }, true, false) as { phone: { id: string } };
    await expect(handlePhoneAction(f.env, scope, identity, "phone-telnyx-activate", { confirm: true }, true, false)).rejects.toThrow("telnyx_webhook_not_configured");
    webhook = `https://phone.example.com/assistant-phone/telnyx/${staged.phone.id}`;
    await expect(handlePhoneAction(f.env, scope, identity, "phone-telnyx-activate", { confirm: true }, true, false)).resolves.toMatchObject({ sms_active: true, voice_active: false, phone: { status: "active", capabilities: { sms: true, voice: false } } });
    await expect(handlePhoneAction(f.env, scope, identity, "phone-telnyx-detach", { confirm: true }, true, false)).resolves.toMatchObject({ detached: true, webhook_unchanged: true });
  });
  it("rechecks and persists the Telnyx call-cost webhook setting without changing provider config", async () => {
    const f = fixture(); f.env.PUBLIC_AGENTS_URL = "https://phone.example.com";
    f.fetch.mockImplementation(async (r: Request) => r.url.includes("assistant-access") ? Response.json({ effective_role: "owner" }) : Response.json({ preferences: { enabled: { phone: true, email: true } } }));
    const identity = await ensureIdentity(f.env, scope);
    f.env.CREDENTIALS_WORKER = { fetch: vi.fn(async () => Response.json({ value: JSON.stringify({
      apiKey: "test-api-key-123456", publicKey: btoa("x".repeat(32)), verifiedNumberId: "12345",
      verifiedPhoneNumber: number, callControlId: "connection-1",
    }) })) } as unknown as Fetcher;
    const bindingId = "telnyx-cost-status";
    await f.db.prepare(`INSERT INTO assistant_phone_bindings(id,identity_id,purpose,payer,provider,provider_account_sid,
      provider_number_sid,phone_number,capabilities_json,previous_callbacks_json,policy_json,status)
      VALUES(?,?,'assistant','byo','telnyx',?,?,?,'{"sms":true,"voice":true}','{}',?,'active')`)
      .bind(bindingId, identity.id, `identity:${identity.id}`, "12345", number, JSON.stringify(defaultPhonePolicy)).run();
    let enabled = false;
    const expected = `https://phone.example.com/assistant-phone/telnyx/${bindingId}`;
    const provider = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/v2/phone_numbers/12345") return Response.json({ data: { id: "12345", phone_number: number, connection_id: "connection-1" } });
      if (url.pathname === "/v2/call_control_applications/connection-1") return Response.json({ data: {
        id: "connection-1", active: true, webhook_event_url: expected, webhook_api_version: "2", call_cost_in_webhooks: enabled,
      } });
      throw new Error(`unexpected Telnyx request ${url}`);
    });
    vi.stubGlobal("fetch", provider);
    await expect(handlePhoneAction(f.env, scope, identity, "phone-telnyx-cost-status", {}, true, false))
      .resolves.toEqual({ call_cost_webhooks_enabled: false });
    expect(JSON.parse((await f.db.prepare("SELECT capabilities_json FROM assistant_phone_bindings WHERE id=?").bind(bindingId).first<{ capabilities_json: string }>())!.capabilities_json))
      .toMatchObject({ voice: true, call_cost_webhooks: false });
    enabled = true;
    await expect(handlePhoneAction(f.env, scope, identity, "phone-telnyx-cost-status", {}, true, false))
      .resolves.toEqual({ call_cost_webhooks_enabled: true });
    expect(JSON.parse((await f.db.prepare("SELECT capabilities_json FROM assistant_phone_bindings WHERE id=?").bind(bindingId).first<{ capabilities_json: string }>())!.capabilities_json))
      .toMatchObject({ voice: true, call_cost_webhooks: true });
    expect(provider.mock.calls.every(([, init]) => init?.method === undefined || init.method === "GET")).toBe(true);
  });
  it("stages only a freshly verified Telnyx number and can cancel without changing the carrier", async () => {
    const f = fixture();
    f.fetch.mockImplementation(async (r: Request) => r.url.includes("assistant-access") ? Response.json({ effective_role: "owner" }) : Response.json({ preferences: { enabled: { phone: true, email: true } } }));
    const identity = await ensureIdentity(f.env, scope);
    f.env.CREDENTIALS_WORKER = { fetch: vi.fn(async () => Response.json({ value: JSON.stringify({ apiKey: "test-api-key-123456", publicKey: btoa("x".repeat(32)), verifiedNumberId: "12345", verifiedPhoneNumber: number }) })) } as unknown as Fetcher;
    const provider = vi.fn(async () => Response.json({ data: { id: "12345", phone_number: number } }));
    vi.stubGlobal("fetch", provider);
    const result = await handlePhoneAction(f.env, scope, identity, "phone-telnyx-stage", { confirm: true }, true, false) as { phone: { provider: string; status: string }; transport_active: boolean };
    expect(result).toMatchObject({ phone: { provider: "telnyx", status: "configuring" }, transport_active: false });
    await expect(handlePhoneAction(f.env, scope, identity, "phone-telnyx-stage", { confirm: true }, true, false)).rejects.toThrow("assistant_phone_already_bound");
    await expect(handlePhoneAction(f.env, scope, identity, "phone-telnyx-cancel", { confirm: true }, true, false)).resolves.toMatchObject({ detached: true, rental_continues: true });
    expect(provider).toHaveBeenCalledTimes(1);
  });
  it("migrates existing bindings as Twilio and exposes their opaque provider identity", async () => {
    const f = await phoneFixture();
    const status = await f.act("phone-status") as { phone: { provider: string; provider_number_id: string } };
    expect(status.phone.provider).toBe("twilio");
    expect(status.phone.provider_number_id).toBe(pn);
  });
  it("never uses Twilio credentials or callbacks for a different carrier binding", async () => {
    const f = await phoneFixture();
    await f.db.prepare("UPDATE assistant_phone_bindings SET provider='telnyx' WHERE id=?").bind(f.binding.id).run();
    f.provider.mockClear();
    await expect(f.act("phone-detach", { confirm: true })).rejects.toThrow("assistant_phone_credentials_missing");
    await expect(detachAssistantPhonesForErasure(f.env, f.identity.id)).rejects.toThrow("phone_detachment_required_before_erasure");
    expect(f.provider).not.toHaveBeenCalled();
  });
  it("preserves Telnyx credentials while a Telnyx number is still attached", async () => {
    const f = await phoneFixture();
    await f.db.prepare("UPDATE assistant_phone_bindings SET provider='telnyx' WHERE id=?").bind(f.binding.id).run();
    await expect(f.act("phone-telnyx-remove", { confirm: true })).rejects.toThrow("detach_telnyx_before_changing_credentials");
    await expect(f.act("phone-telnyx-configure", {})).rejects.toThrow("detach_telnyx_before_changing_credentials");
  });
  it("keeps numbers optional and rejects invalid limits and transfer addresses", () => {
    expect(defaultPhonePolicy.voicemail).toBe(false);
    expect(defaultPhonePolicy.greeting).toBe("");
    for (const patch of [
      { maxCallSeconds: 0 },
      { maxDailyActions: 0 },
      { maxDailyInboundMessages: 1001 },
      { transferTo: "http://evil" },
      { voicemail: "yes" },
    ])
      expect(() =>
        validatePhonePolicy({ ...defaultPhonePolicy, ...patch })
      ).toThrow("invalid_phone_policy");
  });
  it("separates a provider failure from an unknown mutation and bounds responses", async () => {
    const fail = vi.fn(async () => {
      throw new Error("offline");
    });
    await expect(
      phoneProvider(creds, "Messages.json", "POST", new URLSearchParams(), fail)
    ).rejects.toMatchObject({ uncertain: true });
    await expect(
      phoneProvider(creds, "Messages.json", "GET", undefined, fail)
    ).rejects.toMatchObject({ uncertain: false });
    await expect(
      phoneProvider(
        creds,
        "Messages.json",
        "POST",
        new URLSearchParams(),
        async () => new Response("bad", { status: 400 })
      )
    ).rejects.toMatchObject({ uncertain: false });
    await expect(
      phoneProvider(
        creds,
        "Messages.json",
        "POST",
        new URLSearchParams(),
        async () => new Response("bad", { status: 503 })
      )
    ).rejects.toMatchObject({ uncertain: true });
    await expect(
      phoneProvider(
        creds,
        "Messages.json",
        "POST",
        new URLSearchParams(),
        async () => new Response("x".repeat(70000))
      )
    ).rejects.toMatchObject({ uncertain: true });
    await expect(
      phoneProvider(creds, "https://evil.example/", "GET")
    ).rejects.toThrow("invalid_phone_resource");
  });
  it("requires human approval and deduplicates concurrent sends", async () => {
    const f = await phoneFixture();
    const draft = (await f.act("phone-draft", {
      kind: "sms",
      to: other,
      text: "hello",
    })) as { id: string };
    await expect(
      f.act("phone-send", { id: draft.id }, true, true)
    ).rejects.toThrow("approval_required");
    await expect(
      f.act("phone-approve", { id: draft.id }, true, true)
    ).rejects.toThrow("human_control_required");
    await f.act("phone-approve", { id: draft.id });
    f.provider.mockImplementation(async () =>
      Response.json({ sid: "SM" + "d".repeat(32), account_sid: account })
    );
    const results = await Promise.allSettled(
      Array.from({ length: 30 }, () =>
        f.act("phone-send", { id: draft.id }, false, true)
      )
    );
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    expect(f.provider).toHaveBeenCalledTimes(3); // import read + attach + one send
    await f.act("phone-send", { id: draft.id }, false, true);
    expect(f.provider).toHaveBeenCalledTimes(3);
    expect([...f.objects.values()].join("")).not.toContain("hello");
  });
  it("holds uncertain actions and requires carrier reconciliation before another attempt", async () => {
    const f = await phoneFixture(),
      draft = (await f.act("phone-draft", {
        kind: "call",
        to: other,
        text: "test",
      })) as { id: string };
    await f.act("phone-approve", { id: draft.id });
    f.provider.mockRejectedValue(new Error("timeout"));
    await expect(f.act("phone-send", { id: draft.id })).rejects.toBeInstanceOf(
      PhoneProviderError
    );
    await expect(f.act("phone-send", { id: draft.id })).rejects.toThrow(
      "approval_required"
    );
    expect(
      (await f.db
        .prepare("SELECT status FROM assistant_phone_actions WHERE id=?")
        .bind(draft.id)
        .first<{ status: string }>())!.status
    ).toBe("indeterminate");
    await expect(
      f.act("phone-reconcile", {
        id: draft.id,
        provider_checked: true,
        outcome: "not_sent",
      })
    ).rejects.toThrow("wait_for_provider");
    await f.db
      .prepare(
        "UPDATE assistant_phone_actions SET updated_at=datetime('now','-3 minutes') WHERE id=?"
      )
      .bind(draft.id)
      .run();
    await f.act("phone-reconcile", {
      id: draft.id,
      provider_checked: true,
      outcome: "not_sent",
    });
    await expect(f.act("phone-send", { id: draft.id })).rejects.toThrow(
      "approval_required"
    );
  });
  it("restores callbacks before detaching, keeps billing visible, permits reattach with old history", async () => {
    const f = await phoneFixture();
    await f.act("phone-draft", {
      kind: "sms",
      to: other,
      text: "retained history",
    });
    const detached = await f.act("phone-detach", { confirm: true });
    expect(detached).toMatchObject({
      status: "detached",
      rental_continues: true,
    });
    const form = f.provider.mock.calls.at(-1)![1]!.body as URLSearchParams;
    expect(form.get("VoiceUrl")).toBe("https://old.example.com/voice");
    await f.act("phone-import", { number_sid: pn, confirm: true });
    expect(
      (await f.db
        .prepare("SELECT COUNT(*) n FROM assistant_phone_bindings")
        .first<{ n: number }>())!.n
    ).toBe(2);
  });
  it("deletes phone references only after provider detachment on account erasure", async () => {
    const f = await phoneFixture();
    await f.act("phone-draft", { kind: "sms", to: other, text: "to erase" });
    await detachAssistantPhonesForErasure(f.env, f.identity.id);
    expect(
      (await f.db
        .prepare("SELECT COUNT(*) n FROM assistant_phone_bindings")
        .first<{ n: number }>())!.n
    ).toBe(0);
    expect(f.provider.mock.calls.at(-1)![1]!.method).toBe("POST"); // never release BYO on erase
  });
  it("rejects other assistant scopes and GET mutations through the authenticated route", async () => {
    const f = await phoneFixture(),
      app = new Hono<{ Bindings: AgentsEnv }>();
    registerCommunicationRoutes(app);
    const headers = {
      "x-naelao-tenant-id": "tenant",
      "x-naelao-user-id": "user",
      "x-naelao-role": "product_end_user",
      "x-naelao-internal-token": await mintInternalToken("secret", "tenant"),
    };
    expect(
      (
        await app.request(
          "/spaces/space/assistant-communications?action=phone-send&id=x",
          { headers },
          f.env
        )
      ).status
    ).toBe(405);
    const r = await app.request(
      "/internal/assistant-communications",
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          spaceId: "space",
          action: "phone-policy",
          policy: defaultPhonePolicy,
        }),
      },
      f.env
    );
    expect(r.status).toBe(403);
    const stranger = await app.request(
      "/spaces/space/assistant-communications?action=phone-status",
      { headers: { ...headers, "x-naelao-user-id": "other" } },
      f.env
    );
    expect(((await stranger.json()) as { phone: unknown }).phone).toBeNull();
  });
  it("fails closed when channel, membership or egress policy changes", async () => {
    const f = await phoneFixture(),
      draft = (await f.act("phone-draft", {
        kind: "sms",
        to: other,
        text: "test",
      })) as { id: string };
    await f.act("phone-approve", { id: draft.id });
    f.fetch.mockResolvedValue(
      Response.json({ preferences: { enabled: { phone: false } } })
    );
    await expect(f.act("phone-send", { id: draft.id })).rejects.toThrow(
      "disabled_or_forbidden"
    );
    expect(f.provider).toHaveBeenCalledTimes(2);
  });
  it("authenticates callbacks, bounds ingress, deduplicates SMS, never trusts caller ID as owner authority", async () => {
    const f = await phoneFixture(),
      app = new Hono<{ Bindings: AgentsEnv }>();
    registerPhoneWebhooks(app);
    await f.db
      .prepare(
        "INSERT INTO assistant_communication_controllers(identity_id,user_id,channel,address,verified_at) VALUES(?,'user','phone',?,datetime('now'))"
      )
      .bind(f.identity.id, other)
      .run();
    const sid = "SM" + "e".repeat(32),
      path = `/assistant-phone/twilio/${f.binding.id}/sms`;
    const params = {
      AccountSid: account,
      MessageSid: sid,
      From: other,
      To: number,
      Body: "owner task",
      NumMedia: "0",
    };
    const body = new URLSearchParams(params).toString(),
      signature = getExpectedTwilioSignature(
        token,
        "https://phone.example.com" + path,
        params
      );
    const invoke = (sig = signature) =>
      app.request(
        path,
        {
          method: "POST",
          headers: {
            "x-twilio-signature": sig,
            "content-type": "application/x-www-form-urlencoded",
          },
          body,
        },
        f.env
      );
    expect((await invoke("wrong")).status).toBe(403);
    await Promise.all(Array.from({ length: 20 }, () => invoke()));
    expect(
      (await f.db
        .prepare("SELECT COUNT(*) n FROM assistant_phone_events")
        .first<{ n: number }>())!.n
    ).toBe(1);
    expect(
      (await f.db
        .prepare("SELECT COUNT(*) n FROM assistant_communication_commands")
        .first<{ n: number }>())!.n
    ).toBe(1);
    expect(f.env.AGENTS_WORKER.fetch).not.toHaveBeenCalled();
    const event = await f.db
      .prepare("SELECT body_key FROM assistant_phone_events WHERE id=?")
      .bind(sid)
      .first<{ body_key: string }>();
    expect(
      await readBody(f.env, f.identity, sid, event!.body_key)
    ).toMatchObject({ text: "owner task", untrusted: true });
  });
  it("only buys a number after an exact current quote is confirmed, under racing requests", async () => {
    const f = await phoneFixture();
    await f.act("phone-detach", { confirm: true });
    f.provider.mockImplementation(async (url, init) => {
      const u = String(url);
      if (u.includes("AvailablePhoneNumbers"))
        return Response.json({
          available_phone_numbers: [
            {
              phone_number: number,
              capabilities: { voice: true, sms: true, mms: true },
            },
          ],
        });
      if (u.includes("/v2/Voice/Numbers/"))
        return Response.json({
          price_unit: "USD",
          inbound_call_price: { number_type: "local", current_price: "0.0085" },
        });
      if (u.includes("/v1/PhoneNumbers/"))
        return Response.json({
          price_unit: "USD",
          phone_number_prices: [
            { number_type: "local", current_price: "1.15" },
          ],
        });
      return Response.json({
        sid: pn,
        account_sid: account,
        phone_number: number,
        capabilities: { voice: true, sms: true, mms: true },
      });
    });
    const q = (await f.act("phone-quote", {
      phone_number: number,
      country: "US",
    })) as { quote_id: string; monthly_cost_minor: number };
    await expect(
      f.act("phone-purchase", {
        quote_id: q.quote_id,
        confirm: true,
        confirm_monthly_cost_minor: q.monthly_cost_minor + 1,
      })
    ).rejects.toThrow("price_not_confirmed");
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        f.act("phone-purchase", {
          quote_id: q.quote_id,
          confirm: true,
          confirm_monthly_cost_minor: q.monthly_cost_minor,
        })
      )
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const buys = f.provider.mock.calls.filter(
      ([u, i]) =>
        String(u).endsWith("/IncomingPhoneNumbers.json") && i?.method === "POST"
    );
    expect(buys).toHaveLength(1);
  });
  it("paginates tied timestamps without dropping or repeating incoming events", async () => {
    const f = await phoneFixture();
    for (let i = 0; i < 130; i++)
      await f.db
        .prepare(
          "INSERT INTO assistant_phone_events(id,binding_id,kind,sender,status,created_at) VALUES(?,?,'sms','caller','received','2026-10-01 12:00:00')"
        )
        .bind(String(i).padStart(3, "0"), f.binding.id)
        .run();
    const ids: string[] = [];
    let before: string | undefined;
    do {
      const p = (await f.act("phone-events", before ? { before } : {})) as {
        data: Array<{ id: string }>;
        next_cursor: string | null;
      };
      ids.push(...p.data.map((x) => x.id));
      before = p.next_cursor ?? undefined;
    } while (before);
    expect(new Set(ids).size).toBe(130);
    expect(ids).toHaveLength(130);
  });
  it("serializes SMS verification per number, privately delivers a code and never treats it as an owner command", async () => {
    const f = await phoneFixture(),
      app = new Hono<{ Bindings: AgentsEnv }>();
    registerCommunicationRoutes(app);
    registerPhoneWebhooks(app);
    f.db.db.exec(
      "CREATE TABLE website_connections(id TEXT,tenant_id TEXT,space_id TEXT,owner_user_id TEXT,project_id TEXT,origins_json TEXT,status TEXT); INSERT INTO website_connections VALUES('website','tenant','space','user',NULL,'[\"https://example.com\"]','active'); INSERT INTO website_connections VALUES('website2','tenant','space','user',NULL,'[\"https://elsewhere.com\"]','active');"
    );
    const headers = {
      "content-type": "application/json",
      "x-naelao-tenant-id": "tenant",
      "x-naelao-user-id": "user",
      "x-naelao-role": "product_end_user",
      "x-naelao-internal-token": await mintInternalToken("secret", "tenant"),
    };
    const begin = (connection = "website") =>
      app.request(
        "/internal/assistant-communications",
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            spaceId: "space",
            action: "verification-begin",
            transport: "sms",
            kind: "code",
            connection_id: connection,
            run_id: "run",
            sender_addresses: [other],
          }),
        },
        f.env
      );
    expect((await begin()).status).toBe(403);
    await f.act("phone-policy", {
      policy: { ...defaultPhonePolicy, allowWebsiteVerification: true },
    });
    const first = await begin();
    expect(first.status).toBe(201);
    const wait = (await first.json()) as { id: string; phone_number: string };
    expect(wait.phone_number).toBe(number);
    expect((await begin("website2")).status).toBe(409);
    await f.db
      .prepare(
        "INSERT INTO assistant_communication_controllers(identity_id,user_id,channel,address,verified_at) VALUES(?,'user','phone',?,datetime('now'))"
      )
      .bind(f.identity.id, other)
      .run();
    const sid = "SM" + "f".repeat(32),
      path = `/assistant-phone/twilio/${f.binding.id}/sms`,
      params = {
        AccountSid: account,
        MessageSid: sid,
        From: other,
        To: number,
        Body: "Your verification code is 654321",
        NumMedia: "0",
      };
    const signature = getExpectedTwilioSignature(
      token,
      "https://phone.example.com" + path,
      params
    );
    expect(
      (
        await app.request(
          path,
          {
            method: "POST",
            headers: {
              "x-twilio-signature": signature,
              "content-type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams(params).toString(),
          },
          f.env
        )
      ).status
    ).toBe(200);
    const visible = await f.act("phone-event", { id: sid }, false, true);
    expect(JSON.stringify(visible)).not.toContain("654321");
    expect(JSON.stringify(await f.act("phone-event", { id: sid }))).toContain(
      "654321"
    );
    expect(
      (await f.db
        .prepare("SELECT COUNT(*) n FROM assistant_communication_commands")
        .first<{ n: number }>())!.n
    ).toBe(0);
    const { consumeVerification } = await import("./verification.js");
    const browser = {
      tenantId: "tenant",
      spaceId: "space",
      actorId: "user",
      agentId: "worker",
      runId: "run",
      sessionId: "browser",
      connectionId: "website",
      expiresAt: Date.now() + 60000,
      maxTier: 5 as const,
      authorizedOrigins: ["https://example.com"],
      authorizedActions: ["type" as const],
    };
    await expect(
      consumeVerification(
        f.env,
        { ...browser, connectionId: "website2" },
        wait.id,
        "action",
        "code"
      )
    ).rejects.toThrow();
    expect(
      await consumeVerification(f.env, browser, wait.id, "action", "code")
    ).toBe("654321");
    await expect(
      consumeVerification(f.env, browser, wait.id, "again", "code")
    ).rejects.toThrow();
    expect([...f.objects.values()].join("")).not.toContain("654321");
  });
  it("withholds code-like SMS from workers even without an active verification wait", async () => {
    const f = await phoneFixture(),
      app = new Hono<{ Bindings: AgentsEnv }>();
    registerPhoneWebhooks(app);
    const sid = "SM" + "1".repeat(32),
      path = `/assistant-phone/twilio/${f.binding.id}/sms`,
      params = {
        AccountSid: account,
        MessageSid: sid,
        From: other,
        To: number,
        Body: "Login code: 123456",
        NumMedia: "0",
      };
    const signature = getExpectedTwilioSignature(
      token,
      "https://phone.example.com" + path,
      params
    );
    await app.request(
      path,
      {
        method: "POST",
        headers: {
          "x-twilio-signature": signature,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(params).toString(),
      },
      f.env
    );
    expect(
      JSON.stringify(await f.act("phone-event", { id: sid }, false, true))
    ).not.toContain("123456");
    expect(JSON.stringify(await f.act("phone-event", { id: sid }))).toContain(
      "123456"
    );
  });
 it('prunes old private phone drafts while retaining uncertain carrier operations',async()=>{
  const f=await phoneFixture();
  const old=await f.act('phone-draft',{kind:'sms',to:other,text:'old'}) as {id:string};
  const held=await f.act('phone-draft',{kind:'sms',to:other,text:'held'}) as {id:string};
  await f.db.prepare("UPDATE assistant_phone_actions SET created_at=datetime('now','-31 days')").run();
  await f.db.prepare("UPDATE assistant_phone_actions SET status='indeterminate' WHERE id=?").bind(held.id).run();
  const remove=vi.fn(async()=>undefined);Object.assign(f.env.SCRIPTS_R2!,{delete:remove});
  const {sweepAssistantPhoneHistory}=await import('./phone-lifecycle.js');await sweepAssistantPhoneHistory(f.env);
  expect(await f.db.prepare('SELECT id FROM assistant_phone_actions WHERE id=?').bind(old.id).first()).toBeNull();
  expect(await f.db.prepare('SELECT id FROM assistant_phone_actions WHERE id=?').bind(held.id).first()).not.toBeNull();
  expect(remove).toHaveBeenCalledTimes(1);
 });

 it("requires the app-issued code before connecting a live call to the planner transport",async()=>{
  const f=await phoneFixture();
  const original=f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation(async(r:Request)=>r.url.includes("/sessions/")?Response.json({id:"session"}):original(r));
  await expect(f.act("phone-live",{confirm:true,session_id:"session"},true,true)).rejects.toThrow("human_control_required");
  const armed=await f.act("phone-live",{confirm:true,session_id:"session"}) as {code:string};
  const app=new Hono<{Bindings:AgentsEnv}>();registerPhoneWebhooks(app);
  const sid="CA"+"d".repeat(32);
  const invoke=async(event:string,digits?:string,signature=true)=>{
    const path=`/assistant-phone/twilio/${f.binding.id}/${event}`;
    const params={AccountSid:account,CallSid:sid,From:other,To:number,...digits?{Digits:digits}:{}};
    return app.request(path,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded","x-twilio-signature":signature?getExpectedTwilioSignature(token,"https://phone.example.com"+path,params):"wrong"},body:new URLSearchParams(params).toString()},f.env);
  };
  expect((await invoke("answer",undefined,false)).status).toBe(403);
  expect(await (await invoke("answer")).text()).toContain("one-time call code");
  expect((await invoke("live-code","not-code")).status).toBe(403);
  const joined=await invoke("live-code",armed.code);
  expect(joined.status).toBe(200);
  expect(await joined.text()).toContain('<Connect><Stream url="wss://phone.example.com/assistant-phone/live-stream/phone-');
  expect((await invoke("live-code",armed.code)).status).toBe(200);
  const rows=await f.db.prepare("SELECT * FROM assistant_live_calls").all();
  expect(rows.results).toHaveLength(1);
  expect(rows.results[0]).toMatchObject({status:"connected",call_sid:sid,session_id:"session"});
  await f.act("phone-live-end",{confirm:true});
  expect((await invoke("live-code",armed.code)).status).toBe(403);
 });

 it("separates public extension lines from the internal assistant number",async()=>{
  const f=await phoneFixture();f.env.AGENTS_WORKER={fetch:vi.fn(async()=>Response.json({valid:true}))} as unknown as Fetcher;
  await f.act("phone-handler",{installation_id:"extension",handler_sha256:"a".repeat(64),confirm:true});
  const status=await f.act("phone-status") as {phone:unknown;extension_lines:unknown[]};
  expect(status.phone).toBeNull();expect(status.extension_lines).toHaveLength(1);
  await expect(f.act("phone-live",{session_id:"session",confirm:true})).rejects.toThrow("assistant_phone_not_connected");
  await expect(f.act("phone-credentials",{account_sid:account,auth_token:token})).rejects.toThrow("detach_phone_before_changing_credentials");
  await f.act("phone-detach",{binding_id:f.binding.id,confirm:true});
  expect((await f.act("phone-status") as {extension_lines:unknown[]}).extension_lines).toHaveLength(0);
 });

 it("runs an owner-only text simulation for the exact active extension without carrier egress", async () => {
  const f = await phoneFixture();
  const requests: Array<Record<string, unknown>> = [];
  const dispatch = vi.fn(async (request: Request) => {
   const body = await request.json() as Record<string, unknown>;
   requests.push(body);
   if (new URL(request.url).pathname === "/internal/phone-extension-test")
    return Response.json({ simulation: true, response: { actions: [{ type: "say", text: "Simulated answer" }] } });
   return Response.json({ valid: body.validateOnly === true });
  });
  f.env.AGENTS_WORKER = { fetch: dispatch } as unknown as Fetcher;
  await f.act("phone-handler", { installation_id: "extension", handler_sha256: "a".repeat(64), confirm: true });
  dispatch.mockClear();
  requests.length = 0;
  f.provider.mockClear();

  await expect(f.act("phone-handler-test", { binding_id: f.binding.id, input: "Where is order 42?" }))
   .resolves.toEqual({ simulation: true, response: { actions: [{ type: "say", text: "Simulated answer" }] } });
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(requests).toMatchObject([{ bindingId: f.binding.id, spaceId: "space", eventType: "call.speech", input: "Where is order 42?" }]);
  expect(f.provider).not.toHaveBeenCalled();
  await expect(f.act("phone-handler-test", { binding_id: f.binding.id, input: "simulate" }, false, false)).rejects.toThrow("human_control_required");
  await expect(f.act("phone-handler-test", { binding_id: f.binding.id, input: "x".repeat(2_001) })).rejects.toThrow("phone_simulation_input_invalid");
  expect(dispatch).toHaveBeenCalledTimes(1);
 });

 it("validates owner keypad simulations and forwards only normalized DTMF test events", async () => {
  const f = await phoneFixture();
  const dispatch = vi.fn(async (request: Request) => new URL(request.url).pathname === "/internal/phone-extension-test"
    ? Response.json({ simulation: true, event: await request.json() })
    : Response.json({ valid: true }));
  f.env.AGENTS_WORKER = { fetch: dispatch } as unknown as Fetcher;
  await f.act("phone-handler", { installation_id: "extension", handler_sha256: "a".repeat(64), confirm: true });
  dispatch.mockClear();
  f.provider.mockClear();

  await expect(f.act("phone-handler-test", { binding_id: f.binding.id, event_type: "call.received" }))
    .resolves.toMatchObject({ simulation: true, event: { eventType: "call.received" } });
  await expect(f.act("phone-handler-test", { binding_id: f.binding.id, event_type: "call.digits", digits: "1" }))
    .resolves.toMatchObject({ simulation: true, event: { eventType: "call.digits", digits: "1" } });
  expect(dispatch).toHaveBeenCalledTimes(2);
  expect(f.provider).not.toHaveBeenCalled();
  await expect(f.act("phone-handler-test", { binding_id: f.binding.id, event_type: "call.digits", digits: "1#" }))
    .rejects.toThrow("phone_simulation_input_invalid");
  await expect(f.act("phone-handler-test", { binding_id: f.binding.id, event_type: "call.received", input: "unexpected" }))
    .rejects.toThrow("phone_simulation_input_invalid");
  await expect(f.act("phone-handler-test", { binding_id: f.binding.id, event_type: "call.speech", input: "hello" }, false, false))
    .rejects.toThrow("human_control_required");
  expect(dispatch).toHaveBeenCalledTimes(2);
 });

 it("shows owner-scoped Telnyx call-cost summaries without exposing provider call IDs",async()=>{
  const f=await phoneFixture();f.env.AGENTS_WORKER={fetch:vi.fn(async()=>Response.json({valid:true}))} as unknown as Fetcher;
  await f.act("phone-handler",{installation_id:"extension",handler_sha256:"a".repeat(64),confirm:true});
  const now=Math.floor(Date.now()/1000);
  await f.db.prepare("UPDATE assistant_phone_bindings SET provider='telnyx' WHERE id=?").bind(f.binding.id).run();
  await f.db.prepare(`INSERT INTO assistant_telnyx_extension_calls(call_control_id,binding_id,caller,state,turn_count,started_at,
    expires_at,duration_seconds,created_at,updated_at,extension_installation_id,handler_sha256) VALUES(?,?,?,'ended',2,?,?,25,?,?,?,?)`)
    .bind("provider-call-control-private",f.binding.id,"+14155550199",now-30,now+300,now-30,now,"extension","a".repeat(64)).run();
  await f.db.prepare(`INSERT INTO assistant_telnyx_extension_calls(call_control_id,binding_id,caller,state,turn_count,started_at,
    expires_at,duration_seconds,created_at,updated_at,extension_installation_id,handler_sha256) VALUES(?,?,?,'ended',1,?,?,10,?,?,?,?)`)
    .bind("provider-call-control-mixed",f.binding.id,"+14155550188",now-40,now+300,now-40,now,"extension","a".repeat(64)).run();
  await f.db.prepare(`INSERT INTO assistant_telnyx_extension_calls(call_control_id,binding_id,caller,state,turn_count,started_at,
    expires_at,duration_seconds,created_at,updated_at,extension_installation_id,handler_sha256) VALUES(?,?,?,'ended',1,?,?,5,?,?,?,?)`)
    .bind("provider-call-control-no-report",f.binding.id,"+14155550177",now-50,now+300,now-50,now,null,null).run();
  const addReceipt = async (callControlId:string,legHash:string,currency:string,cost:number,eventHash:string) => {
    await f.db.prepare(`INSERT INTO assistant_telnyx_voice_cost_receipts(binding_id,call_leg_id_sha256,call_session_id_sha256,
      first_event_id_sha256,provider_cost_micros,currency,billed_duration_seconds,occurred_at,cost_evidence_sha256,observed_at,call_control_id_sha256)
      VALUES(?,?,NULL,?,?,?,NULL,?,?,?,?)`)
      .bind(f.binding.id,legHash,eventHash,cost,currency,new Date().toISOString(),"f".repeat(64),new Date().toISOString(),
        await telnyxCallControlIdHash(f.binding.id,callControlId)).run();
  };
  await addReceipt("provider-call-control-private","1".repeat(64),"USD",10_600,"a".repeat(64));
  await addReceipt("provider-call-control-private","2".repeat(64),"USD",200,"b".repeat(64));
  await addReceipt("provider-call-control-mixed","3".repeat(64),"USD",800,"c".repeat(64));
  await addReceipt("provider-call-control-mixed","4".repeat(64),"EUR",100,"d".repeat(64));
  const status=await f.act("phone-status") as {recent_telnyx_extension_calls:Array<Record<string,unknown>>};
  expect(status.recent_telnyx_extension_calls).toEqual([
    expect.objectContaining({installation_id:"extension",handler_sha256:"a".repeat(64),state:"ended",turn_count:2,started_at:now-30,duration_seconds:25,caller_hint:"•••• 0199",
      cost_report:{status:"reported",provider_cost_micros:10_800,currency:"USD",leg_count:2}}),
    expect.objectContaining({cost_report:{status:"unavailable",provider_cost_micros:null,currency:null,leg_count:null}}),
    expect.objectContaining({installation_id:null,handler_sha256:null,cost_report:{status:"not_linked",provider_cost_micros:null,currency:null,leg_count:null}}),
  ]);
  expect(JSON.stringify(status)).not.toContain("provider-call-control-private");
  expect(JSON.stringify(status)).not.toContain("provider-call-control-mixed");
  expect(JSON.stringify(status)).not.toContain("+14155550199");
  const nonManager=await f.act("phone-status",{},false,false) as {recent_telnyx_extension_calls:unknown[]};
  expect(nonManager.recent_telnyx_extension_calls).toEqual([]);
 });

 it("offers only active signed phone handlers with matching package and source bytes", async () => {
  const f = await phoneFixture();
  const source = "export default async function handle() { return { reply: 'ok' }; }";
  const sha256 = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, "0")).join("");
  let releaseArtifactSha256 = await sha256(JSON.stringify([["./handler.ts", source]]));
  f.env.SPACES_WORKER = { fetch: vi.fn(async (request: Request) => {
    const pathname = new URL(request.url).pathname;
    if (pathname.endsWith("/internal/channel-installations")) return Response.json({ installations: [
      { instance_id: "phone-install", extension_id: "ext_phone", name: "Phone assistant", status: "active", scope: "SPACE_SHARED", channels: [{ provider: "phone" }] },
    ] });
    if (pathname.endsWith("/workflow-installations/phone-install")) return Response.json({
      instance: { instance_id: "phone-install", tenant_id: "tenant", space_id: "space", project_id: null, scope: "SPACE_SHARED", status: "active" },
      manifest: { id: "ext_phone", bundle: { id: "ext_phone", version: "1.0.0" }, channels: [{ kind: "channel", provider: "phone", context: "channel_only",
        handlerScript: "./handler.ts", inboundEvents: ["message.received", "call.received"], outboundEvents: ["message.reply", "voice.reply"], permissions: [], capabilityRequirements: [], knowledgeCollections: [] }] },
      release: { version: "1.0.0", artifactSha256: releaseArtifactSha256, signatureValid: true },
    });
    return Response.json({ preferences: { enabled: { email: true, phone: true } } });
  }) } as unknown as Fetcher;
  const prefix = "spaces/space/extensions/ext_phone/1.0.0/";
  f.env.SCRIPTS_R2 = {
    list: vi.fn(async () => ({ objects: [{ key: prefix + "handler.ts", size: new TextEncoder().encode(source).byteLength }], truncated: false })),
    get: vi.fn(async key => key === prefix + "handler.ts" ? { size: new TextEncoder().encode(source).byteLength,
      text: async () => source, arrayBuffer: async () => new TextEncoder().encode(source).buffer } : null),
  } as unknown as R2Bucket;

  const available = await f.act("phone-status") as { phone_handler_candidates: Array<{ installation_id: string; handler_sha256: string }> };
  expect(available.phone_handler_candidates).toEqual([{ installation_id: "phone-install", extension_id: "ext_phone", name: "Phone assistant", version: "1.0.0", handler_sha256: await sha256(source) }]);
  releaseArtifactSha256 = "f".repeat(64);
  const tampered = await f.act("phone-status") as { phone_handler_candidates: unknown[] };
  expect(tampered.phone_handler_candidates).toEqual([]);
 });

 it("keeps owner extension assignment available when Space Assistant phone is disabled", async () => {
  const f = await phoneFixture();
  f.fetch.mockImplementation(async (request: Request) => request.url.includes("assistant-access")
    ? Response.json({ effective_role: "owner" })
    : Response.json({ preferences: { enabled: { email: true, phone: false } } }));
  f.env.AGENTS_WORKER = { fetch: vi.fn(async () => Response.json({ valid: true })) } as unknown as Fetcher;

  await f.act("phone-handler", {
    installation_id: "extension",
    handler_sha256: "a".repeat(64),
    confirm: true,
  });

  const status = await f.act("phone-status") as {
    enabled: boolean;
    phone: unknown;
    extension_lines: Array<{ handler_status: string }>;
  };
  expect(status.enabled).toBe(false);
  expect(status.phone).toBeNull();
  expect(status.extension_lines).toMatchObject([{ handler_status: "active" }]);
 });

 it("migrates a retired customer voice number while Space Assistant phone is disabled", async () => {
  const f = await phoneFixture();
  await f.db.prepare("UPDATE assistant_phone_bindings SET status='detached' WHERE id=?").bind(f.binding.id).run();
  const now = new Date().toISOString();
  await f.db.prepare(`INSERT INTO customer_voice_number_bindings
    (id,provider,provider_account_sid,provider_number_sid,tenant_id,space_id,agent_id,phone_number,country_code,
     monthly_cost_minor,currency,monthly_quote_at,inbound_price_per_minute_minor,created_by,created_at,updated_at)
    VALUES ('legacy-line','twilio',?,?, 'tenant','space','legacy-agent',?,'US',100,'USD',?,0,'user',?,?)`)
    .bind(account, pn, number, now, now, now).run();
  f.fetch.mockImplementation(async (request: Request) => request.url.includes("assistant-access")
    ? Response.json({ effective_role: "owner" })
    : Response.json({ preferences: { enabled: { email: true, phone: false } } }));

  const result = await f.act("phone-import", {
    number_sid: pn,
    legacy_binding_id: "legacy-line",
    confirm: true,
  }) as { legacy_migrated: boolean };

  expect(result.legacy_migrated).toBe(true);
  expect(await f.db.prepare("SELECT status FROM customer_voice_number_bindings WHERE id='legacy-line'").first())
    .toMatchObject({ status: "disabled" });
  expect(await f.db.prepare("SELECT purpose,status FROM assistant_phone_bindings WHERE provider_number_sid=? AND status='active'")
    .bind(pn).first()).toMatchObject({ purpose: "extension", status: "active" });
 });

 it("keeps public extension voice turn-by-turn and returns only host-rendered actions", async () => {
  const f = await phoneFixture();
  const dispatchedRequests: Request[] = [];
  const dispatch = vi.fn(async (request: Request) => {
   dispatchedRequests.push(request.clone());
   const body = await request.json() as { validateOnly?: boolean; event?: { type: string; payload: Record<string, unknown> } };
   if (body.validateOnly) return Response.json({ valid: true });
   if (body.event?.type === "call.received")
    return Response.json({ response: { actions: [
     { type: "say", text: "Welcome to the extension." },
     { type: "gather", input: "speech", text: "How can I help?" },
    ] } });
   return Response.json({ response: { actions: [
    { type: "say", text: `I heard: ${String(body.event?.payload.speech ?? "")}` },
    { type: "hangup" },
   ] } });
  });
  f.env.AGENTS_WORKER = { fetch: dispatch } as unknown as Fetcher;
  await f.act("phone-handler", { installation_id: "extension", handler_sha256: "a".repeat(64), confirm: true });
  await f.db.prepare("UPDATE assistant_phone_bindings SET policy_json=? WHERE id=?")
   .bind(JSON.stringify({ ...defaultPhonePolicy, allowSpeechInput: true }), f.binding.id).run();

  const app = new Hono<{ Bindings: AgentsEnv }>();
  registerPhoneWebhooks(app);
  const sid = "CA" + "e".repeat(32);
  const invoke = async (event: "answer" | "menu", extra: Record<string, string> = {}) => {
   const path = `/assistant-phone/twilio/${f.binding.id}/${event}`;
   const params = { AccountSid: account, CallSid: sid, From: other, To: number, ...extra };
   return app.request(path, {
    method: "POST",
    headers: {
     "content-type": "application/x-www-form-urlencoded",
     "x-twilio-signature": getExpectedTwilioSignature(token, `https://phone.example.com${path}`, params),
    },
    body: new URLSearchParams(params).toString(),
   }, f.env);
  };

  const first = await invoke("answer");
  expect(first.status).toBe(200);
  const firstXml = await first.text();
  expect(firstXml).toContain("Welcome to the extension.");
  expect(firstXml).toContain('<Gather input="speech"');
  expect(firstXml).toContain("/assistant-phone/twilio/");
  const next = await invoke("menu", { SpeechResult: "Check my order", Confidence: "0.91" });
  expect(next.status).toBe(200);
  expect(await next.text()).toContain("I heard: Check my order");
  const dispatched = dispatchedRequests
   .filter((request) => request.url.endsWith("/phone-extension-dispatch"));
  expect(dispatched).toHaveLength(3); // validation plus two voice turns
  const voiceEvents: string[] = [];
  for (const request of dispatched.slice(1)) {
   const body = await request.clone().json() as { event: { type: string; payload: Record<string, unknown> } };
   voiceEvents.push(body.event.type);
  }
  expect(voiceEvents).toEqual(["call.received", "call.speech"]);
  expect((await dispatched[2]!.clone().json() as { event: { payload: Record<string, unknown> } }).event.payload).toMatchObject({ speech: "Check my order", confidence: 0.91 });
 });

});
