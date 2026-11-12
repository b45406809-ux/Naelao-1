import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mintInternalToken } from "@naelao/http";
import { fixture, scope } from "../../../../tests/fixtures/assistant-communications.js";
import type { AgentsEnv } from "../index.js";
import { ensureIdentity } from "./core.js";
import { connectHiggsfieldAccount } from "./higgsfield.js";
import { authorizeHiggsfieldAgentOperation, revokeHiggsfieldAgentPortShare, shareHiggsfieldWithAgentPort } from "./higgsfield-agentport.js";
import { registerCommunicationRoutes } from "./routes.js";

function port(env: ReturnType<typeof fixture>["env"]) {
  const calls: Array<{ path:string; method:string; body:Record<string,unknown> }> = [];
  let allow=true;
  const fetch=vi.fn(async (request:Request) => {
    const path=new URL(request.url).pathname.replace("/internal/agentport","");
    const method=request.method;
    const body=method==="GET"?{}:await request.clone().json().catch(()=>({})) as Record<string,unknown>;
    calls.push({path,method,body});
    if(path.startsWith("/services/")&&method==="GET")return Response.json({error_code:"service_unavailable"},{status:404});
    if(path==="/services"&&method==="POST")return Response.json({service:{id:body.id,status:"active",capabilities:body.capabilities}},{status:201});
    if(path==="/agents")return Response.json({agent:{id:body.id,status:"active"}},{status:201});
    if(path==="/principals")return Response.json({principal:{id:body.id,external_id:body.externalId,principal_type:"individual"}},{status:201});
    if(path==="/accounts")return Response.json({account:{id:"higgs-account",status:"pending"}},{status:201});
    if(path.endsWith("/actions/authorize"))return Response.json({decision:allow?"allow":"deny"});
    if(path.endsWith("/revoke"))return Response.json({revoked:true});
    return Response.json({active:true,grant:{id:"grant-1"}});
  });
  env.AGENTPORT_WORKER={fetch} as unknown as Fetcher;
  return {calls,fetch,setAllow:(value:boolean)=>{allow=value;}};
}

describe("Higgsfield AgentPort owner share",()=>{
  it("registers a customer-owned reference, grants only estimate and generation, authorizes before use, and revokes",async()=>{
    const f=fixture();
    (f.env as unknown as {HIGGSFIELD_BYO_ENABLED:string}).HIGGSFIELD_BYO_ENABLED="true";
    const identity=await ensureIdentity(f.env,scope);
    const connected=await connectHiggsfieldAccount(f.env,scope,identity,{apiKey:"key-id:secret-value-0123456789"});
    const agentPort=port(f.env);
    const shared=await shareHiggsfieldWithAgentPort(f.env,scope,identity,connected.id);
    expect(shared).toMatchObject({shared:true,actions:["higgsfield.video.estimate","higgsfield.video.generate"],idempotent:false});
    expect(agentPort.calls.find(call=>call.path==="/services"&&call.method==="POST")?.body.capabilities)
      .toEqual(["higgsfield.video.estimate","higgsfield.video.generate"]);
    expect(agentPort.calls.find(call=>call.path==="/accounts")?.body).toMatchObject({accountModel:"agent_native",ownerType:"individual",ownerId:"user",credentialRef:connected.id});
    expect(JSON.stringify(agentPort.calls)).not.toContain("secret-value");
    expect(f.db.db.prepare("SELECT agentport_link_status,agentport_account_id,agentport_agent_id FROM managed_service_accounts WHERE id=?")
      .get(connected.id)).toMatchObject({agentport_link_status:"active",agentport_account_id:"higgs-account"});
    const linkedAgentId=String(f.db.db.prepare("SELECT agentport_agent_id FROM managed_service_accounts WHERE id=?").get<{agentport_agent_id:string}>(connected.id)?.agentport_agent_id);
    await expect(authorizeHiggsfieldAgentOperation(f.env,scope,connected.id,linkedAgentId,"generate","opaque-request-hash"))
      .resolves.toEqual({authorized:true});
    const authorize=agentPort.calls.find(call=>call.path.endsWith("/actions/authorize"))!;
    expect(authorize.body).toMatchObject({agentId:linkedAgentId,action:"higgsfield.video.generate",resourceRef:connected.id});
    expect(JSON.stringify(authorize.body)).not.toContain("private prompt");
    expect(await revokeHiggsfieldAgentPortShare(f.env,scope,identity,connected.id)).toMatchObject({revoked:true,alreadyUnlinked:false});
    await expect(authorizeHiggsfieldAgentOperation(f.env,scope,connected.id,linkedAgentId,"generate","next-request"))
      .rejects.toThrow("higgsfield_agentport_share_required");
    expect(f.db.db.prepare("SELECT agentport_link_status FROM managed_service_accounts WHERE id=?").get(connected.id))
      .toMatchObject({agentport_link_status:"revoked"});
  });

  it("refuses an AgentPort action if the provider account is not shared or the grant denies",async()=>{
    const f=fixture();
    (f.env as unknown as {HIGGSFIELD_BYO_ENABLED:string}).HIGGSFIELD_BYO_ENABLED="true";
    const identity=await ensureIdentity(f.env,scope);
    const connected=await connectHiggsfieldAccount(f.env,scope,identity,{apiKey:"key-id:secret-value-0123456789"});
    const agentPort=port(f.env);
    const linkedAgentId=String(f.db.db.prepare("SELECT agentport_agent_id FROM managed_service_accounts WHERE id=?").get<{agentport_agent_id:string}>(connected.id)?.agentport_agent_id ?? "naelao-agent");
    await expect(authorizeHiggsfieldAgentOperation(f.env,scope,connected.id,linkedAgentId,"estimate","request-hash"))
      .rejects.toThrow("higgsfield_agentport_share_required");
    await shareHiggsfieldWithAgentPort(f.env,scope,identity,connected.id);
    const actualAgentId=String(f.db.db.prepare("SELECT agentport_agent_id FROM managed_service_accounts WHERE id=?").get<{agentport_agent_id:string}>(connected.id)?.agentport_agent_id);
    agentPort.setAllow(false);
    await expect(authorizeHiggsfieldAgentOperation(f.env,scope,connected.id,actualAgentId,"estimate","request-hash"))
      .rejects.toThrow("higgsfield_agentport_action_denied");
  });

  it("routes owner share and agent generation through the authenticated actions before provider egress",async()=>{
    const f=fixture();
    (f.env as unknown as {HIGGSFIELD_BYO_ENABLED:string}).HIGGSFIELD_BYO_ENABLED="true";
    f.db.db.prepare(`UPDATE managed_service_capability_versions SET status='verified',regions_json='["global"]',verified_by='test-operator',
      verified_at='2026-11-12T00:00:00.000Z',valid_until='2099-12-31T00:00:00.000Z'
      WHERE provider='higgsfield' AND service_id='kling-video-v4-text-to-video' AND version=1`).run();
    const identity=await ensureIdentity(f.env,scope);
    const account=await connectHiggsfieldAccount(f.env,scope,identity,{apiKey:"key-id:secret-value-0123456789"});
    const agentPort=port(f.env);
    const providerFetch=vi.fn(async()=>Response.json({usd:"0.125"}));
    vi.stubGlobal("fetch",providerFetch);
    const app=new Hono<{Bindings:AgentsEnv}>();
    registerCommunicationRoutes(app);
    const ownerHeaders={"content-type":"application/json","x-naelao-tenant-id":"tenant","x-naelao-user-id":"user",
      "x-naelao-role":"product_end_user","x-naelao-internal-token":await mintInternalToken("secret","tenant")};
    const shared=await app.request("/spaces/space/assistant-communications",{method:"POST",headers:ownerHeaders,
      body:JSON.stringify({action:"higgsfield-agentport-share",account_id:account.id})},f.env);
    expect(shared.status).toBe(200);
    const agentId=String(f.db.db.prepare("SELECT agentport_agent_id FROM managed_service_accounts WHERE id=?").get<{agentport_agent_id:string}>(account.id)?.agentport_agent_id);
    const agentHeaders={...ownerHeaders,"x-naelao-agent-id":agentId};
    const response=await app.request("/internal/assistant-communications",{method:"POST",headers:agentHeaders,
      body:JSON.stringify({spaceId:"space",action:"higgsfield-estimate",account_id:account.id,request:{prompt:"private prompt"}})},f.env);
    expect(response.status).toBe(200);
    expect(providerFetch).toHaveBeenCalledOnce();
    const authorization=agentPort.calls.find(call=>call.path.endsWith("/actions/authorize"))!;
    expect(authorization.body).toMatchObject({agentId,action:"higgsfield.video.estimate",resourceRef:account.id});
    expect(JSON.stringify(authorization.body)).not.toContain("private prompt");
  });
});
