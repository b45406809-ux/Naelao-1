import { afterEach,describe,expect,it,vi } from "vitest";
import { connectUserAgentMail,callAgentMailTool,provisionManagedAgentMail,getAssistantAgentMailStatus,receiveAgentPortNotification } from "./agentmail.js";
import { ensureIdentity } from "./core.js";
import { fixture,scope } from "../../../../tests/fixtures/assistant-communications.js";

describe("AgentMail provider account boundary",()=>{
  afterEach(()=>vi.unstubAllGlobals());
  it("validates and encrypts a user connected scoped inbox credential, then authorizes provider reads",async()=>{
    const f=fixture();
    const identity=await ensureIdentity(f.env,scope);
    const providerFetch=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
      const request=new Request(input,init);
      if(new URL(request.url).pathname.endsWith("/inboxes/inbox-1"))return Response.json({inbox_id:"inbox-1",email:"assistant@example.test"});
      if(new URL(request.url).pathname.endsWith("/webhooks"))return Response.json({webhook_id:"agentmail-hook",secret:"whsec_dGVzdA=="});
      if(new URL(request.url).pathname.endsWith("/messages"))return Response.json({messages:[{message_id:"message-1",text:"provider content"}]});
      return Response.json({error:"not_found"},{status:404});
    });
    vi.stubGlobal("fetch",providerFetch);
    const connected=await connectUserAgentMail(f.env,scope,identity,{inboxId:"inbox-1",apiKey:"agentmail-scoped-secret-123456"});
    expect(connected).toMatchObject({address:"assistant@example.test",status:"active",mode:"user_connected",accountId:"ap_account"});
    expect(connected.agentId).toMatch(/^naelao_[a-f0-9]{64}$/);
    const stored=await f.db.prepare("SELECT credential_ciphertext,credential_iv,status FROM assistant_agentmail_accounts WHERE id=?").bind(connected.connectionId).first<{credential_ciphertext:string;credential_iv:string;status:string}>();
    expect(stored?.status).toBe("active");
    expect(stored?.credential_ciphertext).not.toContain("agentmail-scoped-secret-123456");
    expect(await getAssistantAgentMailStatus(f.env,scope)).toMatchObject({connections:[{receivedMessages:0,sentMessages:0,activity30d:"idle"}]});
    const response=await callAgentMailTool(f.env,scope,"agentmail.inbox",{limit:10});
    expect(response).toEqual({messages:[{message_id:"message-1",text:"provider content"}]});
    const call=providerFetch.mock.calls.at(-1)!;
    expect(new Headers(call[1]?.headers).get("authorization")).toBe("Bearer agentmail-scoped-secret-123456");
    expect(f.env.AGENTPORT_WORKER.fetch).toHaveBeenCalledWith(expect.objectContaining({url:expect.stringContaining("/access/check")}));
    const notification={id:"event-1",deliveryId:"delivery-1",subscriptionId:"ap_subscription",agentId:connected.agentId,serviceId:"agentmail:tenant",accountId:"ap_account",type:"message.received",threadRef:"provider-thread-1",dataRef:"provider-message-1"};
    const raw=JSON.stringify(notification),timestamp=String(Math.floor(Date.now()/1000)),key=await crypto.subtle.importKey("raw",new TextEncoder().encode("agentport-event-webhook-secret"),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
    const signed=new Uint8Array(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(`${timestamp}\n${raw}`)));
    const signature=`v1=${btoa(String.fromCharCode(...signed)).replaceAll("+","-").replaceAll("/","_").replace(/=+$/g,"")}`;
    const eventResponse=await receiveAgentPortNotification(f.env,connected.connectionId,new Request("https://api.example.test/event",{method:"POST",headers:{"x-agentport-timestamp":timestamp,"x-agentport-signature":signature},body:raw}));
    expect(eventResponse.status).toBe(204);
    expect(f.env.CHANNEL_SESSIONS?.send).toHaveBeenCalledWith(expect.objectContaining({type:"provider_event_reference",deliveryId:"delivery-1",threadRef:"provider-thread-1",dataRef:"provider-message-1"}));
    expect(await f.db.prepare("SELECT status FROM assistant_agentport_event_receipts WHERE delivery_id='delivery-1'").first<{status:string}>()).toMatchObject({status:"queued"});
  });
  it("rejects mismatched inbox credentials before storing them",async()=>{
    const f=fixture();
    vi.stubGlobal("fetch",vi.fn(async()=>Response.json({inbox_id:"another-inbox",email:"other@example.test"})));
    const identity=await ensureIdentity(f.env,scope);
    await expect(connectUserAgentMail(f.env,scope,identity,{inboxId:"inbox-1",apiKey:"agentmail-scoped-secret-123456"})).rejects.toThrow("agentmail_inbox_mismatch");
    expect(await f.db.prepare("SELECT COUNT(*) AS n FROM assistant_agentmail_accounts").first<{n:number}>()).toMatchObject({n:0});
  });
  it("provisions one managed inbox per distinct assistant and charges 300 credits once",async()=>{
    const f=fixture();const identity=await ensureIdentity(f.env,scope);const billing=vi.fn(async(request:Request)=>Response.json({reserved:true,settled:true}));
    (f.env as unknown as {AGENTMAIL_API_KEY:string;AGENTMAIL_DEFAULT_DOMAIN:string;BILLING_WORKER:{fetch:typeof billing}}).AGENTMAIL_API_KEY="managed-provider-key";
    (f.env as unknown as {AGENTMAIL_DEFAULT_DOMAIN:string}).AGENTMAIL_DEFAULT_DOMAIN="mail.example.test";
    (f.env as unknown as {BILLING_WORKER:{fetch:typeof billing}}).BILLING_WORKER={fetch:billing};
    const providerFetch=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
      const request=new Request(input,init),url=new URL(request.url);
      if(url.pathname==="/v0/pods")return Response.json({pod_id:"pod-1"});
      if(url.pathname==="/v0/pods/pod-1/inboxes")return Response.json({inbox_id:"managed-inbox",email:"assistant@mail.example.test"});
      if(url.pathname.endsWith("/webhooks"))return Response.json({webhook_id:"managed-hook",secret:"whsec_dGVzdA=="});
      return Response.json({error:"not_found"},{status:404});
    });vi.stubGlobal("fetch",providerFetch);
    const first=await provisionManagedAgentMail(f.env,scope,identity);const second=await provisionManagedAgentMail(f.env,scope,identity);
    expect(first).toMatchObject({address:"assistant@mail.example.test",status:"active",priceCredits:300});
    expect(second).toMatchObject({connectionId:first.connectionId,status:"active"});
    expect(billing).toHaveBeenCalledTimes(2);
    expect(await f.db.prepare("SELECT COUNT(*) AS n FROM assistant_agentmail_accounts WHERE mode='naelao_managed'").first<{n:number}>()).toMatchObject({n:1});
  });
});
