import { afterEach,describe,expect,it,vi } from "vitest";
import { Hono } from "hono";
import { mintInternalToken } from "@naelao/http";
import type { AgentsEnv } from "../index.js";
import { connectUserAgentMail,callAgentMailTool,createManagedAgentMailQuote,provisionManagedAgentMail,getAssistantAgentMailStatus,receiveAgentPortNotification,sweepManagedAgentMailRentals,sweepManagedAgentMailReconciliations,stopManagedAgentMailRenewal,revokeAgentPortOwnerLink,setAgentPortEventAssistant } from "./agentmail.js";
import { ensureIdentity,ensureAgentPortAssistantIdentity } from "./core.js";
import { registerCommunicationRoutes } from "./routes.js";
import { fixture,scope } from "../../../../tests/fixtures/assistant-communications.js";

async function verifyTestAgentMailCapability(f:ReturnType<typeof fixture>){
  await f.db.prepare(`UPDATE managed_service_capability_versions SET status='verified',verified_by='test-operator',verified_at=?,valid_until='2099-01-01T00:00:00.000Z',regions_json='["us"]'
    WHERE provider='agentmail' AND service_id='agentmail' AND version=1`).bind(new Date().toISOString()).run();
  for(const operation of ["provision","renew"])await f.db.prepare(`INSERT INTO managed_service_plan_entitlements(
    plan_tier,provider,service_id,capability_version,operation_name,region,price_version,max_credits_per_operation,credits_per_operation,
    max_operations_per_period,status,verified_by,verified_at,valid_until,created_at,updated_at)
    VALUES('free','agentmail','agentmail',1,?,'us','agentmail-rental-v2',300,300,20,'active','test-operator',?,'2099-01-01T00:00:00.000Z',datetime('now'),datetime('now'))
    ON CONFLICT(plan_tier,provider,service_id,operation_name,region) DO UPDATE SET price_version=excluded.price_version,
      max_credits_per_operation=excluded.max_credits_per_operation,credits_per_operation=excluded.credits_per_operation,
      max_operations_per_period=excluded.max_operations_per_period,status='active',verified_by=excluded.verified_by,
      verified_at=excluded.verified_at,valid_until=excluded.valid_until,updated_at=excluded.updated_at`)
    .bind(operation,new Date().toISOString()).run();
}

async function quoteAgentMailProvision(f:ReturnType<typeof fixture>,identity:Awaited<ReturnType<typeof ensureIdentity>>,displayName?:string){
  const quote=await createManagedAgentMailQuote(f.env,scope,identity,{...(displayName?{displayName}:{})});
  return quote.quoteId;
}

describe("AgentMail provider account boundary",()=>{
  afterEach(()=>vi.unstubAllGlobals());
  it("reads and idempotently persists documented inbox quantity metrics for an active owner connection",async()=>{
    const f=fixture(),identity=await ensureIdentity(f.env,scope),agentId=await ensureAgentPortAssistantIdentity(f.env,scope);
    await f.db.prepare(`INSERT INTO assistant_agentmail_accounts(id,tenant_id,space_id,assistant_identity_id,agentport_agent_id,
      owner_user_id,mode,inbox_id,email_address,status,created_at,updated_at)
      VALUES('mail-usage','tenant','space',?,?,'user','naelao_managed','inbox-usage','usage@example.test','active',datetime('now'),datetime('now'))`)
      .bind(identity.id,agentId).run();
    await f.db.prepare(`INSERT INTO assistant_agentmail_accounts(id,tenant_id,space_id,assistant_identity_id,agentport_agent_id,
      owner_user_id,mode,inbox_id,email_address,status,created_at,updated_at)
      VALUES('mail-usage-foreign','tenant','space',?,?,'other','user_connected','inbox-foreign','foreign@example.test','active',datetime('now'),datetime('now'))`)
      .bind(identity.id,agentId).run();
    (f.env as unknown as {AGENTMAIL_API_KEY:string}).AGENTMAIL_API_KEY="provider-key-for-test";
    const metrics={
      storage_bytes:[{timestamp:"2026-11-12T06:00:00.000Z",value:4096}],
      message_count:[{timestamp:"2026-11-12T06:00:00.000Z",value:17}],
      thread_count:[{timestamp:"2026-11-12T06:00:00.000Z",value:12}],
    };
    const providerFetch=vi.fn(async(_input:RequestInfo|URL)=>Response.json(metrics));
    vi.stubGlobal("fetch",providerFetch);
    const app=new Hono<{Bindings:AgentsEnv}>();registerCommunicationRoutes(app);
    const headers={"content-type":"application/json","x-naelao-tenant-id":scope.tenantId,"x-naelao-user-id":scope.userId,
      "x-naelao-role":scope.role,"x-naelao-internal-token":await mintInternalToken("secret",scope.tenantId)};
    const body=JSON.stringify({action:"agentmail-usage",connection_id:"mail-usage"});
    const first=await app.request("/spaces/space/assistant-communications",{method:"POST",headers,body},f.env);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({scope:"agentmail_inbox",usage:{storageBytes:4096,messageCount:17,threadCount:12},
      sourceApi:"agentmail.inbox.metrics.usage",provenance:"provider_api_observed",inserted:true,
      notice:expect.stringContaining("not monetary costs")});
    const requestUrl=new URL(String(providerFetch.mock.calls[0]?.[0]));
    expect(requestUrl.pathname).toBe("/v0/inboxes/inbox-usage/metrics/usage");
    expect(requestUrl.searchParams.get("period")).toBe("86400");
    expect(requestUrl.searchParams.get("descending")).toBe("true");
    const replay=await app.request("/spaces/space/assistant-communications",{method:"POST",headers,body},f.env);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({inserted:false,replayed:true});
    expect(providerFetch).toHaveBeenCalledTimes(2);
    const saved=await f.db.prepare("SELECT * FROM managed_service_agentmail_usage_snapshots").first<Record<string,unknown>>();
    expect(saved).toMatchObject({tenant_id:"tenant",space_id:"space",owner_user_id:"user",storage_bytes:4096,message_count:17,
      thread_count:12,source_api:"agentmail.inbox.metrics.usage"});
    expect(String(saved?.connection_ref_sha256)).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(saved)).not.toContain("mail-usage");
    const foreign=await app.request("/spaces/space/assistant-communications",{method:"POST",headers,
      body:JSON.stringify({action:"agentmail-usage",connection_id:"mail-usage-foreign"})},f.env);
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual({error_code:"agentmail_usage_account_not_found"});
    expect(providerFetch).toHaveBeenCalledTimes(2);
  });

  it("discards an AgentMail usage response if the inbox is revoked while the read is in flight",async()=>{
    const f=fixture(),identity=await ensureIdentity(f.env,scope),agentId=await ensureAgentPortAssistantIdentity(f.env,scope);
    await f.db.prepare(`INSERT INTO assistant_agentmail_accounts(id,tenant_id,space_id,assistant_identity_id,agentport_agent_id,
      owner_user_id,mode,inbox_id,email_address,status,created_at,updated_at)
      VALUES('mail-usage-race','tenant','space',?,?,'user','naelao_managed','inbox-usage-race','usage@example.test','active',datetime('now'),datetime('now'))`)
      .bind(identity.id,agentId).run();
    (f.env as unknown as {AGENTMAIL_API_KEY:string}).AGENTMAIL_API_KEY="provider-key-for-test";
    vi.stubGlobal("fetch",vi.fn(async()=>{
      f.db.db.exec("UPDATE assistant_agentmail_accounts SET status='billing_hold' WHERE id='mail-usage-race'");
      return Response.json({storage_bytes:[{timestamp:"2026-11-12T06:00:00.000Z",value:1}],
        message_count:[{timestamp:"2026-11-12T06:00:00.000Z",value:1}],thread_count:[{timestamp:"2026-11-12T06:00:00.000Z",value:1}]});
    }));
    const app=new Hono<{Bindings:AgentsEnv}>();registerCommunicationRoutes(app);
    const headers={"content-type":"application/json","x-naelao-tenant-id":scope.tenantId,"x-naelao-user-id":scope.userId,
      "x-naelao-role":scope.role,"x-naelao-internal-token":await mintInternalToken("secret",scope.tenantId)};
    const response=await app.request("/spaces/space/assistant-communications",{method:"POST",headers,
      body:JSON.stringify({action:"agentmail-usage",connection_id:"mail-usage-race"})},f.env);
    const errorBody=await response.json();
    expect(response.status).toBe(409);
    expect(errorBody).toEqual({error_code:"agentmail_usage_connection_revoked"});
    expect((await f.db.prepare("SELECT count(*) AS count FROM managed_service_agentmail_usage_snapshots")
      .first<{count:number}>())?.count).toBe(0);
  });

  it("routes owner inbox reads through the explicitly selected scoped connection",async()=>{
    const f=fixture(),identity=await ensureIdentity(f.env,scope),agentId=await ensureAgentPortAssistantIdentity(f.env,scope);
    await f.db.prepare(`INSERT INTO assistant_agentmail_accounts(id,tenant_id,space_id,assistant_identity_id,agentport_agent_id,agentport_account_id,
      owner_user_id,mode,inbox_id,email_address,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,'user','naelao_managed','inbox-a','a@example.test','active',datetime('now'),datetime('now'))`)
      .bind("mail-a","tenant","space",identity.id,agentId,"account-a").run();
    await f.db.prepare(`INSERT INTO assistant_agentmail_accounts(id,tenant_id,space_id,assistant_identity_id,agentport_agent_id,agentport_account_id,
      owner_user_id,mode,inbox_id,email_address,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,'user','naelao_managed','inbox-b','b@example.test','active',datetime('now','+1 second'),datetime('now','+1 second'))`)
      .bind("mail-b","tenant","space",identity.id,agentId,"account-b").run();
    await f.db.prepare(`INSERT INTO assistant_agentmail_accounts(id,tenant_id,space_id,assistant_identity_id,agentport_agent_id,agentport_account_id,
      owner_user_id,mode,inbox_id,email_address,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,'other','user_connected','foreign-inbox','private@example.test','active',datetime('now','+2 seconds'),datetime('now','+2 seconds'))`)
      .bind("mail-foreign","tenant","space",identity.id,agentId,"account-foreign").run();
    (f.env as unknown as {AGENTMAIL_API_KEY:string}).AGENTMAIL_API_KEY="provider-key-for-test";
    const providerFetch=vi.fn(async(input:RequestInfo|URL)=>{
      const url=new URL(String(input));
      return Response.json({messages:[{message_id:url.pathname.includes("inbox-a")?"message-a":"message-b"}]});
    });
    vi.stubGlobal("fetch",providerFetch);
    const app=new Hono<{Bindings:AgentsEnv}>();registerCommunicationRoutes(app);
    const headers={"content-type":"application/json","x-naelao-tenant-id":scope.tenantId,"x-naelao-user-id":scope.userId,
      "x-naelao-role":scope.role,"x-naelao-internal-token":await mintInternalToken("secret",scope.tenantId)};
    const response=await app.request("/spaces/space/assistant-communications",{method:"POST",headers,
      body:JSON.stringify({action:"agentmail-operation",operation:"agentmail.inbox",connection_id:"mail-a",args:{limit:10}})},f.env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({result:{messages:[{message_id:"message-a"}]}});
    expect(new URL(String(providerFetch.mock.calls[0]?.[0])).pathname).toBe("/v0/inboxes/inbox-a/messages");
    const denied=await app.request("/spaces/space/assistant-communications",{method:"POST",headers,
      body:JSON.stringify({action:"agentmail-operation",operation:"agentmail.inbox",connection_id:"mail-foreign",args:{limit:10}})},f.env);
    expect(denied.status).toBe(502);
    expect(await denied.json()).toMatchObject({error_code:"agentmail_account_not_connected"});
    expect(providerFetch).toHaveBeenCalledOnce();
    expect((await getAssistantAgentMailStatus(f.env,scope)).connections.map((connection)=>connection.address))
      .not.toContain("private@example.test");
  });
  it("accepts an owner-selected AgentMail API region and persists it before later provider calls",async()=>{
    const f=fixture();
    const providerFetch=vi.fn(async(input:RequestInfo|URL)=>{
      const url=new URL(String(input));
      if(url.pathname==="/v0/inboxes/inbox-eu")return Response.json({inbox_id:"inbox-eu",email:"eu@example.test"});
      if(url.pathname.endsWith("/webhooks"))return Response.json({webhook_id:"eu-hook",secret:"whsec_eu"});
      return Response.json({});
    });
    vi.stubGlobal("fetch",providerFetch);
    const app=new Hono<{Bindings:AgentsEnv}>();registerCommunicationRoutes(app);
    const headers={"content-type":"application/json","x-naelao-tenant-id":scope.tenantId,"x-naelao-user-id":scope.userId,
      "x-naelao-role":scope.role,"x-naelao-internal-token":await mintInternalToken("secret",scope.tenantId)};
    const response=await app.request("/spaces/space/assistant-communications",{method:"POST",headers,body:JSON.stringify({
      action:"agentmail-connect",inbox_id:"inbox-eu",api_key:"agentmail-eu-secret-123456",region:"eu",
    })},f.env);
    expect(response.status).toBe(201);
    const body=await response.json() as {connection:{connectionId:string;region:string}};
    expect(body.connection.region).toBe("eu");
    expect(providerFetch.mock.calls.every(([request])=>new URL(String(request)).origin==="https://api.agentmail.eu")).toBe(true);
    expect(await f.db.prepare("SELECT provider_region FROM assistant_agentmail_accounts WHERE id=?").bind(body.connection.connectionId)
      .first<{provider_region:string}>()).toEqual({provider_region:"eu"});
    const invalid=await app.request("/spaces/space/assistant-communications",{method:"POST",headers,body:JSON.stringify({
      action:"agentmail-connect",inbox_id:"inbox-eu",api_key:"agentmail-eu-secret-123456",region:"apac",
    })},f.env);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({error_code:"invalid_agentmail_connection"});
    expect(providerFetch).toHaveBeenCalledTimes(2);
  });
  it("repairs the AgentPort link through an owner-scoped durable idempotent action",async()=>{
    const f=fixture(),identity=await ensureIdentity(f.env,scope);
    vi.stubGlobal("fetch",vi.fn(async(input:RequestInfo|URL)=>{
      const path=new URL(String(input)).pathname;
      if(path.endsWith("/inboxes/inbox-sync"))return Response.json({inbox_id:"inbox-sync",email:"sync@example.test"});
      if(path.endsWith("/webhooks"))return Response.json({webhook_id:"mail-hook-sync",secret:"whsec_dGVzdA=="});
      return Response.json({error:"not_found"},{status:404});
    }));
    const connected=await connectUserAgentMail(f.env,scope,identity,{inboxId:"inbox-sync",apiKey:"agentmail-sync-secret-123456"});
    const agentPortFetch=f.env.AGENTPORT_WORKER.fetch;
    const callCountBefore=agentPortFetch.mock.calls.length;
    const app=new Hono<{Bindings:AgentsEnv}>();registerCommunicationRoutes(app);
    const headers={"content-type":"application/json","x-naelao-tenant-id":scope.tenantId,"x-naelao-user-id":scope.userId,
      "x-naelao-role":scope.role,"x-naelao-internal-token":await mintInternalToken("secret",scope.tenantId)};
    const body={action:"agentmail-agentport-sync",connection_id:connected.connectionId,request_id:"sync-request-1"};
    const first=await app.request("/spaces/space/assistant-communications",{method:"POST",headers,body:JSON.stringify(body)},f.env);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({synced:true,connectionId:connected.connectionId,deduplicated:false});
    const callCountAfter=agentPortFetch.mock.calls.length;
    const subscriptionCreatesAfter=agentPortFetch.mock.calls.filter(([request])=>new URL(request.url).pathname.endsWith("/events/subscriptions")).length;
    expect(callCountAfter).toBeGreaterThan(callCountBefore);
    const duplicate=await app.request("/spaces/space/assistant-communications",{method:"POST",headers,body:JSON.stringify(body)},f.env);
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({synced:true,connectionId:connected.connectionId,deduplicated:true});
    expect(agentPortFetch.mock.calls.filter(([request])=>new URL(request.url).pathname.endsWith("/events/subscriptions"))).toHaveLength(subscriptionCreatesAfter);
    expect(await f.db.prepare("SELECT status,operation_name,request_json FROM managed_service_operations WHERE operation_name='agentport_sync'")
      .first<Record<string,string>>()).toMatchObject({status:"complete",operation_name:"agentport_sync",request_json:expect.stringContaining(connected.connectionId)});
    await f.db.prepare(`INSERT INTO assistant_agentmail_accounts(id,tenant_id,space_id,project_id,assistant_identity_id,agentport_agent_id,
      owner_user_id,mode,inbox_id,email_address,status,created_at,updated_at)
      VALUES('foreign-sync','tenant','space',NULL,?,'shared-agent','other','user_connected','foreign-inbox','private@example.test','active',datetime('now'),datetime('now'))`)
      .bind(identity.id).run();
    const callsBeforeForeignSync=agentPortFetch.mock.calls.length;
    const foreign=await app.request("/spaces/space/assistant-communications",{method:"POST",headers,body:JSON.stringify({
      action:"agentmail-agentport-sync",connection_id:"foreign-sync",request_id:"foreign-sync-request",
    })},f.env);
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toMatchObject({error_code:"agentport_sync_account_not_found"});
    expect(agentPortFetch).toHaveBeenCalledTimes(callsBeforeForeignSync);
  });
  it("retries an uncertain owner-link revocation against the exact persisted AgentPort account",async()=>{
    const f=fixture(),identity=await ensureIdentity(f.env,scope);
    vi.stubGlobal("fetch",vi.fn(async(input:RequestInfo|URL)=>{
      if(new URL(String(input)).pathname.endsWith("/inboxes/inbox-unlink"))return Response.json({inbox_id:"inbox-unlink",email:"unlink@example.test"});
      if(new URL(String(input)).pathname.endsWith("/webhooks"))return Response.json({webhook_id:"mail-hook-unlink",secret:"whsec_dGVzdA=="});
      return Response.json({error:"not_found"},{status:404});
    }));
    const connected=await connectUserAgentMail(f.env,scope,identity,{inboxId:"inbox-unlink",apiKey:"agentmail-unlink-secret-123456"});
    const port=f.env.AGENTPORT_WORKER.fetch as ReturnType<typeof vi.fn>;
    let revokeAttempts=0;
    port.mockImplementation(async(request:Request)=>{
      if(new URL(request.url).pathname.endsWith(`/accounts/${connected.accountId}/revoke`)&&++revokeAttempts===1)
        return Response.json({error_code:"temporary_failure"},{status:503});
      return Response.json({revoked:true,active:true});
    });
    const ownerLink=await f.db.prepare("SELECT id FROM managed_service_owner_links WHERE owner_type='user' AND owner_id='user' AND status='active'")
      .first<{id:string}>();
    const app=new Hono<{Bindings:AgentsEnv}>();registerCommunicationRoutes(app);
    const headers={"content-type":"application/json","x-naelao-tenant-id":scope.tenantId,"x-naelao-user-id":scope.userId,
      "x-naelao-role":scope.role,"x-naelao-internal-token":await mintInternalToken("secret",scope.tenantId)};
    const response=await app.request("/spaces/space/assistant-communications",{method:"POST",headers,body:JSON.stringify({
      action:"agentport-owner-unlink",owner_link_id:ownerLink!.id,
    })},f.env);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({error_code:"agentport_account_revoke_uncertain"});
    const pending=await f.db.prepare(`SELECT status,next_reconcile_at,request_json FROM managed_service_operations WHERE operation_name='owner_unlink'`)
      .first<{status:string;next_reconcile_at:string;request_json:string}>();
    expect(pending?.status).toBe("uncertain");
    expect(pending?.next_reconcile_at).toBeTruthy();
    expect(pending?.request_json).toContain(connected.accountId);
    expect(await f.db.prepare("SELECT lifecycle_state FROM managed_service_accounts WHERE id=?").bind(connected.connectionId)
      .first<{lifecycle_state:string}>()).toEqual({lifecycle_state:"revoking"});
    const sweep=await sweepManagedAgentMailReconciliations(f.env,new Date(Date.now()+6*60_000),10);
    expect(sweep).toEqual({checked:1,reconciled:1,deferred:0,failed:0});
    expect(revokeAttempts).toBe(2);
    expect(await f.db.prepare("SELECT status,next_reconcile_at FROM managed_service_operations WHERE operation_name='owner_unlink'")
      .first<Record<string,unknown>>()).toEqual({status:"complete",next_reconcile_at:null});
    expect(await f.db.prepare("SELECT lifecycle_state FROM managed_service_accounts WHERE id=?").bind(connected.connectionId)
      .first<{lifecycle_state:string}>()).toEqual({lifecycle_state:"revoked"});
  });
  it("retries a partially completed AgentPort sync from its durable uncertain operation",async()=>{
    const f=fixture(),identity=await ensureIdentity(f.env,scope);
    vi.stubGlobal("fetch",vi.fn(async(input:RequestInfo|URL)=>{
      const path=new URL(String(input)).pathname;
      if(path.endsWith("/inboxes/inbox-retry"))return Response.json({inbox_id:"inbox-retry",email:"retry@example.test"});
      if(path.endsWith("/webhooks"))return Response.json({webhook_id:"mail-hook-retry",secret:"whsec_dGVzdA=="});
      return Response.json({error:"not_found"},{status:404});
    }));
    const connected=await connectUserAgentMail(f.env,scope,identity,{inboxId:"inbox-retry",apiKey:"agentmail-retry-secret-123456"});
    let subscriptionAttempts=0;
    (f.env as unknown as {AGENTPORT_WORKER:{fetch:(request:Request)=>Promise<Response>}}).AGENTPORT_WORKER={fetch:async(request)=>{
      const path=new URL(request.url).pathname;
      if(path.endsWith("/events/subscriptions")&&++subscriptionAttempts===1)return Response.json({error_code:"temporary_failure"},{status:503});
      if(path.endsWith("/events/subscriptions"))return Response.json({subscription:{id:"retry-subscription",agentId:connected.agentId,
        serviceId:`agentmail:${scope.tenantId}`,accountId:connected.accountId},webhookSecret:"retry-webhook-secret"},{status:201});
      if(path.endsWith("/agents"))return Response.json({agent:{id:connected.agentId,status:"active"}},{status:201});
      if(path.endsWith("/identity"))return Response.json({identity:{id:connected.agentId,principal:{id:"prn-org:tenant"}}});
      if(path.endsWith("/principals"))return Response.json({principal:{id:"prn-user:tenant:user"}},{status:201});
      if(path.endsWith("/accounts"))return Response.json({account:{id:connected.accountId,status:"active"}},{status:200});
      if(path.endsWith("/channels")&&request.method==="GET")return Response.json({channels:[{id:connected.channelId,account_id:connected.accountId}]});
      return Response.json({active:true,grant:{id:"grant"},channel:{id:connected.channelId}});
    }};
    const app=new Hono<{Bindings:AgentsEnv}>();registerCommunicationRoutes(app);
    const headers={"content-type":"application/json","x-naelao-tenant-id":scope.tenantId,"x-naelao-user-id":scope.userId,
      "x-naelao-role":scope.role,"x-naelao-internal-token":await mintInternalToken("secret",scope.tenantId)};
    const body={action:"agentmail-agentport-sync",connection_id:connected.connectionId,request_id:"sync-recovery-1"};
    const first=await app.request("/spaces/space/assistant-communications",{method:"POST",headers,body:JSON.stringify(body)},f.env);
    expect(first.status).toBe(502);
    expect(await f.db.prepare("SELECT status,error_code FROM managed_service_operations WHERE operation_name='agentport_sync'")
      .first<Record<string,string>>()).toMatchObject({status:"uncertain",error_code:"agentport_temporary_failure"});
    await f.db.prepare("UPDATE managed_service_operations SET next_reconcile_at='2000-01-01T00:00:00.000Z' WHERE operation_name='agentport_sync'").run();
    const reconciliation=await sweepManagedAgentMailReconciliations(f.env,new Date("2026-11-11T12:00:00.000Z"),10);
    expect(reconciliation).toEqual({checked:1,reconciled:1,deferred:0,failed:0});
    expect(subscriptionAttempts).toBe(2);
    expect(await f.db.prepare("SELECT status,provider_operation_ref,result_ref FROM managed_service_operations WHERE operation_name='agentport_sync'")
      .first<Record<string,string>>()).toMatchObject({status:"complete",provider_operation_ref:connected.accountId,result_ref:connected.channelId});
  });
  it("links an active AgentPort subscription to an explicitly provisioned Naelao assistant",async()=>{
    const f=fixture();const identity=await ensureIdentity(f.env,scope);
    await f.db.prepare(`INSERT INTO assistant_agentmail_accounts(id,tenant_id,space_id,assistant_identity_id,agentport_agent_id,agentport_account_id,
      agentport_subscription_id,owner_user_id,mode,inbox_id,email_address,status,created_at,updated_at)
      VALUES('connection-route','tenant','space',?,'agent-a','account-a','subscription-a','user','user_connected','inbox-a','assistant@example.test','active',datetime('now'),datetime('now'))`)
      .bind(identity.id).run();
    f.objects.set("spaces/space/agents/specialist-a/system-prompt.md","specialist prompt");
    f.objects.set("spaces/space/agents/specialist-a/scripts.json",JSON.stringify({prebuilt:[]}));
    const agentPort=vi.fn(async(request:Request)=>Response.json({subscription:{id:"subscription-a",agentId:"agent-a",accountId:"account-a",serviceId:"agentmail:tenant",status:"active"}}));
    (f.env as unknown as {AGENTPORT_WORKER:{fetch:typeof agentPort}}).AGENTPORT_WORKER={fetch:agentPort};

    await expect(setAgentPortEventAssistant(f.env,scope,"connection-route","specialist-a"))
      .resolves.toEqual({connectionId:"connection-route",assistantId:"specialist-a",wakeEnabled:true,subscriptionVerified:true});
    expect(agentPort).toHaveBeenCalledOnce();
    expect(await f.db.prepare("SELECT naelao_agent_id,status,selected_by_user_id FROM assistant_agentport_event_routes WHERE account_id='connection-route'")
      .first<Record<string,string>>()).toEqual({naelao_agent_id:"specialist-a",status:"active",selected_by_user_id:"user"});
    expect(await getAssistantAgentMailStatus(f.env,scope)).toMatchObject({connections:[{id:"connection-route",assistantId:"specialist-a"}]});
    expect(await setAgentPortEventAssistant(f.env,scope,"connection-route","specialist-a",false)).toMatchObject({assistantId:"specialist-a",wakeEnabled:false});
    expect(await f.db.prepare("SELECT wake_enabled FROM assistant_agentport_event_routes WHERE account_id='connection-route'").first<{wake_enabled:number}>()).toEqual({wake_enabled:0});
  });
  it("rejects unprovisioned assistants and subscriptions whose identity tuple changed",async()=>{
    const f=fixture();const identity=await ensureIdentity(f.env,scope);
    await f.db.prepare(`INSERT INTO assistant_agentmail_accounts(id,tenant_id,space_id,assistant_identity_id,agentport_agent_id,agentport_account_id,
      agentport_subscription_id,owner_user_id,mode,inbox_id,email_address,status,created_at,updated_at)
      VALUES('connection-route','tenant','space',?,'agent-a','account-a','subscription-a','user','user_connected','inbox-a','assistant@example.test','active',datetime('now'),datetime('now'))`)
      .bind(identity.id).run();
    (f.env as unknown as {AGENTPORT_WORKER:{fetch:typeof vi.fn}}).AGENTPORT_WORKER={fetch:vi.fn(async()=>Response.json({subscription:{id:"subscription-a",agentId:"other-agent",accountId:"account-a",serviceId:"agentmail:tenant",status:"active"}}))};
    await expect(setAgentPortEventAssistant(f.env,scope,"connection-route","unprovisioned-agent")).rejects.toThrow("naelao_assistant_not_provisioned");
    await expect(setAgentPortEventAssistant(f.env,scope,"connection-route","naelao-agent")).rejects.toThrow("agentport_assistant_route_subscription_unavailable");
    expect(await f.db.prepare("SELECT COUNT(*) AS count FROM assistant_agentport_event_routes").first<{count:number}>()).toEqual({count:0});
  });
  it("validates and encrypts a user connected scoped inbox credential, then authorizes provider reads",async()=>{
    const f=fixture();
    const identity=await ensureIdentity(f.env,scope);
    const providerFetch=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
      const request=new Request(input,init);
      if(new URL(request.url).pathname.endsWith("/inboxes/inbox-1"))return Response.json({inbox_id:"inbox-1",email:"assistant@example.test"});
      if(new URL(request.url).pathname.endsWith("/webhooks"))return Response.json({webhook_id:"agentmail-hook",secret:"whsec_dGVzdA=="});
      if(new URL(request.url).pathname.endsWith("/messages/search"))return Response.json({messages:[]});
      if(new URL(request.url).pathname.endsWith("/messages"))return Response.json({messages:[{message_id:"message-1",text:"provider content"}]});
      return Response.json({error:"not_found"},{status:404});
    });
    vi.stubGlobal("fetch",providerFetch);
    const connected=await connectUserAgentMail(f.env,scope,identity,{inboxId:"inbox-1",apiKey:"agentmail-scoped-secret-123456",region:"eu"});
    expect(connected).toMatchObject({address:"assistant@example.test",status:"active",mode:"user_connected",region:"eu",accountId:"ap_account"});
    expect(connected.agentId).toMatch(/^naelao_[a-f0-9]{64}$/);
    const stored=await f.db.prepare("SELECT credential_ciphertext,credential_iv,status,provider_region FROM assistant_agentmail_accounts WHERE id=?").bind(connected.connectionId).first<{credential_ciphertext:string;credential_iv:string;status:string;provider_region:string}>();
    expect(stored).toMatchObject({status:"active",provider_region:"eu"});
    expect(providerFetch.mock.calls.every(([request])=>new URL(String(request)).origin==="https://api.agentmail.eu")).toBe(true);
    expect(stored?.credential_ciphertext).not.toContain("agentmail-scoped-secret-123456");
    const managedAccount=await f.db.prepare("SELECT provider,service_id,connection_mode,provider_resource_ref,credential_ref,agentport_principal_id,owner_link_id,owner_type,owner_id,provider_payer_type,credit_payer_type,lifecycle_state,metadata_json FROM managed_service_accounts WHERE id=?").bind(connected.connectionId)
      .first<{provider:string;service_id:string;connection_mode:string;provider_resource_ref:string;credential_ref:string;agentport_principal_id:string;owner_link_id:string;owner_type:string;owner_id:string;provider_payer_type:string;credit_payer_type:string|null;lifecycle_state:string;metadata_json:string}>();
    expect(managedAccount).toMatchObject({provider:"agentmail",service_id:"agentmail",connection_mode:"user_connected",provider_resource_ref:"inbox-1",credential_ref:connected.connectionId,agentport_principal_id:"prn-user:tenant:user",owner_type:"user",owner_id:"user",provider_payer_type:"user",credit_payer_type:null,lifecycle_state:"active"});
    expect(await f.db.prepare("SELECT owner_type,owner_id,agentport_principal_id,linked_by_user_id,consent_source,status FROM managed_service_owner_links WHERE id=?").bind(managedAccount?.owner_link_id).first<Record<string,string>>())
      .toMatchObject({owner_type:"user",owner_id:"user",agentport_principal_id:"prn-user:tenant:user",linked_by_user_id:"user",consent_source:"agentmail_user_connect",status:"active"});
    expect(managedAccount?.metadata_json).not.toContain("agentmail-scoped-secret-123456");
    expect(await getAssistantAgentMailStatus(f.env,scope)).toMatchObject({connections:[{assistantId:null,receivedMessages:0,sentMessages:0,activity30d:"idle"}]});
    const response=await callAgentMailTool(f.env,scope,"agentmail.inbox",{limit:10});
    expect(response).toEqual({messages:[{message_id:"message-1",text:"provider content"}]});
    const call=providerFetch.mock.calls.at(-1)!;
    expect(new Headers(call[1]?.headers).get("authorization")).toBe("Bearer agentmail-scoped-secret-123456");
    await callAgentMailTool(f.env,scope,"agentmail.inbox",{limit:5},connected.connectionId);
    expect(new URL(String(providerFetch.mock.calls.at(-1)?.[0])).pathname).toBe("/v0/inboxes/inbox-1/messages");
    expect(new URL(String(providerFetch.mock.calls.at(-1)?.[0])).origin).toBe("https://api.agentmail.eu");
    await callAgentMailTool(f.env,scope,"agentmail.search",{query:"private sender text"},connected.connectionId);
    const authorizationRequest=f.env.AGENTPORT_WORKER.fetch.mock.calls.map(([request])=>request as Request)
      .filter(request=>new URL(request.url).pathname.endsWith("/actions/authorize")).at(-1);
    expect(authorizationRequest).toBeTruthy();
    const authorizationBody=await authorizationRequest!.clone().json() as Record<string,unknown>;
    expect(authorizationBody).toMatchObject({agentId:connected.agentId,action:"email.search",resourceRef:"inbox-1"});
    expect(authorizationBody).not.toHaveProperty("limit");
    expect(authorizationBody).not.toHaveProperty("query");
    expect(authorizationBody).not.toHaveProperty("text");
    await expect(callAgentMailTool(f.env,scope,"agentmail.inbox",{limit:5},"another-owner-connection"))
      .rejects.toThrow("agentmail_account_not_connected");
    expect(f.env.AGENTPORT_WORKER.fetch).toHaveBeenCalledWith(expect.objectContaining({url:expect.stringContaining("/actions/authorize")}));
    const notification={id:"event-1",deliveryId:"delivery-1",subscriptionId:"ap_subscription",agentId:connected.agentId,serviceId:"agentmail:tenant",accountId:"ap_account",type:"message.received",threadRef:"provider-thread-1",dataRef:"provider-message-1"};
    const raw=JSON.stringify(notification),timestamp=String(Math.floor(Date.now()/1000)),key=await crypto.subtle.importKey("raw",new TextEncoder().encode("agentport-event-webhook-secret"),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
    const signed=new Uint8Array(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(`${timestamp}\n${raw}`)));
    const signature=`v1=${btoa(String.fromCharCode(...signed)).replaceAll("+","-").replaceAll("/","_").replace(/=+$/g,"")}`;
    const eventResponse=await receiveAgentPortNotification(f.env,connected.connectionId,new Request("https://api.example.test/event",{method:"POST",headers:{"x-agentport-timestamp":timestamp,"x-agentport-signature":signature},body:raw}));
    expect(eventResponse.status).toBe(204);
    expect(f.env.CHANNEL_SESSIONS?.send).toHaveBeenCalledWith(expect.objectContaining({type:"provider_event_reference",deliveryId:"delivery-1",threadRef:"provider-thread-1",dataRef:"provider-message-1"}));
    expect(await f.db.prepare("SELECT status FROM assistant_agentport_event_receipts WHERE delivery_id='delivery-1'").first<{status:string}>()).toMatchObject({status:"queued"});
    const ownerLink=await f.db.prepare("SELECT id FROM managed_service_owner_links WHERE owner_type='user' AND owner_id='user' AND status='active'").first<{id:string}>();
    const revoked=await revokeAgentPortOwnerLink(f.env,scope,ownerLink!.id);
    expect(revoked).toMatchObject({revoked:true,accountCount:1});
    expect(await f.db.prepare("SELECT status,credential_ciphertext FROM assistant_agentmail_accounts WHERE id=?").bind(connected.connectionId).first<Record<string,unknown>>())
      .toMatchObject({status:"retired",credential_ciphertext:null});
    expect(await f.db.prepare("SELECT l.status AS link_status,a.lifecycle_state FROM managed_service_owner_links l JOIN managed_service_accounts a ON a.owner_link_id=l.id WHERE l.id=?").bind(ownerLink!.id)
      .first<Record<string,string>>()).toMatchObject({link_status:"revoked",lifecycle_state:"revoked"});
    expect(f.env.AGENTPORT_WORKER.fetch).toHaveBeenCalledWith(expect.objectContaining({url:expect.stringContaining(`/accounts/${connected.accountId}/revoke`)}));
    await expect(callAgentMailTool(f.env,scope,"agentmail.inbox",{limit:10})).rejects.toThrow("agentmail_account_not_connected");
  });
  it("rejects mismatched inbox credentials before storing them",async()=>{
    const f=fixture();
    vi.stubGlobal("fetch",vi.fn(async()=>Response.json({inbox_id:"another-inbox",email:"other@example.test"})));
    const identity=await ensureIdentity(f.env,scope);
    await expect(connectUserAgentMail(f.env,scope,identity,{inboxId:"inbox-1",apiKey:"agentmail-scoped-secret-123456"})).rejects.toThrow("agentmail_inbox_mismatch");
    expect(await f.db.prepare("SELECT COUNT(*) AS n FROM assistant_agentmail_accounts").first<{n:number}>()).toMatchObject({n:0});
  });
  it("provisions one managed inbox per distinct assistant and charges 300 credits once",async()=>{
    const f=fixture();const identity=await ensureIdentity(f.env,scope);const billingRequests:Array<{path:string;body:Record<string,unknown>}>=[];
    const billing=vi.fn(async(request:Request)=>{billingRequests.push({path:new URL(request.url).pathname,body:await request.clone().json() as Record<string,unknown>});return Response.json({reserved:true,settled:true});});
    await verifyTestAgentMailCapability(f);
    (f.env as unknown as {AGENTMAIL_API_KEY:string;AGENTMAIL_DEFAULT_DOMAIN:string;BILLING_WORKER:{fetch:typeof billing}}).AGENTMAIL_API_KEY="managed-provider-key";
    (f.env as unknown as {AGENTMAIL_DEFAULT_DOMAIN:string}).AGENTMAIL_DEFAULT_DOMAIN="mail.example.test";
    (f.env as unknown as {AGENTMAIL_REGION:string}).AGENTMAIL_REGION="us";
    (f.env as unknown as {BILLING_WORKER:{fetch:typeof billing}}).BILLING_WORKER={fetch:billing};
    const providerFetch=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
      const request=new Request(input,init),url=new URL(request.url);
      if(url.pathname==="/v0/pods")return Response.json({pod_id:"pod-1"});
      if(url.pathname==="/v0/pods/pod-1/inboxes")return Response.json({inbox_id:"managed-inbox",email:"assistant@mail.example.test"});
      if(url.pathname.endsWith("/webhooks"))return Response.json({webhook_id:"managed-hook",secret:"whsec_dGVzdA=="});
      return Response.json({error:"not_found"},{status:404});
    });vi.stubGlobal("fetch",providerFetch);
    const quoteId=await quoteAgentMailProvision(f,identity);
    const first=await provisionManagedAgentMail(f.env,scope,identity,undefined,quoteId);const second=await provisionManagedAgentMail(f.env,scope,identity);
    expect(first).toMatchObject({address:"assistant@mail.example.test",status:"active",priceCredits:300,priceVersion:"agentmail-rental-v2",renewalCredits:300,autoRenew:true});
    expect(second).toMatchObject({connectionId:first.connectionId,status:"active"});
    expect(billing).toHaveBeenCalledTimes(3);
    expect(await f.db.prepare("SELECT COUNT(*) AS n FROM assistant_agentmail_accounts WHERE mode='naelao_managed'").first<{n:number}>()).toMatchObject({n:1});
    const managedAccount=await f.db.prepare("SELECT connection_mode,agentport_principal_id,owner_link_id,provider_payer_type,credit_payer_type,credit_payer_id,lifecycle_state,capability_version,region FROM managed_service_accounts WHERE id=?").bind(first.connectionId)
      .first<Record<string,string>>();
    expect(managedAccount).toMatchObject({connection_mode:"naelao_managed",agentport_principal_id:"prn-org:tenant",provider_payer_type:"platform",credit_payer_type:"organization",credit_payer_id:"tenant",lifecycle_state:"active",capability_version:1,region:"us"});
    expect(await f.db.prepare("SELECT owner_type,owner_id,linked_by_user_id,consent_source,status FROM managed_service_owner_links WHERE id=?").bind(managedAccount?.owner_link_id)
      .first<Record<string,string>>()).toMatchObject({owner_type:"organization",owner_id:"tenant",linked_by_user_id:"user",consent_source:"agentmail_managed_provision",status:"active"});
    expect(await f.db.prepare("SELECT payer_type,payer_id,authorized_by_user_id,operation_scopes_json,max_credits_per_operation,auto_renew,status,agentport_agent_id,max_credits_per_period,period_days FROM managed_service_payer_mandates WHERE mandate_key=?")
      .bind(`agentmail:${first.agentId}`).first<Record<string,unknown>>()).toMatchObject({payer_type:"organization",payer_id:"tenant",authorized_by_user_id:"user",operation_scopes_json:'["agentmail:agentmail:provision","agentmail:agentmail:renew"]',max_credits_per_operation:300,auto_renew:1,status:"active",agentport_agent_id:first.agentId,max_credits_per_period:600,period_days:30});
    expect(billingRequests.find((item)=>item.path.endsWith("/reserve"))?.body).toMatchObject({payer_type:"organization",payer_id:"tenant",agentport_agent_id:first.agentId,credits:300,quote_id:quoteId,requester_user_id:"user",price_version:"agentmail-rental-v2"});
    expect(await f.db.prepare("SELECT status,operation_name,credits,price_version,request_sha256,renewal_credits,renewal_price_version,renewal_max_credits_per_operation FROM managed_service_operation_quotes WHERE quote_id=?")
      .bind(quoteId).first<Record<string,unknown>>()).toMatchObject({status:"consumed",operation_name:"provision",credits:300,price_version:"agentmail-rental-v2",
        request_sha256:expect.stringMatching(/^[a-f0-9]{64}$/),renewal_credits:300,renewal_price_version:"agentmail-rental-v2",renewal_max_credits_per_operation:300});
    expect(await f.db.prepare("SELECT provider,operation_name,status,reservation_id,reserved_credits,price_version,quote_id,provider_operation_ref FROM managed_service_operations WHERE operation_id LIKE 'naelao_%'")
      .first<Record<string,unknown>>()).toMatchObject({provider:"agentmail",operation_name:"provision",status:"complete",reservation_id:expect.stringContaining("agentmail_rent_"),reserved_credits:300,price_version:"agentmail-rental-v2",quote_id:quoteId,provider_operation_ref:"managed-inbox"});
    const stopped=await stopManagedAgentMailRenewal(f.env,scope,first.connectionId);
    expect(stopped).toMatchObject({connectionId:first.connectionId,renewalStopped:true,revoked:true});
    const stoppedAccount=await f.db.prepare("SELECT retire_after,next_billing_at,delete_at_period_end FROM assistant_agentmail_accounts WHERE id=?").bind(first.connectionId)
      .first<{retire_after:string;next_billing_at:string;delete_at_period_end:number}>();
    expect(stoppedAccount?.retire_after).toBe(stoppedAccount?.next_billing_at);
    expect(stoppedAccount?.delete_at_period_end).toBe(1);
    expect(await f.db.prepare("SELECT action,actor_user_id FROM managed_service_payer_mandate_audit WHERE action='revoked'").first<Record<string,string>>())
      .toMatchObject({action:"revoked",actor_user_id:"user"});
  });
  it("exposes owner quote and separate confirmation actions for managed AgentMail",async()=>{
    const f=fixture();await ensureIdentity(f.env,scope);await verifyTestAgentMailCapability(f);
    (f.env as unknown as {AGENTMAIL_DEFAULT_DOMAIN:string;AGENTMAIL_REGION:string}).AGENTMAIL_DEFAULT_DOMAIN="mail.example.test";
    (f.env as unknown as {AGENTMAIL_REGION:string}).AGENTMAIL_REGION="us";
    const app=new Hono<{Bindings:AgentsEnv}>();registerCommunicationRoutes(app);
    const headers={"content-type":"application/json","x-naelao-tenant-id":scope.tenantId,"x-naelao-user-id":scope.userId,
      "x-naelao-role":scope.role,"x-naelao-internal-token":await mintInternalToken("secret",scope.tenantId)};
    const quoted=await app.request("/spaces/space/assistant-communications",{method:"POST",headers,
      body:JSON.stringify({action:"agentmail-quote",display_name:"Care Assistant"})},f.env);
    expect(quoted.status).toBe(200);
    const quote=await quoted.json() as {quoteId:string;credits:number;renewalCredits:number;maxCreditsPerOperation:number;maxCreditsPerPeriod:number};
    expect(quote).toMatchObject({credits:300,renewalCredits:300,maxCreditsPerOperation:300,maxCreditsPerPeriod:600});
    const unconfirmed=await app.request("/spaces/space/assistant-communications",{method:"POST",headers,
      body:JSON.stringify({action:"agentmail-provision",display_name:"Care Assistant"})},f.env);
    expect(unconfirmed.status).toBe(400);
    expect(await unconfirmed.json()).toEqual({error_code:"managed_service_quote_required"});
    expect(await f.db.prepare("SELECT COUNT(*) AS count FROM managed_service_operations WHERE provider='agentmail'").first<{count:number}>()).toEqual({count:0});
  });
  it("reconciles an uncertain create from provider state without dispatching a second inbox creation",async()=>{
    const f=fixture();const identity=await ensureIdentity(f.env,scope);const billing=vi.fn(async()=>Response.json({reserved:true,settled:true}));
    await verifyTestAgentMailCapability(f);
    (f.env as unknown as {AGENTMAIL_API_KEY:string;AGENTMAIL_DEFAULT_DOMAIN:string;BILLING_WORKER:{fetch:typeof billing}}).AGENTMAIL_API_KEY="managed-provider-key";
    (f.env as unknown as {AGENTMAIL_DEFAULT_DOMAIN:string}).AGENTMAIL_DEFAULT_DOMAIN="mail.example.test";
    (f.env as unknown as {AGENTMAIL_REGION:string}).AGENTMAIL_REGION="us";
    (f.env as unknown as {BILLING_WORKER:{fetch:typeof billing}}).BILLING_WORKER={fetch:billing};
    const agentId=await ensureAgentPortAssistantIdentity(f.env,scope);
    const inboxDigest=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(`naelao:managed-inbox:${scope.tenantId}:${agentId}`)));
    const inboxClient=`naelao_${[...inboxDigest].map(x=>x.toString(16).padStart(2,"0")).join("")}`;
    let inboxReadCount=0;
    const providerFetch=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
      const request=new Request(input,init),url=new URL(request.url);
      if(url.pathname==="/v0/pods")return Response.json({pod_id:"pod-1"});
      if(url.pathname==="/v0/pods/pod-1/inboxes"&&request.method==="POST")return Response.json({error:"temporary_failure"},{status:500});
      if(url.pathname==="/v0/pods/pod-1/inboxes"&&request.method==="GET")return Response.json({inboxes:inboxReadCount++===0?[]:[{pod_id:"pod-1",inbox_id:"reconciled-inbox",email:"assistant@mail.example.test",client_id:inboxClient}]});
      if(url.pathname.endsWith("/webhooks"))return Response.json({webhook_id:"managed-hook",secret:"whsec_dGVzdA=="});
      return Response.json({error:"not_found"},{status:404});
    });vi.stubGlobal("fetch",providerFetch);
    const quoteId=await quoteAgentMailProvision(f,identity);
    await expect(provisionManagedAgentMail(f.env,scope,identity,undefined,quoteId)).rejects.toThrow("agentmail_provider_500");
    expect(await f.db.prepare("SELECT status,next_reconcile_at,request_json FROM managed_service_operations WHERE operation_name='provision'").first<{status:string;next_reconcile_at:string;request_json:string}>()).toMatchObject({status:"uncertain",next_reconcile_at:expect.any(String)});
    expect((await f.db.prepare("SELECT request_json FROM managed_service_operations WHERE operation_name='provision'").first<{request_json:string}>())?.request_json).not.toContain("managed-provider-key");
    expect(await getAssistantAgentMailStatus(f.env,scope)).toMatchObject({lastManagedOperation:{status:"uncertain",reconciliationRequired:true}});
    expect(providerFetch.mock.calls.filter(([input,init])=>new URL(String(input)).pathname==="/v0/pods/pod-1/inboxes"&&new Request(input,init).method==="POST")).toHaveLength(1);
    await f.db.prepare(`UPDATE managed_service_plan_entitlements SET price_version='agentmail-rental-v3',credits_per_operation=250,updated_at=datetime('now')
      WHERE plan_tier='free' AND provider='agentmail' AND service_id='agentmail' AND operation_name IN ('provision','renew')`).run();
    const firstSweep=await sweepManagedAgentMailReconciliations(f.env,new Date(Date.now()+6*60_000));
    expect(firstSweep).toMatchObject({checked:1,reconciled:0,deferred:1,failed:0});
    const sweep=await sweepManagedAgentMailReconciliations(f.env,new Date(Date.now()+20*60_000));
    expect(sweep).toMatchObject({checked:1,reconciled:1,deferred:0,failed:0});
    const reconciled=await f.db.prepare("SELECT id,email_address AS address,status FROM assistant_agentmail_accounts WHERE mode='naelao_managed'").first<{id:string;address:string;status:string}>();
    expect(reconciled).toMatchObject({address:"assistant@mail.example.test",status:"active"});
    expect(providerFetch.mock.calls.filter(([input,init])=>new URL(String(input)).pathname==="/v0/pods/pod-1/inboxes"&&new Request(input,init).method==="POST")).toHaveLength(1);
    expect(await f.db.prepare("SELECT lifecycle_state FROM managed_service_accounts WHERE id=?").bind(reconciled?.id).first<{lifecycle_state:string}>()).toMatchObject({lifecycle_state:"active"});
    expect(await f.db.prepare("SELECT status,price_version,reserved_credits,quote_id FROM managed_service_operations WHERE operation_name='provision'")
      .first<Record<string,unknown>>()).toMatchObject({status:"complete",price_version:"agentmail-rental-v2",reserved_credits:300,quote_id:expect.stringMatching(/^msq_[a-f0-9]{32}$/)});
  });
  it("fails closed until a managed AgentMail capability and region are operator verified",async()=>{
    const f=fixture();const identity=await ensureIdentity(f.env,scope);const billing=vi.fn(async()=>Response.json({reserved:true}));
    (f.env as unknown as {AGENTMAIL_API_KEY:string;AGENTMAIL_DEFAULT_DOMAIN:string;AGENTMAIL_REGION:string;BILLING_WORKER:{fetch:typeof billing}}).AGENTMAIL_API_KEY="managed-provider-key";
    (f.env as unknown as {AGENTMAIL_DEFAULT_DOMAIN:string}).AGENTMAIL_DEFAULT_DOMAIN="mail.example.test";
    (f.env as unknown as {AGENTMAIL_REGION:string}).AGENTMAIL_REGION="us";
    (f.env as unknown as {BILLING_WORKER:{fetch:typeof billing}}).BILLING_WORKER={fetch:billing};
    await expect(provisionManagedAgentMail(f.env,scope,identity)).rejects.toThrow("managed_service_capability_unverified");
    expect(billing).not.toHaveBeenCalled();
    expect(await f.db.prepare("SELECT COUNT(*) AS n FROM managed_service_operations WHERE provider='agentmail'").first<{n:number}>()).toMatchObject({n:0});
    await verifyTestAgentMailCapability(f);
    (f.env as unknown as {AGENTMAIL_REGION:string}).AGENTMAIL_REGION="eu";
    await expect(provisionManagedAgentMail(f.env,scope,identity)).rejects.toThrow("managed_service_region_not_verified");
    expect(billing).not.toHaveBeenCalled();
  });
  it("renews managed mailboxes through the shared reservation and usage ledger path",async()=>{
    const f=fixture();const identity=await ensureIdentity(f.env,scope);const billingActions:string[]=[];
    const billing=vi.fn(async(request:Request)=>{billingActions.push(new URL(request.url).pathname.split("/").at(-1)??"");return Response.json({reserved:true,settled:true});});
    await verifyTestAgentMailCapability(f);
    (f.env as unknown as {BILLING_WORKER:{fetch:typeof billing}}).BILLING_WORKER={fetch:billing};
    const activated="2026-01-31T00:00:00.000Z",due="2026-02-28T00:00:00.000Z";
    await f.db.prepare(`INSERT INTO assistant_agentmail_accounts(
      id,tenant_id,space_id,assistant_identity_id,agentport_agent_id,owner_user_id,mode,pod_id,inbox_id,email_address,status,activated_at,next_billing_at,created_at,updated_at)
      VALUES('amc-renew','tenant','space',?,'agent-renew','user','naelao_managed','pod-1','inbox-renew','renew@mail.example.test','active',?,?,?,?)`)
      .bind(identity.id,activated,due,activated,activated).run();
    await f.db.prepare(`INSERT INTO managed_service_accounts(
      id,tenant_id,space_id,provider,service_id,connection_mode,provider_resource_ref,provider_account_ref,
      credential_ref,owner_type,owner_id,provider_payer_type,provider_payer_id,credit_payer_type,credit_payer_id,region,
      lifecycle_state,metadata_json,created_at,updated_at)
      VALUES('amc-renew','tenant','space','agentmail','agentmail','naelao_managed','inbox-renew','pod-1','amc-renew',
      'organization','tenant','platform','naelao','organization','tenant','us','active','{}',?,?)`)
      .bind(activated,activated).run();
    const result=await sweepManagedAgentMailRentals(f.env,new Date("2026-03-01T00:00:00.000Z"));
    expect(result).toMatchObject({checked:1,billed:1,held:0});
    expect(billingActions).toEqual(["reserve","settle"]);
    expect(await f.db.prepare("SELECT operation_name,status,reservation_id,reserved_credits,price_version,quote_id,provider_operation_ref FROM managed_service_operations WHERE operation_name='renew'")
      .first<Record<string,unknown>>()).toMatchObject({operation_name:"renew",status:"complete",reservation_id:expect.stringContaining("agentmail_rent_"),reserved_credits:300,price_version:"agentmail-rental-v2",quote_id:expect.stringMatching(/^msq_[a-f0-9]{32}$/),provider_operation_ref:"inbox-renew"});
    expect(billing.mock.calls[0]?.[0]&&await (billing.mock.calls[0]![0] as Request).clone().json()).toMatchObject({quote_id:expect.stringMatching(/^msq_[a-f0-9]{32}$/),requester_user_id:"user"});
    expect(await f.db.prepare("SELECT status,request_sha256,operation_id FROM managed_service_operation_quotes WHERE operation_name='renew'")
      .first<Record<string,unknown>>()).toMatchObject({status:"consumed",request_sha256:expect.stringMatching(/^[a-f0-9]{64}$/),operation_id:expect.stringMatching(/^agentmail_renew_/) });
    expect(await f.db.prepare("SELECT status,next_billing_at FROM assistant_agentmail_accounts WHERE id='amc-renew'").first<Record<string,string>>())
      .toMatchObject({status:"active",next_billing_at:"2026-03-31T00:00:00.000Z"});
  });
});
