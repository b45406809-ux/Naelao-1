import { mintInternalToken, readBoundedResponseJson } from "@naelao/http";
import type { AgentsEnv } from "../index.js";
import { ensureAgentPortAssistantIdentity, type CommunicationIdentity, type CommunicationScope } from "./core.js";
import { ensureManagedServiceOwnerLink } from "./managed-service-ownership.js";

const ACTIONS = ["higgsfield.video.estimate", "higgsfield.video.generate"] as const;
type Action = typeof ACTIONS[number];

async function agentPort(env: AgentsEnv, tenantId: string, path: string, method = "GET", body?: unknown, allowNotFound = false) {
  if (!env.AGENTPORT_WORKER) throw new Error("agentport_worker_unavailable");
  const response = await env.AGENTPORT_WORKER.fetch(new Request(`https://agentport.internal/internal/agentport${path}`, {
    method, headers: { "content-type": "application/json", "x-agentport-tenant-id": tenantId,
      "x-agentport-actor-role": "client_system", "x-agentport-actor-id": tenantId,
      "x-agentport-internal-token": await mintInternalToken(env.PLATFORM_SECRET, tenantId) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  const result = await readBoundedResponseJson<Record<string, unknown>>(response, 64 * 1024);
  if (!response.ok && !(allowNotFound && response.status === 404)) throw new Error(`agentport_${String(result.error_code ?? "request_failed")}`);
  return { response, result };
}

async function digest(value: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function ownerAccount(env: AgentsEnv, scope: CommunicationScope, identity: CommunicationIdentity, accountId: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(accountId)) throw new Error("higgsfield_account_unavailable");
  const account = await env.PLATFORM_DB.prepare(`SELECT h.id FROM assistant_higgsfield_accounts h
    JOIN managed_service_accounts m ON m.id=h.id AND m.tenant_id=h.tenant_id
    WHERE h.id=? AND h.tenant_id=? AND h.space_id=? AND h.project_id IS ? AND h.owner_user_id=?
      AND h.assistant_identity_id=? AND h.status='active' AND m.lifecycle_state='active'`)
    .bind(accountId, scope.tenantId, scope.spaceId, scope.projectId ?? null, scope.userId, identity.id)
    .first<{ id: string }>();
  if (!account) throw new Error("higgsfield_account_unavailable");
  return account.id;
}

async function ownerPrincipal(env: AgentsEnv, scope: CommunicationScope) {
  const principalId = `prn_user_${(await digest(`${scope.tenantId}:${scope.userId}`)).slice(0, 48)}`;
  const { result } = await agentPort(env, scope.tenantId, "/principals", "POST", {
    id: principalId, externalId: scope.userId, organizationName: "Naelao",
  });
  const principal = result.principal as Record<string, unknown> | undefined;
  if (principal?.id !== principalId || principal.external_id !== scope.userId) throw new Error("higgsfield_agentport_owner_principal_unavailable");
  return principalId;
}

async function ensureService(env: AgentsEnv, tenantId: string, serviceId: string) {
  const existing = await agentPort(env, tenantId, `/services/${encodeURIComponent(serviceId)}`, "GET", undefined, true);
  if (existing.response.status === 404) {
    const created = await agentPort(env, tenantId, "/services", "POST", {
      id: serviceId, name: "Higgsfield customer connected video generation", type: "api", accountModels: ["agent_native"],
      capabilities: [...ACTIONS], events: [], connectionPurpose: "user_delegation", partnershipStatus: "unaffiliated",
      auth: { type: "provider_connection_reference" }, billing: { payer: "connected_provider_account" },
      provisioning: { mode: "customer_owned_reference", version: 1 },
    });
    if (!created.result.service) throw new Error("higgsfield_agentport_service_unavailable");
    return;
  }
  const service = existing.result.service as Record<string, unknown> | undefined;
  const accountModels = Array.isArray(service?.account_models) ? [...service.account_models].sort()
    : Array.isArray(service?.accountModels) ? [...service.accountModels].sort() : [];
  if (service?.id !== serviceId || service.status !== "active" || !Array.isArray(service.capabilities)
    || JSON.stringify([...service.capabilities].sort()) !== JSON.stringify([...ACTIONS].sort())
    || JSON.stringify(accountModels) !== JSON.stringify(["agent_native"]))
    throw new Error("higgsfield_agentport_service_conflict");
}

export async function shareHiggsfieldWithAgentPort(env: AgentsEnv, scope: CommunicationScope,
  identity: CommunicationIdentity, accountId: string) {
  const ownedId = await ownerAccount(env, scope, identity, accountId);
  const stored = await env.PLATFORM_DB.prepare(`SELECT agentport_agent_id,agentport_account_id,agentport_link_status,owner_link_id
    FROM managed_service_accounts WHERE id=? AND tenant_id=?`).bind(ownedId, scope.tenantId)
    .first<{agentport_agent_id:string|null;agentport_account_id:string|null;agentport_link_status:string|null;owner_link_id:string|null}>();
  if (stored?.agentport_link_status === "active" && stored.agentport_account_id && stored.agentport_agent_id)
    return { shared: true, accountId: stored.agentport_account_id, actions: [...ACTIONS], idempotent: true };
  const at = new Date().toISOString();
  const serviceId = `higgsfield_v2_${(await digest(scope.tenantId)).slice(0, 40)}`;
  const operationId = `hfa_sync_${(await digest(`${scope.tenantId}:${ownedId}:${serviceId}`)).slice(0, 40)}`;
  const requestHash = await digest(JSON.stringify({ accountId: ownedId, serviceId, actions: ACTIONS }));
  await env.PLATFORM_DB.prepare(`INSERT OR IGNORE INTO managed_service_operations(
    operation_id,tenant_id,space_id,project_id,account_id,provider,service_id,operation_name,idempotency_key,request_sha256,status,request_json,created_at,updated_at)
    VALUES(?,?,?,?,?,'higgsfield',?,'agentport_share',?,?, 'pending',?,?,?)`)
    .bind(operationId,scope.tenantId,scope.spaceId,scope.projectId??null,ownedId,serviceId,operationId,requestHash,
      JSON.stringify({ accountId: ownedId, actions: ACTIONS }),at,at).run();
  const operation = await env.PLATFORM_DB.prepare("SELECT request_sha256,status,lease_until FROM managed_service_operations WHERE operation_id=? AND tenant_id=?")
    .bind(operationId,scope.tenantId).first<{request_sha256:string;status:string;lease_until:string|null}>();
  if (!operation || operation.request_sha256 !== requestHash) throw new Error("higgsfield_agentport_operation_conflict");
  const claimed = await env.PLATFORM_DB.prepare(`UPDATE managed_service_operations SET status='running',lease_until=?,error_code=NULL,updated_at=?
    WHERE operation_id=? AND tenant_id=? AND (status IN ('pending','held','uncertain') OR (status='running' AND (lease_until IS NULL OR lease_until<=?)))`)
    .bind(new Date(Date.now()+120_000).toISOString(),at,operationId,scope.tenantId,at).run();
  if (!claimed.meta.changes && operation.status === "running") return { shared:false,pending:true,actions:[...ACTIONS] };
  try {
    const agentId = await ensureAgentPortAssistantIdentity(env, scope);
    const principalId = await ownerPrincipal(env, scope);
    const ownerLinkId = await ensureManagedServiceOwnerLink(env, scope,
      { ownerType:"user", ownerId:scope.userId, principalId, consentSource:"higgsfield.agentport_share" });
    await ensureService(env, scope.tenantId, serviceId);
    const externalAccountId = `higgsfield:${(await digest(ownedId)).slice(0, 40)}`;
    const { result: accountResult } = await agentPort(env, scope.tenantId, "/accounts", "POST", {
      serviceId, accountModel:"agent_native", ownerType:"individual", ownerId:scope.userId,
      externalAccountId, credentialRef:ownedId, metadata:{ provider:"higgsfield",connectionMode:"user_connected",selectedActions:[...ACTIONS] },
    });
    const account = accountResult.account as Record<string, unknown> | undefined;
    const agentPortAccountId = typeof account?.id === "string" ? account.id : "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(agentPortAccountId)) throw new Error("higgsfield_agentport_account_unavailable");
    if (account?.status === "pending") await agentPort(env, scope.tenantId, `/accounts/${encodeURIComponent(agentPortAccountId)}/activate`, "POST", {});
    else if (account?.status === "revoked") await agentPort(env, scope.tenantId, `/accounts/${encodeURIComponent(agentPortAccountId)}/reactivate`, "POST", {});
    const { result: grantResult } = await agentPort(env, scope.tenantId, `/accounts/${encodeURIComponent(agentPortAccountId)}/grants`, "POST", {
      agentId, grantedBy:scope.userId, permissions:[...ACTIONS],
    });
    if (!grantResult.grant) throw new Error("higgsfield_agentport_grant_unavailable");
    const saved = await env.PLATFORM_DB.prepare(`UPDATE managed_service_accounts SET agentport_principal_id=?,agentport_agent_id=?,
      agentport_account_id=?,owner_link_id=?,agentport_link_status='active',updated_at=? WHERE id=? AND tenant_id=? AND owner_id=? AND lifecycle_state='active'`)
      .bind(principalId,agentId,agentPortAccountId,ownerLinkId,new Date().toISOString(),ownedId,scope.tenantId,scope.userId).run();
    if (saved.meta.changes !== 1) throw new Error("higgsfield_agentport_link_persistence_failed");
    await env.PLATFORM_DB.prepare(`UPDATE managed_service_operations SET status='complete',provider_operation_ref=?,lease_until=NULL,error_code=NULL,updated_at=?
      WHERE operation_id=? AND tenant_id=? AND status='running'`).bind(agentPortAccountId,new Date().toISOString(),operationId,scope.tenantId).run();
    return { shared:true,accountId:agentPortAccountId,actions:[...ACTIONS],idempotent:false };
  } catch (error) {
    const message=error instanceof Error?error.message:"higgsfield_agentport_share_uncertain";
    const code=/^[a-z][a-z0-9_:-]{1,120}$/.test(message)?message:"higgsfield_agentport_share_uncertain";
    await env.PLATFORM_DB.prepare(`UPDATE managed_service_operations SET status='uncertain',error_code=?,lease_until=NULL,updated_at=?
      WHERE operation_id=? AND tenant_id=?`).bind(code,new Date().toISOString(),operationId,scope.tenantId).run().catch(()=>undefined);
    throw error;
  }
}

export async function revokeHiggsfieldAgentPortShare(env: AgentsEnv, scope: CommunicationScope,
  identity: CommunicationIdentity, accountId: string) {
  const ownedId = await ownerAccount(env, scope, identity, accountId);
  const stored = await env.PLATFORM_DB.prepare(`SELECT agentport_agent_id,agentport_account_id,agentport_link_status FROM managed_service_accounts
    WHERE id=? AND tenant_id=? AND space_id=?`).bind(ownedId,scope.tenantId,scope.spaceId)
    .first<{agentport_agent_id:string|null;agentport_account_id:string|null;agentport_link_status:string|null}>();
  if (!stored) throw new Error("higgsfield_account_unavailable");
  if (!stored.agentport_account_id) {
    if (stored.agentport_link_status === null || stored.agentport_link_status === "revoked") return { revoked:true,alreadyUnlinked:true };
    throw new Error("higgsfield_agentport_link_reconciliation_required");
  }
  const at=new Date().toISOString();
  await env.PLATFORM_DB.prepare("UPDATE managed_service_accounts SET agentport_link_status='revoking',updated_at=? WHERE id=? AND tenant_id=?")
    .bind(at,ownedId,scope.tenantId).run();
  try {
    const { result }=await agentPort(env,scope.tenantId,`/accounts/${encodeURIComponent(stored.agentport_account_id)}/revoke`,"POST",{});
    if(result.revoked!==true)throw new Error("higgsfield_agentport_revoke_unconfirmed");
    const saved=await env.PLATFORM_DB.prepare(`UPDATE managed_service_accounts SET agentport_link_status='revoked',updated_at=?
      WHERE id=? AND tenant_id=? AND agentport_account_id=? AND agentport_link_status='revoking'`)
      .bind(new Date().toISOString(),ownedId,scope.tenantId,stored.agentport_account_id).run();
    if(saved.meta.changes!==1)throw new Error("higgsfield_agentport_revoke_persistence_failed");
    return {revoked:true,alreadyUnlinked:false};
  } catch(error) {
    await env.PLATFORM_DB.prepare("UPDATE managed_service_accounts SET agentport_link_status='unknown',updated_at=? WHERE id=? AND tenant_id=?")
      .bind(new Date().toISOString(),ownedId,scope.tenantId).run().catch(()=>undefined);
    throw error;
  }
}

export async function authorizeHiggsfieldAgentOperation(env: AgentsEnv, scope: CommunicationScope, accountId: string,
  agentId: string, operation: "estimate" | "generate", requestKey: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(agentId)) throw new Error("higgsfield_agentport_agent_required");
  const row=await env.PLATFORM_DB.prepare(`SELECT agentport_account_id,agentport_agent_id,agentport_link_status FROM managed_service_accounts
    WHERE id=? AND tenant_id=? AND space_id=? AND owner_id=? AND lifecycle_state='active'`)
    .bind(accountId,scope.tenantId,scope.spaceId,scope.userId)
    .first<{agentport_account_id:string|null;agentport_agent_id:string|null;agentport_link_status:string|null}>();
  if (!row || row.agentport_link_status!=="active" || !row.agentport_account_id || row.agentport_agent_id!==agentId)
    throw new Error("higgsfield_agentport_share_required");
  const action:Action=operation==="estimate"?ACTIONS[0]:ACTIONS[1];
  const idempotencyKey=`hfa_${(await digest(`${accountId}:${agentId}:${operation}:${requestKey}`)).slice(0,48)}`;
  const { result }=await agentPort(env,scope.tenantId,`/accounts/${encodeURIComponent(row.agentport_account_id)}/actions/authorize`,"POST",{
    agentId,action,resourceRef:accountId,idempotencyKey,
  });
  if(result.decision!=="allow")throw new Error("higgsfield_agentport_action_denied");
  return {authorized:true};
}
