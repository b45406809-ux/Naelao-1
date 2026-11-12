import { describe, expect, it, vi } from "vitest";
import { authorizeUserPortConnectorTool } from "./agentport-connector-gate.js";

function binding(overrides: Record<string, unknown> = {}) {
  return { alias_id:"alias-1",current_alias_id:"alias-1",alias_server_id:"server-1",server_id:"server-1",scope:"space",project_id:null,user_id:null,provider:"composio",provider_connection_id:"connected-account-1",
    enabled:1,account_id:"acct-1",agent_id:"agent-1",owner_link_status:"active",tool_actions_json:JSON.stringify([{toolName:"GMAIL_SEND",action:"mcp.tool.abc123"}]),
    provider_connection_sha256:"",status:"active",...overrides };
}
async function connectionHash(value: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2,"0")).join("");
}
function env(rows: Array<Record<string, unknown>>, fetch = vi.fn(async (_request: Request) => Response.json({decision:"allow"})), pendingSync = false) {
  const statements: string[] = [];
  const PLATFORM_DB = { prepare: (sql: string) => {
    statements.push(sql);
    return { bind: (..._args: unknown[]) => ({
      all: async () => ({results:rows}), first: async () => sql.includes("managed_service_operations")
        ? (pendingSync ? {operation_id:"sync-1"} : null) : rows[0] ?? null,
      run: async () => ({meta:{changes:1}}),
    }) };
  } } as unknown as D1Database;
  return { env:{PLATFORM_DB,PLATFORM_SECRET:"secret",AGENTPORT_WORKER:{fetch} as unknown as Fetcher},fetch,statements };
}

const base = { tenantId:"tenant",spaceId:"space",serverId:"server-1",provider:"composio",aliasId:"alias-1",toolName:"GMAIL_SEND",
  userId:"user",projectId:"",runId:"run-1",requestBody:{tool_name:"GMAIL_SEND",input:{to:"private@example.com"}} };

describe("UserPort AgentPort action boundary", () => {
  it("leaves an unmapped connector on its existing path", async () => {
    const f = env([]);
    await expect(authorizeUserPortConnectorTool({...base,env:f.env})).resolves.toEqual({required:false,allowed:true});
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("blocks a first-time alias call while its AgentPort sync is pending or uncertain", async () => {
    const f = env([], vi.fn(async (_request: Request) => Response.json({decision:"allow"})), true);
    await expect(authorizeUserPortConnectorTool({...base,env:f.env})).resolves.toMatchObject({
      required:true,allowed:false,status:409,errorCode:"agentport_connector_sync_pending",
    });
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("authorizes only a selected operation without sending its provider payload to AgentPort", async () => {
    const row = binding({provider_connection_sha256:await connectionHash("connected-account-1")});
    const f = env([row]);
    await expect(authorizeUserPortConnectorTool({...base,env:f.env})).resolves.toEqual({required:true,allowed:true});
    expect(f.fetch).toHaveBeenCalledTimes(1);
    const request = f.fetch.mock.calls[0]?.[0] as Request;
    const body = await request.clone().json() as Record<string,unknown>;
    expect(body).toMatchObject({agentId:"agent-1",action:"mcp.tool.abc123",resourceRef:"alias-1"});
    expect(JSON.stringify(body)).not.toContain("private@example.com");
  });

  it("blocks direct MCP-server calls after any UserPort alias is linked", async () => {
    const f = env([binding({provider_connection_sha256:await connectionHash("connected-account-1")})]);
    await expect(authorizeUserPortConnectorTool({...base,aliasId:null,env:f.env})).resolves.toMatchObject({
      required:true,allowed:false,status:403,errorCode:"agentport_connector_alias_required",
    });
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("denies a tool absent from the exact synchronized capability list", async () => {
    const f = env([binding({provider_connection_sha256:await connectionHash("connected-account-1")})]);
    await expect(authorizeUserPortConnectorTool({...base,toolName:"GMAIL_DELETE",env:f.env})).resolves.toMatchObject({
      required:true,allowed:false,status:403,errorCode:"agentport_connector_operation_not_selected",
    });
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("requires a fresh sync when the upstream connection changes", async () => {
    const f = env([binding({provider_connection_sha256:"f".repeat(64)})]);
    await expect(authorizeUserPortConnectorTool({...base,env:f.env})).resolves.toMatchObject({
      required:true,allowed:false,status:409,errorCode:"agentport_connector_resync_required",
    });
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.statements.some((sql) => sql.includes("SET status='sync_required'"))).toBe(true);
  });

  it("fails closed when the selected alias grant is revoked", async () => {
    const f = env([binding({status:"revoked",provider_connection_sha256:await connectionHash("connected-account-1")})]);
    await expect(authorizeUserPortConnectorTool({...base,env:f.env})).resolves.toMatchObject({
      required:true,allowed:false,status:403,errorCode:"agentport_connector_sync_required",
    });
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("fails closed after the provider owner link is revoked", async () => {
    const f = env([binding({owner_link_status:"revoked",provider_connection_sha256:await connectionHash("connected-account-1")})]);
    await expect(authorizeUserPortConnectorTool({...base,env:f.env})).resolves.toMatchObject({
      required:true,allowed:false,status:403,errorCode:"agentport_connector_sync_required",
    });
    expect(f.fetch).not.toHaveBeenCalled();
  });
});
