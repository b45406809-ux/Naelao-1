import { mintInternalToken, readBoundedResponseJson } from "@naelao/http";
import type { AgentsEnv } from "../index.js";
import { ensureAgentPortAssistantIdentity, type CommunicationScope } from "./core.js";
import { ensureManagedServiceOwnerLink } from "./managed-service-ownership.js";

const MAX_DISCOVERED_TOOLS = 100;
const MAX_SHARED_TOOLS = 50;
type UserPortAliasRow = {
  id: string;
  alias: string;
  scope: "space" | "project" | "user";
  project_id: string | null;
  user_id: string | null;
  server_id: string;
  granted_scopes_json: string;
  provider: "direct" | "composio" | "pipedream";
  provider_connection_id: string | null;
  server_name: string;
  enabled: number;
};
type DiscoveredTool = { name: string; description?: string };
type ToolAction = { toolName: string; action: string };

function validId(value: string) { return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value); }
function hex(bytes: Uint8Array) { return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
async function digest(value: string) { return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))); }
function actionId(hash: string): string { return `mcp.tool.${hash.slice(0, 48)}`; }

async function userPortAlias(env: AgentsEnv, scope: CommunicationScope, aliasId: string): Promise<UserPortAliasRow | null> {
  return env.PLATFORM_DB.prepare(`SELECT a.id,a.alias,a.scope,a.project_id,a.user_id,a.server_id,a.granted_scopes_json,
      s.connector_provider AS provider,s.provider_connection_id,s.name AS server_name,s.enabled
    FROM connector_aliases a JOIN mcp_servers s ON s.id=a.server_id AND s.tenant_id=a.tenant_id AND s.space_id=a.space_id
    WHERE a.id=? AND a.tenant_id=? AND a.space_id=? LIMIT 1`)
    .bind(aliasId, scope.tenantId, scope.spaceId)
    .first<UserPortAliasRow>();
}

async function discoverTools(env: AgentsEnv, scope: CommunicationScope, alias: UserPortAliasRow): Promise<DiscoveredTool[]> {
  if (!env.MCP_HUB) throw new Error("userport_connector_hub_unavailable");
  const response = await env.MCP_HUB.fetch(new Request(
    `http://mcp-hub/v1/spaces/${encodeURIComponent(scope.spaceId)}/mcp-servers/${encodeURIComponent(alias.server_id)}/tools`,
    { headers: {
      "x-naelao-tenant-id": scope.tenantId,
      "x-naelao-user-id": scope.userId,
      "x-naelao-agent-id": "naelao-agent",
      ...(scope.projectId ? { "x-naelao-project-id": scope.projectId } : {}),
      "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, scope.tenantId),
    } },
  ));
  const payload = await readBoundedResponseJson<{ tools?: unknown[]; error_code?: unknown }>(response, 2 * 1024 * 1024);
  if (!response.ok) throw new Error(typeof payload.error_code === "string" ? `userport_connector_${payload.error_code}` : "userport_connector_discovery_failed");
  if (!Array.isArray(payload.tools) || payload.tools.length > MAX_DISCOVERED_TOOLS) throw new Error("userport_connector_tool_list_invalid");
  const tools: DiscoveredTool[] = [];
  const names = new Set<string>();
  for (const value of payload.tools) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    if (typeof row.name !== "string" || !row.name.trim() || row.name.length > 200 || names.has(row.name)) continue;
    names.add(row.name);
    tools.push({ name: row.name, ...(typeof row.description === "string" ? { description: row.description.slice(0, 500) } : {}) });
  }
  return tools;
}

async function agentPort(env: AgentsEnv, tenantId: string, path: string, method = "GET", body?: unknown, allowNotFound = false) {
  if (!env.AGENTPORT_WORKER) throw new Error("agentport_worker_unavailable");
  const response = await env.AGENTPORT_WORKER.fetch(new Request(`https://agentport.internal/internal/agentport${path}`, {
    method,
    headers: { "content-type": "application/json", "x-agentport-tenant-id": tenantId,
      "x-agentport-actor-role": "client_system", "x-agentport-actor-id": tenantId,
      "x-agentport-internal-token": await mintInternalToken(env.PLATFORM_SECRET, tenantId) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  const result = await readBoundedResponseJson<Record<string, unknown>>(response, 128 * 1024);
  if (!response.ok && !(allowNotFound && response.status === 404))
    throw new Error(`agentport_${String(result.error_code ?? "request_failed")}`);
  return { response, result };
}

function parseActionMap(value: unknown): ToolAction[] {
  if (!Array.isArray(value)) throw new Error("userport_connector_tool_list_invalid");
  return value.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("userport_connector_tool_list_invalid");
    const toolName = (row as Record<string, unknown>).toolName;
    const action = (row as Record<string, unknown>).action;
    if (typeof toolName !== "string" || typeof action !== "string") throw new Error("userport_connector_tool_list_invalid");
    return { toolName, action };
  });
}

function recoverableSyncRequest(value: string, ownerLinkId: string, projectId: string | null,
  ownerType: string, ownerId: string, userId: string) {
  try {
    const request=JSON.parse(value) as Record<string,unknown>;
    const actions=parseActionMap(request.actions);
    return request.ownerLinkId===ownerLinkId&&validId(String(request.aliasId??""))&&validId(String(request.serverId??""))
      &&request.userId===userId&&validId(String(request.agentId??""))
      &&request.ownerType===ownerType&&validId(String(request.ownerId??""))&&request.ownerId===ownerId
      &&Number.isSafeInteger(request.revision)&&(request.revision as number)>0
      &&typeof request.connectionHash==="string"&&/^[a-f0-9]{64}$/.test(request.connectionHash)
      &&(request.projectId===null||typeof request.projectId==="string")&&(request.projectId??null)===projectId
      &&["space","project","user"].includes(String(request.aliasScope))
      &&actions.length>0&&actions.length<=MAX_SHARED_TOOLS&&new Set(actions.map(action=>action.toolName)).size===actions.length;
  } catch { return false; }
}

async function ensureAgentPortService(env: AgentsEnv, tenantId: string, input: {
  id: string; name: string; capabilities: string[];
}) {
  const existing = await agentPort(env, tenantId, `/services/${encodeURIComponent(input.id)}`, "GET", undefined, true);
  if (existing.response.ok) {
    const service = existing.result.service as Record<string, unknown> | undefined;
    const capabilities = service?.capabilities;
    if (!Array.isArray(capabilities) || JSON.stringify([...capabilities].sort()) !== JSON.stringify([...input.capabilities].sort()))
      throw new Error("userport_agentport_service_conflict");
    return;
  }
  try {
    await agentPort(env, tenantId, "/services", "POST", {
      id: input.id, name: input.name, type: "mcp", accountModels: ["agent_native"],
      capabilities: input.capabilities, events: [], connectionPurpose: "user_delegation",
      partnershipStatus: "unaffiliated", auth: { type: "none" },
      billing: { payer: "connected_provider_account" },
      provisioning: { mode: "userport_connector_reference", version: 1 },
    });
  } catch (error) {
    if (!(error instanceof Error && error.message === "agentport_service_registration_conflict")) throw error;
    const raced = await agentPort(env, tenantId, `/services/${encodeURIComponent(input.id)}`);
    const service = raced.result.service as Record<string, unknown> | undefined;
    const capabilities = service?.capabilities;
    if (!Array.isArray(capabilities) || JSON.stringify([...capabilities].sort()) !== JSON.stringify([...input.capabilities].sort()))
      throw new Error("userport_agentport_service_conflict");
  }
}

async function ensureAgentPortAccount(env: AgentsEnv, tenantId: string, input: {
  serviceId: string; externalAccountId: string; alias: UserPortAliasRow; actionMap: ToolAction[]; ownerId: string;
}) {
  const created = await agentPort(env, tenantId, "/accounts", "POST", {
    serviceId: input.serviceId, accountModel: "agent_native",
    ownerType: input.alias.scope === "user" ? "individual" : "organization", ownerId: input.ownerId,
    externalAccountId: input.externalAccountId,
    metadata: { source: "userport", aliasId: input.alias.id, serverId: input.alias.server_id,
      scope: input.alias.scope, selectedToolCount: input.actionMap.length },
  });
  const account = created.result.account as Record<string, unknown> | undefined;
  const accountId = String(account?.id ?? ""), status = String(account?.status ?? "");
  if (!validId(accountId)) throw new Error("userport_agentport_account_invalid");
  if (status === "pending") await agentPort(env, tenantId, `/accounts/${encodeURIComponent(accountId)}/activate`, "POST", {});
  else if (status === "revoked") await agentPort(env, tenantId, `/accounts/${encodeURIComponent(accountId)}/reactivate`, "POST", {});
  return accountId;
}

async function ensureAgentPortAccountForCleanup(env: AgentsEnv, tenantId: string, input: {
  serviceId:string;externalAccountId:string;alias:UserPortAliasRow;actionMap:ToolAction[];ownerType:"individual"|"organization";ownerId:string;
}) {
  const created=await agentPort(env,tenantId,"/accounts","POST",{
    serviceId:input.serviceId,accountModel:"agent_native",ownerType:input.ownerType,ownerId:input.ownerId,
    externalAccountId:input.externalAccountId,
    metadata:{source:"userport",aliasId:input.alias.id,serverId:input.alias.server_id,scope:input.alias.scope,selectedToolCount:input.actionMap.length},
  });
  const account=created.result.account as Record<string,unknown>|undefined;
  const accountId=String(account?.id??""),status=String(account?.status??"");
  if(!validId(accountId))throw new Error("userport_agentport_account_invalid");
  if(status==="pending")await agentPort(env,tenantId,`/accounts/${encodeURIComponent(accountId)}/activate`,"POST",{});
  return accountId;
}

async function ownerPrincipal(env: AgentsEnv, scope: CommunicationScope, alias: UserPortAliasRow,
  organizationPrincipalId: string) {
  if (alias.scope !== "user") return { ownerType: "organization" as const, ownerId: scope.tenantId,
    principalId: organizationPrincipalId };
  const principalId = `prn_user_${(await digest(`${scope.tenantId}:${scope.userId}`)).slice(0, 48)}`;
  const { result } = await agentPort(env, scope.tenantId, "/principals", "POST", {
    id: principalId, externalId: scope.userId, organizationName: "Naelao",
  });
  const principal = result.principal as Record<string, unknown> | undefined;
  if (principal?.id !== principalId || principal.external_id !== scope.userId)
    throw new Error("userport_agentport_owner_principal_unavailable");
  return { ownerType: "user" as const, ownerId: scope.userId, principalId };
}

async function revokeAgentPortAccount(env: AgentsEnv, tenantId: string, accountId: string) {
  if (!validId(accountId)) throw new Error("userport_agentport_account_invalid");
  const { response, result } = await agentPort(env, tenantId, `/accounts/${encodeURIComponent(accountId)}/revoke`, "POST", {}, true);
  if (response.status !== 404 && result.revoked !== true) throw new Error("userport_agentport_revoke_unconfirmed");
}

async function persistRevokedUserPortBinding(env: AgentsEnv, input: {
  scope:CommunicationScope;alias:UserPortAliasRow;ownerLinkId:string;serviceId:string;agentId:string;hostResourceId:string;
  connectionHash:string;actions:ToolAction[];revision:number;operationId:string;
}) {
  const at=new Date().toISOString();
  const tombstoneAccountId=`upc_revoked_${(await digest(input.operationId)).slice(0,32)}`;
  await env.PLATFORM_DB.prepare(`INSERT INTO agentport_userport_connector_bindings(
    tenant_id,space_id,alias_id,server_id,owner_link_id,provider,provider_connection_sha256,service_id,account_id,agent_id,
    host_resource_id,tool_actions_json,revision,status,previous_account_id,created_by,created_at,updated_at,revoked_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'revoked',NULL,?,?,?,?)
    ON CONFLICT(tenant_id,space_id,alias_id) DO UPDATE SET server_id=excluded.server_id,owner_link_id=excluded.owner_link_id,
      provider=excluded.provider,provider_connection_sha256=excluded.provider_connection_sha256,service_id=excluded.service_id,
      account_id=excluded.account_id,agent_id=excluded.agent_id,host_resource_id=excluded.host_resource_id,
      tool_actions_json=excluded.tool_actions_json,revision=excluded.revision,status='revoked',previous_account_id=NULL,
      created_by=excluded.created_by,updated_at=excluded.updated_at,revoked_at=excluded.revoked_at`)
    .bind(input.scope.tenantId,input.scope.spaceId,input.alias.id,input.alias.server_id,input.ownerLinkId,input.alias.provider,
      input.connectionHash,input.serviceId,tombstoneAccountId,input.agentId,input.hostResourceId,JSON.stringify(input.actions),
      input.revision,input.scope.userId,at,at,at).run();
}

async function beginConnectorSyncOperation(env: AgentsEnv, scope: CommunicationScope, alias: UserPortAliasRow,
  serviceId: string, revision: number, connectionHash: string, actions: ToolAction[], ownerLinkId:string,
  agentId:string,ownerType:"user"|"organization",ownerId:string): Promise<{
    operationId: string; complete: boolean; pending: boolean; accountId?: string;
  }> {
  const request = { aliasId: alias.id, serverId: alias.server_id, revision, connectionHash, actions,
    userId: scope.userId, projectId: scope.projectId ?? null, ownerLinkId, agentId, ownerType, ownerId, aliasScope:alias.scope };
  const requestHash = await digest(JSON.stringify(request));
  const operationId = `upc_sync_${requestHash.slice(0, 40)}`;
  const at = new Date().toISOString();
  await env.PLATFORM_DB.prepare(`INSERT OR IGNORE INTO managed_service_operations(
      operation_id,tenant_id,space_id,project_id,provider,service_id,operation_name,idempotency_key,request_sha256,
      status,request_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,'agentport_connector_sync',?,?,'pending',?,?,?)`)
    .bind(operationId, scope.tenantId, scope.spaceId, alias.project_id, alias.provider, serviceId,
      operationId, requestHash, JSON.stringify(request), at, at).run();
  const existing = await env.PLATFORM_DB.prepare(`SELECT request_sha256,status,lease_until,provider_operation_ref FROM managed_service_operations
    WHERE operation_id=? AND tenant_id=?`).bind(operationId, scope.tenantId)
    .first<{request_sha256:string;status:string;lease_until:string|null;provider_operation_ref:string|null}>();
  if (!existing || existing.request_sha256 !== requestHash) throw new Error("userport_agentport_operation_conflict");
  if (existing.status === "complete") return { operationId, complete: true, pending: false, accountId: existing.provider_operation_ref ?? "" };
  const leaseUntil = new Date(Date.now() + 120_000).toISOString();
  const claimed = await env.PLATFORM_DB.prepare(`UPDATE managed_service_operations SET status='running',lease_until=?,
      error_code=NULL,next_reconcile_at=NULL,updated_at=? WHERE operation_id=? AND tenant_id=?
      AND (status IN ('pending','held','uncertain') OR (status='running' AND (lease_until IS NULL OR lease_until<=?)))`)
    .bind(leaseUntil, at, operationId, scope.tenantId, at).run();
  return { operationId, complete: false, pending: claimed.meta.changes !== 1 };
}

async function finishConnectorSyncOperation(env: AgentsEnv, tenantId: string, operationId: string,
  status: "complete" | "uncertain", error?: unknown, accountId?: string) {
  const message = error instanceof Error ? error.message : "userport_agentport_sync_uncertain";
  const errorCode = status === "uncertain" && /^[a-z][a-z0-9_:-]{1,120}$/.test(message)
    ? message : status === "uncertain" ? "userport_agentport_sync_uncertain" : null;
  const at = new Date();
  const retryAt = status === "uncertain" ? new Date(at.getTime() + 60_000).toISOString() : null;
  await env.PLATFORM_DB.prepare(`UPDATE managed_service_operations SET status=?,error_code=?,provider_operation_ref=COALESCE(?,provider_operation_ref),
    lease_until=NULL,next_reconcile_at=?,last_reconciled_at=CASE WHEN ?='uncertain' THEN ? ELSE last_reconciled_at END,updated_at=?
    WHERE operation_id=? AND tenant_id=? AND status IN ('pending','running','uncertain')`)
    .bind(status, errorCode, accountId ?? null, retryAt, status, at.toISOString(), at.toISOString(), operationId, tenantId).run();
}

export async function discoverUserPortAgentPortConnector(env: AgentsEnv, scope: CommunicationScope, aliasId: string) {
  if (!validId(aliasId)) throw new Error("userport_connector_alias_invalid");
  const alias = await userPortAlias(env, scope, aliasId);
  if (!alias || alias.enabled !== 1) throw new Error("userport_connector_alias_not_found");
  if (alias.scope === "project" && alias.project_id !== scope.projectId) throw new Error("userport_connector_alias_not_found");
  if (alias.scope === "user" && alias.user_id !== scope.userId) throw new Error("userport_connector_alias_not_found");
  const tools = await discoverTools(env, scope, alias);
  return { aliasId: alias.id, alias: alias.alias, provider: alias.provider, tools };
}

async function syncUserPortAgentPortConnectorInternal(env: AgentsEnv, scope: CommunicationScope, aliasId: string,
  selectedToolNames: unknown, recovery?: { revision: number; operationId: string; ownerLinkId:string;
    agentId:string;ownerType:"user"|"organization";ownerId:string }) {
  if (!validId(aliasId)) throw new Error("userport_connector_alias_invalid");
  if (!Array.isArray(selectedToolNames) || selectedToolNames.length < 1 || selectedToolNames.length > MAX_SHARED_TOOLS
    || selectedToolNames.some((name) => typeof name !== "string" || !name.trim() || name.length > 200)
    || new Set(selectedToolNames).size !== selectedToolNames.length) throw new Error("userport_connector_selection_invalid");
  const alias = await userPortAlias(env, scope, aliasId);
  if (!alias || alias.enabled !== 1) throw new Error("userport_connector_alias_not_found");
  if (alias.scope === "project" && alias.project_id !== scope.projectId) throw new Error("userport_connector_alias_not_found");
  if (alias.scope === "user" && alias.user_id !== scope.userId) throw new Error("userport_connector_alias_not_found");
  const discovered = await discoverTools(env, scope, alias);
  const names = new Set(discovered.map((tool) => tool.name));
  if (selectedToolNames.some((name) => !names.has(name))) throw new Error("userport_connector_selection_stale");

  const hashOfConnection = await digest(alias.provider_connection_id ?? `direct:${alias.server_id}`);
  const actionMap: ToolAction[] = [];
  for (const toolName of [...selectedToolNames].sort((a, b) => String(a).localeCompare(String(b)))) {
    actionMap.push({ toolName: String(toolName), action: actionId(await digest(String(toolName))) });
  }
  const previous = await env.PLATFORM_DB.prepare(`SELECT service_id,account_id,agent_id,host_resource_id,tool_actions_json,
      provider_connection_sha256,revision,status,previous_account_id
    FROM agentport_userport_connector_bindings WHERE tenant_id=? AND space_id=? AND alias_id=?`)
    .bind(scope.tenantId, scope.spaceId, aliasId)
    .first<{service_id:string;account_id:string;agent_id:string;host_resource_id:string;tool_actions_json:string;provider_connection_sha256:string;revision:number;status:string;previous_account_id:string|null}>();
  const pendingRevoke = await env.PLATFORM_DB.prepare(`SELECT operation_id FROM managed_service_operations
    WHERE tenant_id=? AND space_id=? AND operation_name='agentport_connector_revoke'
      AND status IN ('pending','running','uncertain','held') AND json_extract(request_json,'$.aliasId')=? LIMIT 1`)
    .bind(scope.tenantId, scope.spaceId, aliasId).first<{operation_id:string}>();
  if (pendingRevoke) throw new Error("userport_agentport_revoke_pending");
  if (!recovery && previous?.status === "active" && previous.provider_connection_sha256 === hashOfConnection
    && previous.tool_actions_json === JSON.stringify(actionMap)) {
    if (previous.previous_account_id) {
      await revokeAgentPortAccount(env, scope.tenantId, previous.previous_account_id);
      await env.PLATFORM_DB.prepare(`UPDATE agentport_userport_connector_bindings SET previous_account_id=NULL,updated_at=?
        WHERE tenant_id=? AND space_id=? AND alias_id=? AND previous_account_id=?`)
        .bind(new Date().toISOString(), scope.tenantId, scope.spaceId, aliasId, previous.previous_account_id).run();
    }
    return { aliasId, accountId: previous.account_id, serviceId: previous.service_id, agentId: previous.agent_id,
      operations: actionMap.map((entry) => entry.toolName), revision: previous.revision, idempotent: true };
  }

  const resource = alias.scope === "project" && alias.project_id ? `project:${alias.project_id}` : `space-assistant:${scope.spaceId}`;
  const agentScope: CommunicationScope = alias.scope === "project" && alias.project_id
    ? { ...scope, projectId: alias.project_id }
    : { tenantId: scope.tenantId, spaceId: scope.spaceId, userId: scope.userId, role: scope.role };
  let agentId:string;
  let providerOwner:{ownerType:"user"|"organization";ownerId:string;principalId:string};
  let ownerLinkId:string;
  if (recovery) {
    agentId=recovery.agentId;
    providerOwner={ownerType:recovery.ownerType,ownerId:recovery.ownerId,principalId:"recovered"};
    ownerLinkId=recovery.ownerLinkId;
  } else {
    agentId = await ensureAgentPortAssistantIdentity(env, agentScope);
    const identity = await agentPort(env, scope.tenantId, `/agents/${encodeURIComponent(agentId)}/identity`);
    const principal = (identity.result.identity as Record<string, unknown> | undefined)?.principal as Record<string, unknown> | undefined;
    if (principal?.type !== "organization" || typeof principal.id !== "string" || !validId(principal.id))
      throw new Error("userport_agentport_principal_unavailable");
    providerOwner = await ownerPrincipal(env, scope, alias, String(principal.id));
    ownerLinkId = await ensureManagedServiceOwnerLink(env, scope, { ...providerOwner, consentSource: "userport.connector_sync" });
  }
  const revision = recovery?.revision ?? ((previous?.revision ?? 0) + 1);
  if (recovery && previous && (previous.revision > revision || previous.status === "revoked" || previous.status === "sync_required")) {
    throw new Error("userport_connector_sync_scope_changed");
  }
  const actionHash = await digest(JSON.stringify(actionMap));
  const serviceId = `upc_${(await digest(`${scope.tenantId}:${scope.spaceId}:${aliasId}:${actionHash}`)).slice(0, 48)}`;
  const externalAccountId = `userport:${(await digest(`${scope.tenantId}:${scope.spaceId}:${aliasId}`)).slice(0, 32)}:r${revision}`;
  const ownerId = providerOwner.ownerId;
  const capabilities = actionMap.map((entry) => entry.action);
  if (recovery) {
    const expectedRequest={aliasId:alias.id,serverId:alias.server_id,revision,connectionHash:hashOfConnection,actions:actionMap,
      userId:scope.userId,projectId:scope.projectId??null,ownerLinkId,agentId,ownerType:providerOwner.ownerType,ownerId:providerOwner.ownerId,aliasScope:alias.scope};
    const expectedOperationId=`upc_sync_${(await digest(JSON.stringify(expectedRequest))).slice(0,40)}`;
    if (expectedOperationId!==recovery.operationId) throw new Error("userport_connector_sync_operation_changed");
  }
  const operation = await beginConnectorSyncOperation(env, scope, alias, serviceId, revision, hashOfConnection, actionMap,
    ownerLinkId,agentId,providerOwner.ownerType,providerOwner.ownerId);
  if (recovery && operation.operationId !== recovery.operationId) {
    await env.PLATFORM_DB.prepare(`UPDATE managed_service_operations SET status='held',lease_until=NULL,next_reconcile_at=NULL,
      error_code='userport_connector_sync_operation_changed',updated_at=? WHERE operation_id=? AND tenant_id=? AND status='running'`)
      .bind(new Date().toISOString(), operation.operationId, scope.tenantId).run();
    throw new Error("userport_connector_sync_operation_changed");
  }
  if (operation.complete) return { aliasId, accountId: operation.accountId, serviceId, agentId,
    operations: actionMap.map((entry) => entry.toolName), revision, idempotent: true };
  if (operation.pending) return { aliasId, pending: true, operations: actionMap.map((entry) => entry.toolName), revision };

  if (previous?.status === "active") {
    const locked = await env.PLATFORM_DB.prepare(`UPDATE agentport_userport_connector_bindings SET status='pending',updated_at=?
      WHERE tenant_id=? AND space_id=? AND alias_id=? AND account_id=? AND revision=? AND status='active'`)
      .bind(new Date().toISOString(), scope.tenantId, scope.spaceId, aliasId, previous.account_id, previous.revision).run();
    if (locked.meta.changes !== 1) {
      await env.PLATFORM_DB.prepare(`UPDATE managed_service_operations SET status='held',lease_until=NULL,next_reconcile_at=NULL,
        error_code='userport_connector_sync_scope_changed',updated_at=? WHERE operation_id=? AND tenant_id=? AND status='running'`)
        .bind(new Date().toISOString(), operation.operationId, scope.tenantId).run();
      throw new Error("userport_connector_sync_conflict");
    }
  }

  try {
    const link=await env.PLATFORM_DB.prepare(`SELECT status FROM managed_service_owner_links WHERE id=? AND tenant_id=?
      AND owner_type=? AND owner_id=?`).bind(ownerLinkId,scope.tenantId,providerOwner.ownerType,providerOwner.ownerId)
      .first<{status:string}>();
    if (link?.status!=="active") {
      await persistRevokedUserPortBinding(env,{scope,alias,ownerLinkId,serviceId,agentId,hostResourceId:resource,
        connectionHash:hashOfConnection,actions:actionMap,revision,operationId:operation.operationId});
      await env.PLATFORM_DB.prepare(`UPDATE managed_service_operations SET status='cancelled',error_code='userport_owner_link_revoked',
        lease_until=NULL,next_reconcile_at=NULL,updated_at=? WHERE operation_id=? AND tenant_id=? AND status='running'`)
        .bind(new Date().toISOString(),operation.operationId,scope.tenantId).run();
      throw new Error("userport_owner_link_revoked");
    }
    await ensureAgentPortService(env, scope.tenantId, { id: serviceId, name: `${alias.server_name} via UserPort`, capabilities });
    const accountId = await ensureAgentPortAccount(env, scope.tenantId, { serviceId, externalAccountId, alias, actionMap, ownerId });
    const grantInput = { agentId, grantedBy: scope.userId, permissions: capabilities };
    let grant;
    try { grant = await agentPort(env, scope.tenantId, `/accounts/${encodeURIComponent(accountId)}/grants`, "POST", grantInput); }
    catch (error) {
      if (!(error instanceof Error && error.message === "agentport_grant_conflict")) throw error;
      grant = await agentPort(env, scope.tenantId, `/accounts/${encodeURIComponent(accountId)}/grants`, "POST", grantInput);
    }
    if (!grant.result.grant || typeof grant.result.grant !== "object") throw new Error("userport_agentport_grant_unavailable");

    const at = new Date().toISOString();
    const priorAccountToRetire=previous?.revision===revision?previous.previous_account_id:previous?.account_id??null;
    const stillConsented=await env.PLATFORM_DB.prepare(`SELECT status FROM managed_service_owner_links WHERE id=? AND tenant_id=?
      AND owner_type=? AND owner_id=?`).bind(ownerLinkId,scope.tenantId,providerOwner.ownerType,providerOwner.ownerId)
      .first<{status:string}>();
    if (stillConsented?.status!=="active") {
      await revokeAgentPortAccount(env,scope.tenantId,accountId);
      if (priorAccountToRetire&&priorAccountToRetire!==accountId) await revokeAgentPortAccount(env,scope.tenantId,priorAccountToRetire);
      await persistRevokedUserPortBinding(env,{scope,alias,ownerLinkId,serviceId,agentId,hostResourceId:resource,
        connectionHash:hashOfConnection,actions:actionMap,revision,operationId:operation.operationId});
      await env.PLATFORM_DB.prepare(`UPDATE managed_service_operations SET status='cancelled',error_code='userport_owner_link_revoked',
        lease_until=NULL,next_reconcile_at=NULL,updated_at=? WHERE operation_id=? AND tenant_id=? AND status='running'`)
        .bind(at,operation.operationId,scope.tenantId).run();
      throw new Error("userport_owner_link_revoked");
    }
    await env.PLATFORM_DB.prepare(`INSERT INTO agentport_userport_connector_bindings(
      tenant_id,space_id,alias_id,server_id,owner_link_id,provider,provider_connection_sha256,service_id,account_id,agent_id,
      host_resource_id,tool_actions_json,revision,status,previous_account_id,created_by,created_at,updated_at,revoked_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'active',?,?,?, ?,NULL)
    ON CONFLICT(tenant_id,space_id,alias_id) DO UPDATE SET server_id=excluded.server_id,provider=excluded.provider,
      owner_link_id=excluded.owner_link_id,
      provider_connection_sha256=excluded.provider_connection_sha256,service_id=excluded.service_id,account_id=excluded.account_id,
      agent_id=excluded.agent_id,host_resource_id=excluded.host_resource_id,tool_actions_json=excluded.tool_actions_json,
      revision=excluded.revision,status='active',previous_account_id=excluded.previous_account_id,created_by=excluded.created_by,
      updated_at=excluded.updated_at,revoked_at=NULL`)
      .bind(scope.tenantId, scope.spaceId, alias.id, alias.server_id, ownerLinkId, alias.provider, hashOfConnection, serviceId, accountId, agentId,
        resource, JSON.stringify(actionMap), revision,
        priorAccountToRetire && priorAccountToRetire !== accountId ? priorAccountToRetire : null, scope.userId, at, at).run();
    if (priorAccountToRetire && priorAccountToRetire !== accountId) {
      await revokeAgentPortAccount(env, scope.tenantId, priorAccountToRetire);
      await env.PLATFORM_DB.prepare(`UPDATE agentport_userport_connector_bindings SET previous_account_id=NULL,updated_at=?
        WHERE tenant_id=? AND space_id=? AND alias_id=? AND previous_account_id=?`)
        .bind(new Date().toISOString(), scope.tenantId, scope.spaceId, aliasId, priorAccountToRetire).run();
    }
    await finishConnectorSyncOperation(env, scope.tenantId, operation.operationId, "complete", undefined, accountId);
    return { aliasId, accountId, serviceId, agentId, operations: actionMap.map((entry) => entry.toolName), revision, idempotent: false };
  } catch (error) {
    await finishConnectorSyncOperation(env, scope.tenantId, operation.operationId, "uncertain", error).catch(() => undefined);
    throw error;
  }
}

export async function syncUserPortAgentPortConnector(env: AgentsEnv, scope: CommunicationScope, aliasId: string, selectedToolNames: unknown) {
  return syncUserPortAgentPortConnectorInternal(env, scope, aliasId, selectedToolNames);
}

/** Retry idempotent AgentPort service/account/grant creation only while the connector binding and
 * owner-selected action set still match the durable request. A changed or removed alias is held. */
export async function sweepUserPortAgentPortSyncs(env: AgentsEnv, now = new Date(), limit = 10) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25) throw new Error("userport_agentport_reconciliation_limit_invalid");
  const due = await env.PLATFORM_DB.prepare(`SELECT operation_id,tenant_id,space_id,project_id,provider,service_id,request_json,error_code FROM managed_service_operations
    WHERE operation_name='agentport_connector_sync' AND status='uncertain' AND next_reconcile_at IS NOT NULL AND next_reconcile_at<=?
    ORDER BY next_reconcile_at,created_at LIMIT ?`).bind(now.toISOString(), limit).all<{
      operation_id:string;tenant_id:string;space_id:string;project_id:string|null;provider:string;service_id:string;request_json:string;error_code:string|null;
    }>();
  let reconciled=0,deferred=0,failed=0;
  for (const row of due.results ?? []) {
    let request: {aliasId?:unknown;serverId?:unknown;revision?:unknown;connectionHash?:unknown;actions?:unknown;userId?:unknown;
      projectId?:unknown;ownerLinkId?:unknown;agentId?:unknown;ownerType?:unknown;ownerId?:unknown;aliasScope?:unknown} = {};
    try { request=JSON.parse(row.request_json) as typeof request; } catch { /* held below */ }
    const aliasId=typeof request.aliasId==="string"?request.aliasId:"";
    const userId=typeof request.userId==="string"?request.userId:"";
    const projectId=typeof request.projectId==="string"?request.projectId:undefined;
    const ownerLinkId=typeof request.ownerLinkId==="string"?request.ownerLinkId:"";
    const agentId=typeof request.agentId==="string"?request.agentId:"";
    const ownerType=request.ownerType==="user"||request.ownerType==="organization"?request.ownerType:null;
    const ownerId=typeof request.ownerId==="string"?request.ownerId:"";
    let actions:ToolAction[]=[];
    try { actions=parseActionMap(request.actions); } catch { /* held below */ }
    const selected=actions.map(action=>action.toolName);
    const validRequest=validId(row.tenant_id)&&validId(row.space_id)&&validId(aliasId)&&validId(userId)
      &&typeof request.serverId==="string"&&validId(request.serverId)&&Number.isSafeInteger(request.revision)
      &&(request.revision as number)>0&&typeof request.connectionHash==="string"&&/^[a-f0-9]{64}$/.test(request.connectionHash)
      &&actions.length>0&&actions.length<=MAX_SHARED_TOOLS&&new Set(selected).size===selected.length
      &&validId(ownerLinkId)&&validId(agentId)&&ownerType!==null&&validId(ownerId)
      &&["space","project","user"].includes(String(request.aliasScope))
      &&(row.project_id??null)===(projectId??null);
    if (!validRequest) {
      await env.PLATFORM_DB.prepare(`UPDATE managed_service_operations SET status='held',next_reconcile_at=NULL,lease_until=NULL,
        error_code='userport_connector_sync_request_invalid',last_reconciled_at=?,updated_at=?
        WHERE operation_id=? AND tenant_id=? AND status='uncertain'`)
        .bind(now.toISOString(),now.toISOString(),row.operation_id,row.tenant_id).run();
      deferred++; continue;
    }
    const scope:CommunicationScope={tenantId:row.tenant_id,spaceId:row.space_id,userId,role:"owner",...(projectId?{projectId}:{})};
    const ownerLink=await env.PLATFORM_DB.prepare(`SELECT status FROM managed_service_owner_links WHERE id=? AND tenant_id=? AND owner_type=? AND owner_id=?`)
      .bind(ownerLinkId,row.tenant_id,ownerType,ownerId).first<{status:string}>();
    if (ownerLink?.status!=="active" || row.error_code==="userport_connector_cleanup_requested") {
      try {
        const actionHash=await digest(JSON.stringify(actions));
        const serviceId=`upc_${(await digest(`${row.tenant_id}:${row.space_id}:${aliasId}:${actionHash}`)).slice(0,48)}`;
        if (row.service_id!==serviceId||!["direct","composio","pipedream"].includes(row.provider)) throw new Error("userport_connector_sync_scope_changed");
        const alias=await userPortAlias(env,scope,aliasId)??{
          id:aliasId,alias:aliasId,scope:request.aliasScope as UserPortAliasRow["scope"],project_id:projectId??null,
          user_id:ownerType==="user"?userId:null,server_id:String(request.serverId),granted_scopes_json:"[]",
          provider:row.provider as UserPortAliasRow["provider"],provider_connection_id:null,server_name:"UserPort",enabled:0,
        };
        const capabilities=actions.map(action=>action.action);
        await ensureAgentPortService(env,row.tenant_id,{id:serviceId,name:`${alias.server_name} via UserPort`,capabilities});
        const externalAccountId=`userport:${(await digest(`${row.tenant_id}:${row.space_id}:${aliasId}`)).slice(0,32)}:r${request.revision}`;
        const accountId=await ensureAgentPortAccountForCleanup(env,row.tenant_id,{serviceId,externalAccountId,alias,actionMap:actions,
          ownerType:ownerType==="user"?"individual":"organization",ownerId});
        const current=await env.PLATFORM_DB.prepare(`SELECT account_id,previous_account_id FROM agentport_userport_connector_bindings
          WHERE tenant_id=? AND space_id=? AND alias_id=?`).bind(row.tenant_id,row.space_id,aliasId)
          .first<{account_id:string;previous_account_id:string|null}>();
        for(const account of new Set([accountId,current?.account_id,current?.previous_account_id].filter((value):value is string=>!!value)))
          await revokeAgentPortAccount(env,row.tenant_id,account);
        const hostResourceId=alias.scope==="project"&&alias.project_id?`project:${alias.project_id}`:`space-assistant:${row.space_id}`;
        await persistRevokedUserPortBinding(env,{scope,alias,ownerLinkId,serviceId,agentId,hostResourceId,
          connectionHash:String(request.connectionHash),actions,revision:request.revision as number,operationId:row.operation_id});
        const at=new Date().toISOString();
        const completedError=ownerLink?.status==="active"?"userport_connector_unlinked":"userport_owner_link_revoked";
        await env.PLATFORM_DB.prepare(`UPDATE managed_service_operations SET status='cancelled',error_code=?,
          lease_until=NULL,next_reconcile_at=NULL,provider_operation_ref=?,last_reconciled_at=?,updated_at=?
          WHERE operation_id=? AND tenant_id=? AND status='uncertain'`)
          .bind(completedError,accountId,at,at,row.operation_id,row.tenant_id).run();
        reconciled++;
      } catch(error) {
        await finishConnectorSyncOperation(env,row.tenant_id,row.operation_id,"uncertain",error).catch(()=>undefined);
        failed++;
      }
      continue;
    }
    const alias=await userPortAlias(env,scope,aliasId);
    if (!alias||alias.server_id!==request.serverId||alias.enabled!==1||(alias.project_id??undefined)!==projectId
      ||(alias.scope==="user"&&alias.user_id!==userId)) {
      await env.PLATFORM_DB.prepare(`UPDATE managed_service_operations SET status='held',next_reconcile_at=NULL,lease_until=NULL,
        error_code='userport_connector_sync_scope_changed',last_reconciled_at=?,updated_at=?
        WHERE operation_id=? AND tenant_id=? AND status='uncertain'`)
        .bind(now.toISOString(),now.toISOString(),row.operation_id,row.tenant_id).run();
      deferred++; continue;
    }
    const hashOfConnection=await digest(alias.provider_connection_id??`direct:${alias.server_id}`);
    const currentBinding=await env.PLATFORM_DB.prepare(`SELECT revision,status,provider_connection_sha256,tool_actions_json
      FROM agentport_userport_connector_bindings WHERE tenant_id=? AND space_id=? AND alias_id=?`)
      .bind(row.tenant_id,row.space_id,aliasId).first<{revision:number;status:string;provider_connection_sha256:string;tool_actions_json:string}>();
    if (hashOfConnection!==request.connectionHash || (!currentBinding && request.revision!==1) || (currentBinding &&
      (currentBinding.revision>(request.revision as number)
        || ((currentBinding.revision===(request.revision as number))
          && (currentBinding.status!=="active"||currentBinding.provider_connection_sha256!==hashOfConnection
            ||currentBinding.tool_actions_json!==JSON.stringify(actions)))
        || (currentBinding.revision<(request.revision as number)&&!["active","pending"].includes(currentBinding.status))))) {
      await env.PLATFORM_DB.prepare(`UPDATE managed_service_operations SET status='held',next_reconcile_at=NULL,lease_until=NULL,
        error_code='userport_connector_sync_scope_changed',last_reconciled_at=?,updated_at=?
        WHERE operation_id=? AND tenant_id=? AND status='uncertain'`)
        .bind(now.toISOString(),now.toISOString(),row.operation_id,row.tenant_id).run();
      deferred++; continue;
    }
    try {
      const result=await syncUserPortAgentPortConnectorInternal(env,scope,aliasId,selected,
        {revision:request.revision as number,operationId:row.operation_id,ownerLinkId,agentId,ownerType,ownerId});
      if ("pending" in result && result.pending) { deferred++; continue; }
      await env.PLATFORM_DB.prepare(`UPDATE managed_service_operations SET status='complete',error_code=NULL,lease_until=NULL,
        next_reconcile_at=NULL,provider_operation_ref=COALESCE(?,provider_operation_ref),last_reconciled_at=?,updated_at=?
        WHERE operation_id=? AND tenant_id=? AND status='running'`)
        .bind("accountId" in result?result.accountId??null:null,now.toISOString(),new Date().toISOString(),row.operation_id,row.tenant_id).run();
      reconciled++;
    } catch (error) {
      const code=error instanceof Error?error.message:"userport_agentport_sync_uncertain";
      if (["userport_connector_sync_scope_changed","userport_connector_sync_operation_changed","userport_connector_selection_stale",
        "userport_agentport_revoke_pending","userport_owner_link_revoked"].includes(code)) {
        await env.PLATFORM_DB.prepare(`UPDATE managed_service_operations SET status='held',next_reconcile_at=NULL,lease_until=NULL,
          error_code=?,last_reconciled_at=?,updated_at=? WHERE operation_id=? AND tenant_id=? AND status='uncertain'`)
          .bind(code,now.toISOString(),new Date().toISOString(),row.operation_id,row.tenant_id).run();
        deferred++;
      } else {
        await finishConnectorSyncOperation(env,row.tenant_id,row.operation_id,"uncertain",error).catch(()=>undefined);
        failed++;
      }
    }
  }
  return {checked:due.results?.length??0,reconciled,deferred,failed};
}

export async function revokeUserPortAgentPortConnector(env: AgentsEnv, scope: CommunicationScope, aliasId: string) {
  if (!validId(aliasId)) throw new Error("userport_connector_alias_invalid");
  const pendingSync=await env.PLATFORM_DB.prepare(`SELECT operation_id,status FROM managed_service_operations
    WHERE tenant_id=? AND space_id=? AND operation_name='agentport_connector_sync'
      AND status IN ('pending','running','uncertain','held') AND json_extract(request_json,'$.aliasId')=? LIMIT 1`)
    .bind(scope.tenantId,scope.spaceId,aliasId).first<{operation_id:string;status:string}>();
  if (pendingSync?.status==="held") {
    const at=new Date().toISOString();
    await env.PLATFORM_DB.prepare(`UPDATE agentport_userport_connector_bindings SET status='sync_required',updated_at=?
      WHERE tenant_id=? AND space_id=? AND alias_id=? AND status='active'`).bind(at,scope.tenantId,scope.spaceId,aliasId).run();
    await env.PLATFORM_DB.prepare(`UPDATE managed_service_operations SET status='uncertain',error_code='userport_connector_cleanup_requested',
      lease_until=NULL,next_reconcile_at=?,updated_at=? WHERE operation_id=? AND tenant_id=? AND status='held'`)
      .bind(at,at,pendingSync.operation_id,scope.tenantId).run();
    throw new Error("userport_agentport_sync_cleanup_pending");
  }
  if (pendingSync) throw new Error("userport_agentport_sync_pending");
  const binding = await env.PLATFORM_DB.prepare(`SELECT account_id,previous_account_id,service_id,provider,status FROM agentport_userport_connector_bindings
    WHERE tenant_id=? AND space_id=? AND alias_id=?`).bind(scope.tenantId, scope.spaceId, aliasId)
    .first<{account_id:string;previous_account_id:string|null;service_id:string;provider:string;status:string}>();
  if (!binding) return { revoked: false, idempotent: true };
  if (binding.status === "pending") throw new Error("userport_agentport_sync_pending");
  const at = new Date().toISOString();
  const accountIds = [...new Set([binding.account_id, binding.previous_account_id].filter((id): id is string => !!id))].sort();
  const requestHash = await digest(JSON.stringify({ tenantId:scope.tenantId, spaceId:scope.spaceId, aliasId, accountIds }));
  const operationId = `upc_revoke_${requestHash.slice(0, 40)}`;
  await env.PLATFORM_DB.prepare(`INSERT OR IGNORE INTO managed_service_operations(
      operation_id,tenant_id,space_id,provider,service_id,operation_name,idempotency_key,request_sha256,
      status,request_json,created_at,updated_at)
    VALUES(?,?,?,?,?,'agentport_connector_revoke',?,?,'pending',?,?,?)`)
    .bind(operationId, scope.tenantId, scope.spaceId, binding.provider, binding.service_id, operationId, requestHash,
      JSON.stringify({ aliasId, accountIds }), at, at).run();
  const operation = await env.PLATFORM_DB.prepare(`SELECT request_sha256,status,lease_until FROM managed_service_operations
    WHERE operation_id=? AND tenant_id=?`).bind(operationId, scope.tenantId)
    .first<{request_sha256:string;status:string;lease_until:string|null}>();
  if (!operation || operation.request_sha256 !== requestHash) throw new Error("userport_agentport_revoke_operation_conflict");

  if (operation.status === "complete") {
    await env.PLATFORM_DB.prepare(`UPDATE agentport_userport_connector_bindings SET status='revoked',
      revoked_at=COALESCE(revoked_at,?),updated_at=?
      WHERE tenant_id=? AND space_id=? AND alias_id=? AND account_id=?`)
      .bind(at, at, scope.tenantId, scope.spaceId, aliasId, binding.account_id).run();
    return { revoked: true, accountId: binding.account_id, idempotent: true };
  }

  await env.PLATFORM_DB.prepare(`UPDATE agentport_userport_connector_bindings SET status='sync_required',updated_at=?
    WHERE tenant_id=? AND space_id=? AND alias_id=? AND account_id=?`)
    .bind(at, scope.tenantId, scope.spaceId, aliasId, binding.account_id).run();
  const claimed = await env.PLATFORM_DB.prepare(`UPDATE managed_service_operations SET status='running',lease_until=?,
      error_code=NULL,updated_at=? WHERE operation_id=? AND tenant_id=?
      AND (status IN ('pending','held','uncertain') OR (status='running' AND (lease_until IS NULL OR lease_until<=?)))`)
    .bind(new Date(Date.now() + 120_000).toISOString(), at, operationId, scope.tenantId, at).run();
  if (!claimed.meta.changes) return { revoked: false, pending: true, accountId: binding.account_id };

  try {
    for (const accountId of accountIds) await revokeAgentPortAccount(env, scope.tenantId, accountId);
    const completedAt = new Date().toISOString();
    await env.PLATFORM_DB.prepare(`UPDATE agentport_userport_connector_bindings SET status='revoked',revoked_at=COALESCE(revoked_at,?),
      updated_at=? WHERE tenant_id=? AND space_id=? AND alias_id=? AND account_id=?`)
      .bind(completedAt, completedAt, scope.tenantId, scope.spaceId, aliasId, binding.account_id).run();
    await env.PLATFORM_DB.prepare(`UPDATE managed_service_operations SET status='complete',error_code=NULL,lease_until=NULL,next_reconcile_at=NULL,updated_at=?
      WHERE operation_id=? AND tenant_id=?`).bind(completedAt, operationId, scope.tenantId).run();
    return { revoked: true, accountId: binding.account_id, idempotent: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : "userport_agentport_revoke_uncertain";
    const errorCode = /^[a-z][a-z0-9_:-]{1,120}$/.test(message) ? message : "userport_agentport_revoke_uncertain";
    await env.PLATFORM_DB.prepare(`UPDATE managed_service_operations SET status='uncertain',error_code=?,lease_until=NULL,
      next_reconcile_at=?,updated_at=?
      WHERE operation_id=? AND tenant_id=?`)
      .bind(errorCode, new Date(Date.now() + 60_000).toISOString(), new Date().toISOString(), operationId, scope.tenantId).run().catch(() => undefined);
    throw error;
  }
}

/** Scheduled retry for uncertain UserPort revocations. The exact persisted account set must
 * still match the local binding; scope drift is held for owner/operator review without egress. */
export async function sweepUserPortAgentPortRevocations(env: AgentsEnv, now = new Date(), limit = 10) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25) throw new Error("userport_agentport_reconciliation_limit_invalid");
  const due = await env.PLATFORM_DB.prepare(`SELECT operation_id,tenant_id,space_id,request_json FROM managed_service_operations
    WHERE operation_name='agentport_connector_revoke' AND status='uncertain' AND next_reconcile_at IS NOT NULL AND next_reconcile_at<=?
    ORDER BY next_reconcile_at,created_at LIMIT ?`).bind(now.toISOString(), limit).all<{
      operation_id: string; tenant_id: string; space_id: string; request_json: string;
    }>();
  let reconciled = 0, deferred = 0, failed = 0;
  for (const row of due.results ?? []) {
    let request: { aliasId?: unknown; accountIds?: unknown } = {};
    try { request = JSON.parse(row.request_json) as typeof request; } catch { /* held below */ }
    const aliasId = typeof request.aliasId === "string" ? request.aliasId : "";
    const accountIds = Array.isArray(request.accountIds) ? request.accountIds : [];
    const validAccountIds = accountIds.length > 0 && accountIds.length <= 2
      && accountIds.every((id): id is string => typeof id === "string" && validId(id))
      && JSON.stringify([...new Set(accountIds)].sort()) === JSON.stringify(accountIds);
    if (!validId(row.tenant_id) || !validId(row.space_id) || !validId(aliasId) || !validAccountIds) {
      await env.PLATFORM_DB.prepare(`UPDATE managed_service_operations SET status='held',next_reconcile_at=NULL,
        lease_until=NULL,error_code='userport_agentport_revoke_request_invalid',last_reconciled_at=?,updated_at=?
        WHERE operation_id=? AND tenant_id=? AND status='uncertain'`)
        .bind(now.toISOString(), now.toISOString(), row.operation_id, row.tenant_id).run();
      deferred++; continue;
    }
    const binding = await env.PLATFORM_DB.prepare(`SELECT account_id,previous_account_id FROM agentport_userport_connector_bindings
      WHERE tenant_id=? AND space_id=? AND alias_id=?`)
      .bind(row.tenant_id, row.space_id, aliasId).first<{ account_id: string; previous_account_id: string | null }>();
    const currentIds = binding ? [...new Set([binding.account_id, binding.previous_account_id].filter((id): id is string => !!id))].sort() : [];
    if (!binding || JSON.stringify(currentIds) !== JSON.stringify(accountIds)) {
      await env.PLATFORM_DB.prepare(`UPDATE managed_service_operations SET status='held',next_reconcile_at=NULL,
        lease_until=NULL,error_code='userport_agentport_revoke_scope_changed',last_reconciled_at=?,updated_at=?
        WHERE operation_id=? AND tenant_id=? AND status='uncertain'`)
        .bind(now.toISOString(), now.toISOString(), row.operation_id, row.tenant_id).run();
      deferred++; continue;
    }
    try {
      const outcome = await revokeUserPortAgentPortConnector(env, {
        tenantId: row.tenant_id, spaceId: row.space_id, userId: row.tenant_id, role: "owner",
      }, aliasId);
      if (outcome.revoked) reconciled++; else deferred++;
    } catch {
      // The owner action re-journals the same exact account set with a bounded retry time.
      failed++;
    }
  }
  return { checked: due.results?.length ?? 0, reconciled, deferred, failed };
}

export async function sweepUserPortAgentPortOperations(env: AgentsEnv, now = new Date(), limit = 10) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25) throw new Error("userport_agentport_reconciliation_limit_invalid");
  const revocations=await sweepUserPortAgentPortRevocations(env,now,limit);
  const remaining=limit-revocations.checked;
  const syncs=remaining>0?await sweepUserPortAgentPortSyncs(env,now,remaining):{checked:0,reconciled:0,deferred:0,failed:0};
  return {checked:revocations.checked+syncs.checked,reconciled:revocations.reconciled+syncs.reconciled,
    deferred:revocations.deferred+syncs.deferred,failed:revocations.failed+syncs.failed};
}

export async function revokeUserPortAgentPortOwnerLink(env: AgentsEnv, scope: CommunicationScope, ownerLinkId: string) {
  if (!validId(ownerLinkId)) throw new Error("managed_service_owner_link_invalid");
  const link = await env.PLATFORM_DB.prepare(`SELECT owner_type,owner_id FROM managed_service_owner_links
    WHERE id=? AND tenant_id=? LIMIT 1`).bind(ownerLinkId, scope.tenantId)
    .first<{owner_type:string;owner_id:string}>();
  if (!link || (link.owner_type === "organization" && link.owner_id !== scope.tenantId)
    || (link.owner_type === "user" && link.owner_id !== scope.userId)
    || !["organization", "user"].includes(link.owner_type))
    throw new Error("managed_service_owner_link_not_found");
  const pendingSync=await env.PLATFORM_DB.prepare(`SELECT operation_id FROM managed_service_operations
    WHERE tenant_id=? AND operation_name='agentport_connector_sync' AND status IN ('pending','running','uncertain')
      AND json_extract(request_json,'$.ownerLinkId')=? LIMIT 1`)
    .bind(scope.tenantId,ownerLinkId).first<{operation_id:string}>();
  if (pendingSync) throw new Error("userport_agentport_sync_pending");
  const revokedAt=new Date().toISOString();
  await env.PLATFORM_DB.prepare(`UPDATE managed_service_owner_links SET status='revoked',revoked_by_user_id=?,
    revoked_at=COALESCE(revoked_at,?),updated_at=? WHERE id=? AND tenant_id=? AND owner_type=? AND owner_id=? AND status='active'`)
    .bind(scope.userId,revokedAt,revokedAt,ownerLinkId,scope.tenantId,link.owner_type,link.owner_id).run();
  const heldSyncs=await env.PLATFORM_DB.prepare(`SELECT operation_id,request_json,project_id FROM managed_service_operations
    WHERE tenant_id=? AND operation_name='agentport_connector_sync' AND status='held'
      AND json_extract(request_json,'$.ownerLinkId')=?`).bind(scope.tenantId,ownerLinkId)
    .all<{operation_id:string;request_json:string;project_id:string|null}>();
  if ((heldSyncs.results??[]).some(operation=>!recoverableSyncRequest(operation.request_json,ownerLinkId,operation.project_id,
    link.owner_type,link.owner_id,scope.userId)))
    throw new Error("userport_agentport_sync_recovery_unavailable");
  let cleanupPending=heldSyncs.results?.length??0;
  for (const operation of heldSyncs.results ?? []) {
    await env.PLATFORM_DB.prepare(`UPDATE managed_service_operations SET status='uncertain',error_code='userport_connector_cleanup_requested',
      lease_until=NULL,next_reconcile_at=?,updated_at=? WHERE operation_id=? AND tenant_id=? AND status='held'`)
      .bind(revokedAt,revokedAt,operation.operation_id,scope.tenantId).run();
  }
  const rows = await env.PLATFORM_DB.prepare(`SELECT space_id,alias_id FROM agentport_userport_connector_bindings
    WHERE tenant_id=? AND owner_link_id=? ORDER BY space_id,alias_id`).bind(scope.tenantId, ownerLinkId)
    .all<{space_id:string;alias_id:string}>();
  for (const row of rows.results) {
    const sync=await env.PLATFORM_DB.prepare(`SELECT operation_id FROM managed_service_operations
      WHERE tenant_id=? AND space_id=? AND operation_name='agentport_connector_sync'
        AND status IN ('pending','running','uncertain','held') AND json_extract(request_json,'$.aliasId')=? LIMIT 1`)
      .bind(scope.tenantId,row.space_id,row.alias_id).first<{operation_id:string}>();
    if (sync) continue;
    const revoked = await revokeUserPortAgentPortConnector(env,
      { tenantId:scope.tenantId, spaceId:row.space_id, userId:scope.userId, role:scope.role }, row.alias_id);
    if (!revoked.revoked && !("idempotent" in revoked && revoked.idempotent)) throw new Error("userport_agentport_revoke_pending");
  }
  return { revoked:true, aliasCount:rows.results.length, cleanupPending };
}
