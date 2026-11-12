import { mintInternalToken, readBoundedResponseJson } from "@naelao/http";
import type { AgentsEnv } from "../index.js";
import { ensureAgentPortAssistantIdentity, type CommunicationIdentity, type CommunicationScope } from "./core.js";
import { ensureManagedServiceOwnerLink } from "./managed-service-ownership.js";

const SERVICE_CAPABILITY = "phone.sms.send";

async function agentPort(env: AgentsEnv, tenantId: string, path: string, method = "GET", body?: unknown, allowNotFound = false) {
  const response = await env.AGENTPORT_WORKER.fetch(new Request(`https://agentport.internal/internal/agentport${path}`, {
    method,
    headers: { "content-type": "application/json", "x-agentport-tenant-id": tenantId,
      "x-agentport-actor-role": "client_system", "x-agentport-actor-id": tenantId,
      "x-agentport-internal-token": await mintInternalToken(env.PLATFORM_SECRET, tenantId) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  const result = await readBoundedResponseJson<Record<string, unknown>>(response, 64 * 1024);
  if (!response.ok && response.status !== 409 && !(allowNotFound && response.status === 404)) throw new Error(`agentport_${String(result.error_code ?? "request_failed")}`);
  return { response, result };
}

async function stableId(prefix: string, input: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)));
  return `${prefix}_${[...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("").slice(0, 48)}`;
}

async function recordAgentPortOperation(env: AgentsEnv, scope: CommunicationScope, bindingId: string,
  kind: "sync" | "revoke", status: "running" | "complete" | "uncertain", errorCode: string | null = null) {
  const accountId = `telnyx-${bindingId}`;
  const account = await env.PLATFORM_DB.prepare(`SELECT provider,service_id,capability_version FROM managed_service_accounts
    WHERE id=? AND tenant_id=? AND space_id=?`).bind(accountId, scope.tenantId, scope.spaceId)
    .first<{provider:string;service_id:string;capability_version:number|null}>();
  if (!account) throw new Error("telnyx_agentport_account_record_unavailable");
  const operation = `agentport_${kind}`;
  const requestHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([accountId,operation,SERVICE_CAPABILITY]))))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
  const operationId = await stableId("telnyx_ap", `${bindingId}:${kind}`);
  const at = new Date().toISOString();
  await env.PLATFORM_DB.prepare(`INSERT OR IGNORE INTO managed_service_operations(operation_id,tenant_id,space_id,project_id,account_id,
      provider,service_id,capability_version,operation_name,idempotency_key,request_sha256,status,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)`)
    .bind(operationId,scope.tenantId,scope.spaceId,scope.projectId??null,accountId,account.provider,account.service_id,account.capability_version,
      operation,operationId,requestHash,at,at).run();
  const existing = await env.PLATFORM_DB.prepare("SELECT request_sha256,provider,service_id,account_id,operation_name FROM managed_service_operations WHERE operation_id=? AND tenant_id=?")
    .bind(operationId,scope.tenantId).first<{request_sha256:string;provider:string;service_id:string;account_id:string;operation_name:string}>();
  if (!existing || existing.request_sha256 !== requestHash || existing.provider !== account.provider || existing.service_id !== account.service_id
    || existing.account_id !== accountId || existing.operation_name !== operation) throw new Error("telnyx_agentport_operation_identity_conflict");
  await env.PLATFORM_DB.prepare("UPDATE managed_service_operations SET status=?,error_code=?,lease_until=NULL,updated_at=? WHERE operation_id=? AND tenant_id=?")
    .bind(status,errorCode,at,operationId,scope.tenantId).run();
  return operationId;
}

async function ownedBinding(env: AgentsEnv, scope: CommunicationScope, identity: CommunicationIdentity, bindingId: string, allowInactive = false) {
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(bindingId)) throw new Error("telnyx_agentport_binding_invalid");
  const row = await env.PLATFORM_DB.prepare(`SELECT b.id,b.provider,b.status,b.payer,b.provider_number_sid,b.phone_number,
      m.id AS managed_id,m.agentport_agent_id,m.agentport_account_id
    FROM assistant_phone_bindings b LEFT JOIN managed_service_accounts m ON m.id='telnyx-'||b.id
    WHERE b.id=? AND b.identity_id=? AND b.purpose='assistant' AND b.provider='telnyx'
      AND EXISTS(SELECT 1 FROM assistant_communication_identities i WHERE i.id=b.identity_id AND i.tenant_id=? AND i.space_id=? AND i.project_id IS ? AND i.owner_user_id=?)`)
    .bind(bindingId, identity.id, scope.tenantId, scope.spaceId, scope.projectId ?? null, scope.userId)
    .first<{id:string;provider:string;status:string;payer:string;provider_number_sid:string;phone_number:string;managed_id:string|null;agentport_agent_id:string|null;agentport_account_id:string|null}>();
  if (!row || (!allowInactive && row.status !== "active")
    || (allowInactive && !["active","billing_hold","indeterminate","disabling"].includes(row.status))
    || !row.managed_id || !row.provider_number_sid || !row.phone_number) throw new Error("telnyx_agentport_binding_unavailable");
  return row;
}

/** Owner-confirmed customer-owned number share. It registers one opaque resource reference and one SMS action grant. */
export async function shareTelnyxSmsWithAgentPort(env: AgentsEnv, scope: CommunicationScope, identity: CommunicationIdentity, bindingId: string) {
  const binding = await ownedBinding(env, scope, identity, bindingId);
  if (binding.payer !== "byo") throw new Error("telnyx_agentport_customer_owned_only");
  await recordAgentPortOperation(env,scope,bindingId,"sync","running");
  await env.PLATFORM_DB.prepare("UPDATE managed_service_accounts SET agentport_link_status='pending',updated_at=? WHERE id=? AND tenant_id=?")
    .bind(new Date().toISOString(),binding.managed_id,scope.tenantId).run();
  try {
  const agentId = await ensureAgentPortAssistantIdentity(env, scope);
  const principalId = await stableId("prn_user", `${scope.tenantId}:${scope.userId}`);
  const principal = await agentPort(env, scope.tenantId, "/principals", "POST", {
    id: principalId, externalId: scope.userId, organizationName: "Naelao",
  });
  const principalRecord = principal.result.principal as {id?:unknown}|undefined;
  if (typeof principalRecord?.id !== "string" || principalRecord.id !== principalId) throw new Error("agentport_owner_principal_unavailable");
  const ownerLinkId = await ensureManagedServiceOwnerLink(env, scope, {
    ownerType: "user", ownerId: scope.userId, principalId, consentSource: "telnyx_sms_agentport_share",
  });

  const serviceId = `telnyx-v2:${scope.tenantId}`;
  const service = await agentPort(env, scope.tenantId, `/services/${encodeURIComponent(serviceId)}`, "GET", undefined, true);
  if (service.response.status === 404) {
    const created = await agentPort(env, scope.tenantId, "/services", "POST", {
      id: serviceId, name: "Telnyx SMS", type: "api", accountModels: ["agent_native"],
      capabilities: [SERVICE_CAPABILITY], events: [], connectionPurpose: "user_delegation",
      partnershipStatus: "unaffiliated", auth: { type: "provider_connection_reference" },
      provisioning: { mode: "owner_connected_reference" },
    });
    if (!created.result.service) throw new Error("agentport_telnyx_service_unavailable");
  } else {
    const existing = service.result.service as {id?:unknown;capabilities?:unknown;account_models?:unknown;status?:unknown}|undefined;
    if (existing?.id !== serviceId || existing.status !== "active" || !Array.isArray(existing.capabilities)
      || !Array.isArray(existing.account_models) || JSON.stringify([...existing.account_models].sort()) !== JSON.stringify(["agent_native"])
      || JSON.stringify(existing.capabilities) !== JSON.stringify([SERVICE_CAPABILITY])) throw new Error("agentport_telnyx_service_conflict");
  }

  const accountRef = `telnyx-${binding.id}`;
  const accountResponse = await agentPort(env, scope.tenantId, "/accounts", "POST", {
    serviceId, accountModel: "agent_native", ownerType: "individual", ownerId: scope.userId,
    externalAccountId: accountRef, credentialRef: binding.managed_id,
    metadata: { provider: "telnyx", connectionMode: "user_connected", capabilities: [SERVICE_CAPABILITY] },
  });
  const account = accountResponse.result.account as {id?:unknown;status?:unknown}|undefined;
  if (typeof account?.id !== "string") throw new Error("agentport_telnyx_account_unavailable");
  if (account.status === "pending") await agentPort(env, scope.tenantId, `/accounts/${encodeURIComponent(account.id)}/activate`, "POST", {});
  else if (account.status === "revoked") await agentPort(env, scope.tenantId, `/accounts/${encodeURIComponent(account.id)}/reactivate`, "POST", {});
  const grant = await agentPort(env, scope.tenantId, `/accounts/${encodeURIComponent(account.id)}/grants`, "POST", {
    agentId, grantedBy: scope.userId, permissions: [SERVICE_CAPABILITY],
  });
  if (!grant.result.grant) throw new Error("agentport_telnyx_grant_unavailable");
  await env.PLATFORM_DB.prepare(`UPDATE managed_service_accounts SET agentport_principal_id=?,agentport_agent_id=?,agentport_account_id=?,
      owner_link_id=?,agentport_link_status='active',updated_at=? WHERE id=? AND tenant_id=? AND space_id=? AND lifecycle_state='active'`)
    .bind(principalId, agentId, account.id, ownerLinkId, new Date().toISOString(), binding.managed_id, scope.tenantId, scope.spaceId).run();
  const persisted = await env.PLATFORM_DB.prepare("SELECT agentport_agent_id,agentport_account_id FROM managed_service_accounts WHERE id=? AND tenant_id=?")
    .bind(binding.managed_id, scope.tenantId).first<{agentport_agent_id:string|null;agentport_account_id:string|null}>();
  if (persisted?.agentport_agent_id !== agentId || persisted.agentport_account_id !== account.id) throw new Error("telnyx_agentport_link_persistence_failed");
  await recordAgentPortOperation(env,scope,bindingId,"sync","complete");
  return { shared: true, capability: SERVICE_CAPABILITY, deduplicated: accountResponse.response.status !== 201 };
  } catch (error) {
    const code = error instanceof Error && /^[a-z][a-z0-9_:-]{1,100}$/.test(error.message) ? error.message : "agentport_sync_interrupted";
    await env.PLATFORM_DB.prepare("UPDATE managed_service_accounts SET agentport_link_status='unknown',updated_at=? WHERE id=? AND tenant_id=?")
      .bind(new Date().toISOString(),binding.managed_id,scope.tenantId).run().catch(() => undefined);
    await recordAgentPortOperation(env,scope,bindingId,"sync","uncertain",code).catch(() => undefined);
    throw error;
  }
}

/** Revoke this account's AgentPort access without revoking the user's shared owner principal link. */
export async function revokeTelnyxAgentPortShare(env: AgentsEnv, scope: CommunicationScope, identity: CommunicationIdentity, bindingId: string) {
  const binding = await ownedBinding(env, scope, identity, bindingId, true);
  if (!binding.agentport_account_id) return { revoked: true, alreadyUnlinked: true };
  await recordAgentPortOperation(env,scope,bindingId,"revoke","running");
  await env.PLATFORM_DB.prepare("UPDATE managed_service_accounts SET agentport_link_status='revoking',updated_at=? WHERE id=? AND tenant_id=?")
    .bind(new Date().toISOString(),binding.managed_id,scope.tenantId).run();
  try {
    const revoked = await agentPort(env, scope.tenantId, `/accounts/${encodeURIComponent(binding.agentport_account_id)}/revoke`, "POST", {});
    if (revoked.result.revoked !== true) throw new Error("telnyx_agentport_revoke_unconfirmed");
    const saved = await env.PLATFORM_DB.prepare(`UPDATE managed_service_accounts SET agentport_link_status='revoked',updated_at=?
      WHERE id=? AND tenant_id=? AND agentport_account_id=? AND agentport_link_status='revoking'`)
      .bind(new Date().toISOString(), binding.managed_id, scope.tenantId, binding.agentport_account_id).run();
    if (!saved.meta.changes) throw new Error("telnyx_agentport_revoke_persistence_failed");
    await recordAgentPortOperation(env,scope,bindingId,"revoke","complete");
    return { revoked: true, alreadyUnlinked: false };
  } catch (error) {
    const code = error instanceof Error && /^[a-z][a-z0-9_:-]{1,100}$/.test(error.message) ? error.message : "agentport_revoke_interrupted";
    await env.PLATFORM_DB.prepare("UPDATE managed_service_accounts SET agentport_link_status='unknown',updated_at=? WHERE id=? AND tenant_id=?")
      .bind(new Date().toISOString(),binding.managed_id,scope.tenantId).run().catch(() => undefined);
    await recordAgentPortOperation(env,scope,bindingId,"revoke","uncertain",code).catch(() => undefined);
    throw error;
  }
}

/** Called before each owner-approved send when the resource is linked; never forwards message content to AgentPort. */
export async function authorizeTelnyxSmsViaAgentPort(env: AgentsEnv, scope: CommunicationScope, bindingId: string, actionId: string) {
  const link = await env.PLATFORM_DB.prepare(`SELECT agentport_agent_id,agentport_account_id,agentport_link_status FROM managed_service_accounts
    WHERE id=? AND tenant_id=? AND space_id=? AND lifecycle_state='active'`)
    .bind(`telnyx-${bindingId}`, scope.tenantId, scope.spaceId).first<{agentport_agent_id:string|null;agentport_account_id:string|null;agentport_link_status:string|null}>();
  if (link?.agentport_link_status === "revoked") return { linked: false };
  if (link && link.agentport_link_status !== "active") {
    if (!link.agentport_account_id && !link.agentport_agent_id) return { linked: false };
    throw new Error("telnyx_agentport_link_incomplete");
  }
  if (!link?.agentport_account_id && !link?.agentport_agent_id) return { linked: false };
  if (!link.agentport_account_id || !link.agentport_agent_id) throw new Error("telnyx_agentport_link_incomplete");
  const idempotencyKey = await stableId("telnyx_sms", `${bindingId}:${actionId}`);
  const authorization = await agentPort(env, scope.tenantId, `/accounts/${encodeURIComponent(link.agentport_account_id)}/actions/authorize`, "POST", {
    agentId: link.agentport_agent_id, action: SERVICE_CAPABILITY, idempotencyKey, resourceRef: `telnyx-${bindingId}`,
  });
  if (authorization.result.decision !== "allow") throw new Error("telnyx_agentport_action_denied");
  return { linked: true };
}
