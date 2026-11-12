import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mintInternalToken } from "@naelao/http";
import { fixture, scope } from "../../../../tests/fixtures/assistant-communications.js";
import type { AgentsEnv } from "../index.js";
import { registerCommunicationRoutes } from "./routes.js";
import { discoverUserPortAgentPortConnector, revokeUserPortAgentPortConnector, sweepUserPortAgentPortRevocations,
  revokeUserPortAgentPortOwnerLink, sweepUserPortAgentPortOperations, sweepUserPortAgentPortSyncs,
  syncUserPortAgentPortConnector } from "./userport-agentport-sync.js";

function addAliasTables(f: ReturnType<typeof fixture>, input: { scope?:"space"|"project"|"user"; projectId?:string|null; userId?:string|null } = {}) {
  f.db.db.exec(`CREATE TABLE mcp_servers(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,space_id TEXT NOT NULL,name TEXT NOT NULL,
    enabled INTEGER NOT NULL,connector_provider TEXT NOT NULL,provider_connection_id TEXT);
    CREATE TABLE connector_aliases(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,space_id TEXT NOT NULL,alias TEXT NOT NULL,
      scope TEXT NOT NULL,project_id TEXT,user_id TEXT,server_id TEXT NOT NULL,granted_scopes_json TEXT NOT NULL DEFAULT '[]');
    INSERT INTO mcp_servers(id,tenant_id,space_id,name,enabled,connector_provider,provider_connection_id)
      VALUES('server-1','tenant','space','Gmail',1,'composio','connected-1');
    INSERT INTO connector_aliases(id,tenant_id,space_id,alias,scope,project_id,user_id,server_id)
      VALUES('alias-1','tenant','space','primary_mail','${input.scope ?? "space"}',${input.projectId ? `'${input.projectId}'` : "NULL"},
        ${input.userId ? `'${input.userId}'` : "NULL"},'server-1');`);
}

function agentPortFetch() {
  const calls: Array<{path:string;method:string;body:Record<string,unknown>}> = [];
  let accountStatus = "pending";
  let failRevoke = false;
  let failGrant = false;
  let onGrant: (()=>void)|null = null;
  const fetch = vi.fn(async (request: Request) => {
    const path = new URL(request.url).pathname;
    const method = request.method;
    const body = method === "GET" ? {} : await request.clone().json().catch(() => ({})) as Record<string,unknown>;
    calls.push({path,method,body});
    if (path.endsWith("/identity")) return Response.json({identity:{principal:{id:"principal-org",type:"organization"}}});
    if (path.endsWith("/principals")) return Response.json({principal:{id:body.id,external_id:body.externalId,principal_type:"individual"}},{status:201});
    if (path.startsWith("/internal/agentport/services/") && method === "GET") return Response.json({error_code:"service_unavailable"},{status:404});
    if (path.endsWith("/services") && method === "POST") return Response.json({service:body},{status:201});
    if (path.endsWith("/accounts") && method === "POST") return Response.json({account:{id:"acct-userport",status:accountStatus}},{status:201});
    if (path.endsWith("/activate")) { accountStatus="active"; return Response.json({active:true}); }
    if (path.endsWith("/grants")) {
      onGrant?.();
      if (failGrant) { failGrant=false; return Response.json({error_code:"temporary_failure"},{status:503}); }
      return Response.json({grant:{id:"grant-userport"}},{status:201});
    }
    if (path.endsWith("/revoke")) {
      if (failRevoke) { failRevoke=false; return Response.json({error_code:"temporary_failure"},{status:503}); }
      accountStatus="revoked"; return Response.json({revoked:true});
    }
    return Response.json({ok:true});
  });
  return {fetch,calls,failNextRevoke(){failRevoke=true;},failNextGrant(){failGrant=true;},onGrant(callback:()=>void){onGrant=callback;}};
}

function setup() {
  const f = fixture();
  addAliasTables(f);
  const port = agentPortFetch();
  const hubFetch = vi.fn(async () => Response.json({tools:[{name:"GMAIL_SEND",description:"send"},{name:"GMAIL_LIST",description:"list"}]}));
  f.env.AGENTPORT_WORKER = {fetch:port.fetch} as unknown as Fetcher;
  f.env.MCP_HUB = {fetch:hubFetch} as unknown as Fetcher;
  return {f,port,hubFetch,env:f.env as AgentsEnv};
}

describe("UserPort to AgentPort connector synchronization", () => {
  it("discovers live tools without exposing provider credentials or accepting aliases from another Space", async () => {
    const t=setup();
    await expect(discoverUserPortAgentPortConnector(t.env,scope,"alias-1")).resolves.toMatchObject({
      aliasId:"alias-1",provider:"composio",tools:[{name:"GMAIL_SEND"},{name:"GMAIL_LIST"}],
    });
    expect(t.port.fetch).not.toHaveBeenCalled();
    await expect(discoverUserPortAgentPortConnector(t.env,{...scope,spaceId:"other"},"alias-1")).rejects.toThrow("not_found");
  });

  it("registers only owner-selected actions and persists a consented reference plus exact AgentPort grant", async () => {
    const t=setup();
    const result=await syncUserPortAgentPortConnector(t.env,scope,"alias-1",["GMAIL_SEND"]);
    expect(result).toMatchObject({aliasId:"alias-1",accountId:"acct-userport",operations:["GMAIL_SEND"],revision:1,idempotent:false});
    const service=t.port.calls.find((call)=>call.method==="POST"&&call.path.endsWith("/services"))!;
    const grant=t.port.calls.find((call)=>call.path.endsWith("/grants"))!;
    expect(service.body.capabilities).toHaveLength(1);
    expect(grant.body.permissions).toEqual(service.body.capabilities);
    expect(JSON.stringify(t.port.calls)).not.toContain("connected-1");
    expect(t.f.db.db.prepare("SELECT status,created_by,tool_actions_json FROM agentport_userport_connector_bindings WHERE alias_id='alias-1'").get())
      .toMatchObject({status:"active",created_by:"user"});
    expect(t.f.db.db.prepare("SELECT status,operation_name,provider_operation_ref FROM managed_service_operations WHERE operation_name='agentport_connector_sync'").get())
      .toMatchObject({status:"complete",provider_operation_ref:"acct-userport"});
    expect(t.f.db.db.prepare("SELECT consent_source,status FROM managed_service_owner_links").get())
      .toMatchObject({consent_source:"userport.connector_sync",status:"active"});
    await expect(syncUserPortAgentPortConnector(t.env,scope,"alias-1",["GMAIL_SEND"])).resolves.toMatchObject({idempotent:true,revision:1});
  });

  it("rejects stale action choices before creating an AgentPort service or grant", async () => {
    const t=setup();
    await expect(syncUserPortAgentPortConnector(t.env,scope,"alias-1",["GMAIL_DELETE"])).rejects.toThrow("selection_stale");
    expect(t.port.fetch).not.toHaveBeenCalled();
  });

  it("revokes the AgentPort account and mapping on explicit unlink", async () => {
    const t=setup();
    await syncUserPortAgentPortConnector(t.env,scope,"alias-1",["GMAIL_SEND"]);
    await expect(revokeUserPortAgentPortConnector(t.env,scope,"alias-1")).resolves.toMatchObject({revoked:true});
    expect(t.f.db.db.prepare("SELECT status FROM agentport_userport_connector_bindings WHERE alias_id='alias-1'").get())
      .toMatchObject({status:"revoked"});
    expect(t.port.calls.filter((call)=>call.path.endsWith("/revoke"))).toHaveLength(1);
  });

  it("journals uncertain owner revocation and retries the exact account before marking the link revoked", async () => {
    const t=setup();
    await syncUserPortAgentPortConnector(t.env,scope,"alias-1",["GMAIL_SEND"]);
    t.port.failNextRevoke();
    await expect(revokeUserPortAgentPortConnector(t.env,scope,"alias-1")).rejects.toThrow("agentport_temporary_failure");
    expect(t.f.db.db.prepare("SELECT status FROM agentport_userport_connector_bindings WHERE alias_id='alias-1'").get())
      .toMatchObject({status:"sync_required"});
    expect(t.f.db.db.prepare("SELECT status FROM managed_service_operations WHERE operation_name='agentport_connector_revoke'").get())
      .toMatchObject({status:"uncertain"});
    expect(t.f.db.db.prepare("SELECT next_reconcile_at FROM managed_service_operations WHERE operation_name='agentport_connector_revoke'").get<{next_reconcile_at:string}>()?.next_reconcile_at).toBeTruthy();
    await expect(syncUserPortAgentPortConnector(t.env,scope,"alias-1",["GMAIL_LIST"])).rejects.toThrow("userport_agentport_revoke_pending");
    await expect(revokeUserPortAgentPortConnector(t.env,scope,"alias-1")).resolves.toMatchObject({revoked:true,idempotent:false});
    expect(t.f.db.db.prepare("SELECT status,previous_account_id FROM agentport_userport_connector_bindings WHERE alias_id='alias-1'").get())
      .toMatchObject({status:"revoked"});
    expect(t.f.db.db.prepare("SELECT status FROM managed_service_operations WHERE operation_name='agentport_connector_revoke'").get())
      .toMatchObject({status:"complete"});
  });

  it("automatically retries a due uncertain revoke only while its exact account set remains bound", async () => {
    const t=setup();
    await syncUserPortAgentPortConnector(t.env,scope,"alias-1",["GMAIL_SEND"]);
    t.port.failNextRevoke();
    await expect(revokeUserPortAgentPortConnector(t.env,scope,"alias-1")).rejects.toThrow("agentport_temporary_failure");
    t.f.db.db.prepare("UPDATE managed_service_operations SET next_reconcile_at='2000-01-01T00:00:00.000Z' WHERE operation_name='agentport_connector_revoke'").run();
    await expect(sweepUserPortAgentPortRevocations(t.env,new Date(Date.now()+120_000),10)).resolves.toEqual({checked:1,reconciled:1,deferred:0,failed:0});
    expect(t.f.db.db.prepare("SELECT status FROM managed_service_operations WHERE operation_name='agentport_connector_revoke'").get())
      .toMatchObject({status:"complete"});
    expect(t.f.db.db.prepare("SELECT status FROM agentport_userport_connector_bindings WHERE alias_id='alias-1'").get())
      .toMatchObject({status:"revoked"});
    expect(t.port.calls.filter(call=>call.path.endsWith("/revoke"))).toHaveLength(2);

    const drift=setup();
    await syncUserPortAgentPortConnector(drift.env,scope,"alias-1",["GMAIL_SEND"]);
    drift.port.failNextRevoke();
    await expect(revokeUserPortAgentPortConnector(drift.env,scope,"alias-1")).rejects.toThrow("agentport_temporary_failure");
    drift.f.db.db.prepare("UPDATE agentport_userport_connector_bindings SET account_id='acct-rebound' WHERE alias_id='alias-1'").run();
    drift.f.db.db.prepare("UPDATE managed_service_operations SET next_reconcile_at='2000-01-01T00:00:00.000Z' WHERE operation_name='agentport_connector_revoke'").run();
    await expect(sweepUserPortAgentPortRevocations(drift.env,new Date(Date.now()+120_000),10)).resolves.toEqual({checked:1,reconciled:0,deferred:1,failed:0});
    expect(drift.f.db.db.prepare("SELECT status,error_code FROM managed_service_operations WHERE operation_name='agentport_connector_revoke'").get())
      .toMatchObject({status:"held",error_code:"userport_agentport_revoke_scope_changed"});
    expect(drift.port.calls.filter(call=>call.path.endsWith("/revoke"))).toHaveLength(1);
  });

  it("links a personal connector to the individual owner and revokes that owner link through the authenticated route", async () => {
    const t=setup();
    t.f.db.db.exec("UPDATE connector_aliases SET scope='user',user_id='user' WHERE id='alias-1'");
    const synced=await syncUserPortAgentPortConnector(t.env,scope,"alias-1",["GMAIL_SEND"]);
    expect(synced).toMatchObject({accountId:"acct-userport"});
    expect(t.f.db.db.prepare("SELECT owner_type,owner_id,status FROM managed_service_owner_links").get())
      .toEqual({owner_type:"user",owner_id:"user",status:"active"});

    const app=new Hono<{Bindings:AgentsEnv}>();
    registerCommunicationRoutes(app);
    const headers={"content-type":"application/json","x-naelao-tenant-id":"tenant","x-naelao-user-id":"user",
      "x-naelao-role":"product_end_user","x-naelao-internal-token":await mintInternalToken("secret","tenant")};
    const ownerLinkId=String(t.f.db.db.prepare("SELECT id FROM managed_service_owner_links").get<{id:string}>()?.id);
    const result=await app.request("/spaces/space/assistant-communications",{method:"POST",headers,
      body:JSON.stringify({action:"userport-agentport-owner-unlink",owner_link_id:ownerLinkId})},t.f.env);
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({revoked:true,aliasCount:1});
    expect(t.f.db.db.prepare("SELECT status FROM managed_service_owner_links WHERE id=?").get(ownerLinkId))
      .toMatchObject({status:"revoked"});
    expect(t.f.db.db.prepare("SELECT status FROM agentport_userport_connector_bindings WHERE alias_id='alias-1'").get())
      .toMatchObject({status:"revoked"});
  });

  it("schedules and resumes an uncertain sync using the same selected actions and operation", async () => {
    const t=setup();
    t.port.failNextGrant();
    await expect(syncUserPortAgentPortConnector(t.env,scope,"alias-1",["GMAIL_SEND"]))
      .rejects.toThrow("agentport_temporary_failure");
    const failed=t.f.db.db.prepare("SELECT operation_id,status,next_reconcile_at,request_json FROM managed_service_operations WHERE operation_name='agentport_connector_sync'")
      .get<{operation_id:string;status:string;next_reconcile_at:string|null;request_json:string}>()!;
    expect(failed.status).toBe("uncertain");
    expect(failed.next_reconcile_at).toBeTruthy();
    expect(JSON.parse(failed.request_json)).toMatchObject({aliasId:"alias-1",userId:"user",revision:1,actions:[{toolName:"GMAIL_SEND"}]});
    t.f.db.db.prepare("UPDATE managed_service_operations SET next_reconcile_at='2000-01-01T00:00:00.000Z' WHERE operation_id=?").run(failed.operation_id);
    await expect(sweepUserPortAgentPortOperations(t.env,new Date(Date.now()+120_000),10)).resolves.toEqual({checked:1,reconciled:1,deferred:0,failed:0});
    expect(t.f.db.db.prepare("SELECT status,provider_operation_ref FROM managed_service_operations WHERE operation_id=?").get(failed.operation_id))
      .toMatchObject({status:"complete",provider_operation_ref:"acct-userport"});
    expect(t.f.db.db.prepare("SELECT status,revision,tool_actions_json FROM agentport_userport_connector_bindings WHERE alias_id='alias-1'").get())
      .toMatchObject({status:"active",revision:1,tool_actions_json:expect.stringContaining("GMAIL_SEND")});
    expect(t.port.calls.filter(call=>call.method==="POST"&&call.path.endsWith("/accounts"))).toHaveLength(2);
  });

  it("holds an uncertain sync if the selected tool disappears before retry", async () => {
    const t=setup();
    t.port.failNextGrant();
    await expect(syncUserPortAgentPortConnector(t.env,scope,"alias-1",["GMAIL_SEND"]))
      .rejects.toThrow("agentport_temporary_failure");
    const operation=t.f.db.db.prepare("SELECT operation_id FROM managed_service_operations WHERE operation_name='agentport_connector_sync'").get<{operation_id:string}>()!;
    t.f.db.db.prepare("UPDATE managed_service_operations SET next_reconcile_at='2000-01-01T00:00:00.000Z' WHERE operation_id=?").run(operation.operation_id);
    t.hubFetch.mockResolvedValue(Response.json({tools:[{name:"GMAIL_LIST"}]}));
    const callsBefore=t.port.calls.length;
    await expect(sweepUserPortAgentPortSyncs(t.env,new Date(Date.now()+120_000),10)).resolves.toEqual({checked:1,reconciled:0,deferred:1,failed:0});
    expect(t.f.db.db.prepare("SELECT status,error_code,next_reconcile_at FROM managed_service_operations WHERE operation_id=?").get(operation.operation_id))
      .toMatchObject({status:"held",error_code:"userport_connector_selection_stale",next_reconcile_at:null});
    expect(t.port.calls).toHaveLength(callsBefore);
  });

  it("lets explicit alias unlink schedule exact cleanup for a held sync without replaying its grant", async () => {
    const t=setup();
    t.port.failNextGrant();
    await expect(syncUserPortAgentPortConnector(t.env,scope,"alias-1",["GMAIL_SEND"]))
      .rejects.toThrow("agentport_temporary_failure");
    const operation=t.f.db.db.prepare("SELECT operation_id FROM managed_service_operations WHERE operation_name='agentport_connector_sync'")
      .get<{operation_id:string}>()!;
    t.f.db.db.prepare("UPDATE managed_service_operations SET next_reconcile_at='2000-01-01T00:00:00.000Z' WHERE operation_id=?")
      .run(operation.operation_id);
    t.hubFetch.mockResolvedValue(Response.json({tools:[{name:"GMAIL_LIST"}]}));
    await expect(sweepUserPortAgentPortSyncs(t.env,new Date(Date.now()+120_000),10))
      .resolves.toEqual({checked:1,reconciled:0,deferred:1,failed:0});
    await expect(revokeUserPortAgentPortConnector(t.env,scope,"alias-1"))
      .rejects.toThrow("userport_agentport_sync_cleanup_pending");
    expect(t.f.db.db.prepare("SELECT status,error_code FROM managed_service_operations WHERE operation_id=?").get(operation.operation_id))
      .toMatchObject({status:"uncertain",error_code:"userport_connector_cleanup_requested"});
    const callsBefore=t.port.calls.filter(call=>call.path.endsWith("/grants")).length;
    await expect(sweepUserPortAgentPortSyncs(t.env,new Date(Date.now()+120_000),10))
      .resolves.toEqual({checked:1,reconciled:1,deferred:0,failed:0});
    expect(t.f.db.db.prepare("SELECT status,error_code FROM managed_service_operations WHERE operation_id=?").get(operation.operation_id))
      .toMatchObject({status:"cancelled",error_code:"userport_connector_unlinked"});
    expect(t.f.db.db.prepare("SELECT status FROM agentport_userport_connector_bindings WHERE alias_id='alias-1'").get())
      .toMatchObject({status:"revoked"});
    expect(t.port.calls.filter(call=>call.path.endsWith("/grants"))).toHaveLength(callsBefore);
    expect(t.port.calls.filter(call=>call.path.endsWith("/revoke"))).toHaveLength(1);
  });

  it("revokes an owner link with a recoverable held sync and completes its scheduled cleanup", async () => {
    const t=setup();
    t.port.failNextGrant();
    await expect(syncUserPortAgentPortConnector(t.env,scope,"alias-1",["GMAIL_SEND"]))
      .rejects.toThrow("agentport_temporary_failure");
    const operation=t.f.db.db.prepare("SELECT operation_id FROM managed_service_operations WHERE operation_name='agentport_connector_sync'")
      .get<{operation_id:string}>()!;
    t.f.db.db.prepare("UPDATE managed_service_operations SET next_reconcile_at='2000-01-01T00:00:00.000Z' WHERE operation_id=?")
      .run(operation.operation_id);
    t.hubFetch.mockResolvedValue(Response.json({tools:[{name:"GMAIL_LIST"}]}));
    await sweepUserPortAgentPortSyncs(t.env,new Date(Date.now()+120_000),10);
    const ownerLinkId=String(t.f.db.db.prepare("SELECT id FROM managed_service_owner_links").get<{id:string}>()?.id);
    await expect(revokeUserPortAgentPortOwnerLink(t.env,scope,ownerLinkId)).resolves.toMatchObject({revoked:true,cleanupPending:1});
    expect(t.f.db.db.prepare("SELECT status FROM managed_service_owner_links WHERE id=?").get(ownerLinkId))
      .toMatchObject({status:"revoked"});
    await expect(sweepUserPortAgentPortSyncs(t.env,new Date(Date.now()+120_000),10))
      .resolves.toEqual({checked:1,reconciled:1,deferred:0,failed:0});
    expect(t.f.db.db.prepare("SELECT status,error_code FROM managed_service_operations WHERE operation_id=?").get(operation.operation_id))
      .toMatchObject({status:"cancelled",error_code:"userport_owner_link_revoked"});
    expect(t.f.db.db.prepare("SELECT status FROM agentport_userport_connector_bindings WHERE alias_id='alias-1'").get())
      .toMatchObject({status:"revoked"});
    expect(t.port.calls.filter(call=>call.path.endsWith("/revoke"))).toHaveLength(1);
  });

  it("revokes the just-created AgentPort account if owner unlink wins during sync", async () => {
    const t=setup();
    t.port.onGrant(()=>t.f.db.db.prepare("UPDATE managed_service_owner_links SET status='revoked',revoked_at='2026-11-12T00:00:00.000Z' WHERE consent_source='userport.connector_sync'").run());
    await expect(syncUserPortAgentPortConnector(t.env,scope,"alias-1",["GMAIL_SEND"]))
      .rejects.toThrow("userport_owner_link_revoked");
    expect(t.f.db.db.prepare("SELECT status FROM agentport_userport_connector_bindings WHERE alias_id='alias-1'").get())
      .toMatchObject({status:"revoked"});
    expect(t.f.db.db.prepare("SELECT status,error_code FROM managed_service_operations WHERE operation_name='agentport_connector_sync'").get())
      .toMatchObject({status:"cancelled",error_code:"userport_owner_link_revoked"});
    expect(t.port.calls.filter(call=>call.path.endsWith("/revoke"))).toHaveLength(1);
  });

  it("cleans an uncertain AgentPort account when the owner link is revoked before scheduled retry", async () => {
    const t=setup();
    t.port.failNextGrant();
    await expect(syncUserPortAgentPortConnector(t.env,scope,"alias-1",["GMAIL_SEND"]))
      .rejects.toThrow("agentport_temporary_failure");
    const operation=t.f.db.db.prepare("SELECT operation_id FROM managed_service_operations WHERE operation_name='agentport_connector_sync'").get<{operation_id:string}>()!;
    t.f.db.db.prepare("UPDATE managed_service_owner_links SET status='revoked',revoked_at='2026-11-12T00:00:00.000Z'").run();
    t.f.db.db.prepare("UPDATE managed_service_operations SET next_reconcile_at='2000-01-01T00:00:00.000Z' WHERE operation_id=?").run(operation.operation_id);
    await expect(sweepUserPortAgentPortOperations(t.env,new Date(Date.now()+120_000),10)).resolves.toEqual({checked:1,reconciled:1,deferred:0,failed:0});
    expect(t.f.db.db.prepare("SELECT status,error_code FROM managed_service_operations WHERE operation_id=?").get(operation.operation_id))
      .toMatchObject({status:"cancelled",error_code:"userport_owner_link_revoked"});
    expect(t.f.db.db.prepare("SELECT status FROM agentport_userport_connector_bindings WHERE alias_id='alias-1'").get())
      .toMatchObject({status:"revoked"});
    expect(t.port.calls.filter(call=>call.path.endsWith("/revoke"))).toHaveLength(1);
  });
});
