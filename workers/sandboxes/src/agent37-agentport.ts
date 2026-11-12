import { mintInternalToken, readBoundedResponseJson } from "@naelao/http";

export const AGENT37_AGENTPORT_CAPABILITIES = [
  "agent37.computer.start",
  "agent37.computer.sleep",
  "agent37.exec",
  "agent37.artifacts.read",
  "agent37.artifacts.write",
] as const;
export type Agent37AgentPortCapability = typeof AGENT37_AGENTPORT_CAPABILITIES[number];

export interface Agent37AgentPortEnv {
  PLATFORM_DB: D1Database;
  PLATFORM_SECRET: string;
  AGENTPORT_WORKER?: Fetcher;
}

export interface Agent37AgentPortComputer {
  id: string;
  tenant_id: string;
  owner_id: string;
  space_id: string;
  project_id: string;
  connection_id: string;
}

async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validId(value: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value); }

async function agentPort(env: Agent37AgentPortEnv, tenantId: string, path: string, method = "GET", body?: unknown, allowNotFound = false) {
  if (!env.AGENTPORT_WORKER) throw new Error("agentport_worker_unavailable");
  const response = await env.AGENTPORT_WORKER.fetch(new Request(`https://agentport.internal/internal/agentport${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-agentport-tenant-id": tenantId,
      "x-agentport-actor-role": "client_system",
      "x-agentport-actor-id": tenantId,
      "x-agentport-internal-token": await mintInternalToken(env.PLATFORM_SECRET, tenantId),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  const result = await readBoundedResponseJson<Record<string, unknown>>(response, 64 * 1024);
  if (!response.ok && !(allowNotFound && response.status === 404))
    throw new Error(`agentport_${String(result.error_code ?? "request_failed")}`);
  return { response, result };
}

async function operation(env: Agent37AgentPortEnv, computer: Agent37AgentPortComputer, key: string,
  kind: "share" | "revoke", requestHash: string, requestJson = "{}") {
  const operationId = `ag37ap_${(await digest(`${computer.tenant_id}:${computer.owner_id}:${computer.id}:${key}`)).slice(0, 40)}`;
  const now = new Date().toISOString();
  await env.PLATFORM_DB.prepare(`INSERT OR IGNORE INTO sandbox_agentport_operations
    (id,tenant_id,owner_id,computer_id,operation,idempotency_key,request_sha256,status,request_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,'pending',?,?,?)`).bind(operationId, computer.tenant_id, computer.owner_id, computer.id, kind, key, requestHash, requestJson, now, now).run();
  const row = await env.PLATFORM_DB.prepare(`SELECT id,operation,request_sha256,status,request_json,lease_until FROM sandbox_agentport_operations
    WHERE tenant_id=? AND owner_id=? AND computer_id=? AND idempotency_key=?`)
    .bind(computer.tenant_id, computer.owner_id, computer.id, key)
    .first<{id:string;operation:string;request_sha256:string;status:string;request_json:string;lease_until:string|null}>();
  if (!row || row.operation !== kind || row.request_sha256 !== requestHash) throw new Error("agentport_operation_idempotency_conflict");
  return row;
}

async function markOperation(env: Agent37AgentPortEnv, operationId: string, tenantId: string,
  status: "complete" | "unknown", errorCode: string | null = null, nextReconcileAt: string | null = null) {
  await env.PLATFORM_DB.prepare(`UPDATE sandbox_agentport_operations SET status=?,error_code=?,lease_until=NULL,next_reconcile_at=?,updated_at=? WHERE id=? AND tenant_id=?`)
    .bind(status, errorCode, nextReconcileAt, new Date().toISOString(), operationId, tenantId).run();
}

async function ownerPrincipal(env: Agent37AgentPortEnv, computer: Agent37AgentPortComputer) {
  const principalId = `prn_user_${(await digest(`${computer.tenant_id}:${computer.owner_id}`)).slice(0, 48)}`;
  const { result } = await agentPort(env, computer.tenant_id, "/principals", "POST", {
    id: principalId, externalId: computer.owner_id, organizationName: "Naelao",
  });
  const principal = result.principal as Record<string, unknown> | undefined;
  if (principal?.id !== principalId || principal.external_id !== computer.owner_id)
    throw new Error("agentport_owner_principal_unavailable");
  return principalId;
}

async function assistantAgent(env: Agent37AgentPortEnv, computer: Agent37AgentPortComputer) {
  const resource = `project:${computer.project_id}`;
  const agentId = `naelao_${(await digest(JSON.stringify([computer.tenant_id, computer.space_id, resource])))}`;
  const { result } = await agentPort(env, computer.tenant_id, "/agents", "POST", {
    id: agentId, principalId: computer.tenant_id, principalType: "organization", createdBy: computer.tenant_id,
    hostPlatform: "naelao", hostResourceId: resource, runtime: "naelao-agents-worker",
  });
  const agent = result.agent as Record<string, unknown> | undefined;
  if (agent?.id !== agentId) throw new Error("agentport_project_assistant_unavailable");
  return agentId;
}

async function ownerLink(env: Agent37AgentPortEnv, computer: Agent37AgentPortComputer, principalId: string) {
  const existing = await env.PLATFORM_DB.prepare(`SELECT id FROM managed_service_owner_links
    WHERE tenant_id=? AND owner_type='user' AND owner_id=? AND agentport_principal_id=? AND status='active' LIMIT 1`)
    .bind(computer.tenant_id, computer.owner_id, principalId).first<{id:string}>();
  if (existing) return existing.id;
  const linkId = `msol_${(await digest(`${computer.tenant_id}:${computer.owner_id}:${principalId}`)).slice(0, 40)}`;
  const now = new Date().toISOString();
  await env.PLATFORM_DB.prepare(`INSERT OR IGNORE INTO managed_service_owner_links
    (id,tenant_id,owner_type,owner_id,agentport_principal_id,linked_by_user_id,consent_source,consented_at,status,created_at,updated_at)
    VALUES(?,?,'user',?,?,?,?,?,'active',?,?)`)
    .bind(linkId, computer.tenant_id, computer.owner_id, principalId, computer.owner_id,
      "agent37.computer_agentport_share", now, now, now).run();
  const linked = await env.PLATFORM_DB.prepare(`SELECT id FROM managed_service_owner_links
    WHERE tenant_id=? AND owner_type='user' AND owner_id=? AND agentport_principal_id=? AND status='active' LIMIT 1`)
    .bind(computer.tenant_id, computer.owner_id, principalId).first<{id:string}>();
  if (!linked) throw new Error("managed_service_owner_link_unavailable");
  return linked.id;
}

async function ensureService(env: Agent37AgentPortEnv, tenantId: string, serviceId: string) {
  const existing = await agentPort(env, tenantId, `/services/${encodeURIComponent(serviceId)}`, "GET", undefined, true);
  if (existing.response.status === 404) {
    const created = await agentPort(env, tenantId, "/services", "POST", {
      id: serviceId, name: "Agent37 customer-owned computer", type: "api", accountModels: ["agent_native"],
      capabilities: [...AGENT37_AGENTPORT_CAPABILITIES], events: [], connectionPurpose: "user_delegation",
      partnershipStatus: "unaffiliated", auth: { type: "provider_connection_reference" },
      billing: { payer: "connected_provider_account" }, provisioning: { mode: "customer_owned_reference", version: 1 },
    });
    if (!created.result.service) throw new Error("agentport_agent37_service_unavailable");
    return;
  }
  const service = existing.result.service as Record<string, unknown> | undefined;
  const actual = Array.isArray(service?.capabilities) ? [...service.capabilities].sort() : [];
  const accountModels = Array.isArray(service?.account_models) ? [...service.account_models].sort()
    : Array.isArray(service?.accountModels) ? [...service.accountModels].sort() : [];
  if (service?.id !== serviceId || service.status !== "active"
    || JSON.stringify(actual) !== JSON.stringify([...AGENT37_AGENTPORT_CAPABILITIES].sort())
    || JSON.stringify(accountModels) !== JSON.stringify(["agent_native"]))
    throw new Error("agentport_agent37_service_conflict");
}

export async function shareAgent37ComputerWithAgentPort(env: Agent37AgentPortEnv, computer: Agent37AgentPortComputer,
  idempotencyKey: string, capabilities: string[]) {
  if (!validId(idempotencyKey) || capabilities.length < 1 || capabilities.length > AGENT37_AGENTPORT_CAPABILITIES.length
    || capabilities.some((value) => !AGENT37_AGENTPORT_CAPABILITIES.includes(value as Agent37AgentPortCapability))
    || new Set(capabilities).size !== capabilities.length) throw new Error("agentport_share_selection_invalid");
  const selected = [...capabilities].sort() as Agent37AgentPortCapability[];
  const requestHash = await digest(JSON.stringify({ computerId: computer.id, connectionId: computer.connection_id, capabilities: selected }));
  const operationRow = await operation(env, computer, idempotencyKey, "share", requestHash);
  const current = await env.PLATFORM_DB.prepare(`SELECT id,status,capabilities_json,agentport_account_id FROM sandbox_agentport_shares
    WHERE tenant_id=? AND computer_id=? AND owner_id=?`)
    .bind(computer.tenant_id, computer.id, computer.owner_id)
    .first<{id:string;status:string;capabilities_json:string;agentport_account_id:string}>();
  if (operationRow.status === "complete" && current?.status === "active")
    return { shared: true, status: "active", capabilities: JSON.parse(current.capabilities_json) as string[], idempotent: true };
  if (current?.status === "revoking") throw new Error("agentport_share_revoke_in_progress");
  const pendingRevoke = current ? await env.PLATFORM_DB.prepare(`SELECT 1 AS pending FROM sandbox_agentport_operations
    WHERE tenant_id=? AND owner_id=? AND computer_id=? AND operation='revoke' AND status IN ('pending','unknown')
      AND json_extract(request_json,'$.agentportAccountId')=? LIMIT 1`)
    .bind(computer.tenant_id,computer.owner_id,computer.id,current.agentport_account_id).first<{pending:number}>() : null;
  if (pendingRevoke) throw new Error("agentport_share_revoke_reconciliation_required");
  if (current && ["pending", "unknown"].includes(current.status)) {
    const saved = JSON.parse(current.capabilities_json) as string[];
    if (JSON.stringify([...saved].sort()) !== JSON.stringify(selected)) {
      await markOperation(env, operationRow.id, computer.tenant_id, "unknown", "agentport_share_reconcile_or_revoke_required");
      throw new Error("agentport_share_reconcile_or_revoke_required");
    }
  }
  if (current?.status === "active") {
    const saved = JSON.parse(current.capabilities_json) as string[];
    if (JSON.stringify([...saved].sort()) !== JSON.stringify(selected)) {
      await markOperation(env, operationRow.id, computer.tenant_id, "unknown", "agentport_share_revoke_before_change");
      throw new Error("agentport_share_revoke_before_change");
    }
    await markOperation(env, operationRow.id, computer.tenant_id, "complete");
    return { shared: true, status: "active", capabilities: saved, idempotent: true };
  }

  const now = new Date().toISOString();
  const shareId = `ags_${(await digest(`${computer.tenant_id}:${computer.id}`)).slice(0, 40)}`;
  const serviceId = `agent37_v2_${(await digest(computer.tenant_id)).slice(0, 32)}`;
  let agentportAccountId = current?.agentport_account_id;
  try {
    const principalId = await ownerPrincipal(env, computer);
    const agentId = await assistantAgent(env, computer);
    const ownerLinkId = await ownerLink(env, computer, principalId);
    await ensureService(env, computer.tenant_id, serviceId);
    const externalAccountId = `agent37_resource_${(await digest(`${computer.tenant_id}:${computer.id}`)).slice(0, 40)}`;
    const registered = await agentPort(env, computer.tenant_id, "/accounts", "POST", {
      serviceId, accountModel: "agent_native", ownerType: "individual", ownerId: computer.owner_id,
      externalAccountId, credentialRef: `sandbox-connection:${shareId}`,
      metadata: { provider: "agent37", customerOwned: true, selectedCapabilities: selected },
    });
    const account = registered.result.account as Record<string, unknown> | undefined;
    if (typeof account?.id !== "string" || !validId(account.id)) throw new Error("agentport_agent37_account_unavailable");
    agentportAccountId = account.id;
    await env.PLATFORM_DB.prepare(`INSERT INTO sandbox_agentport_shares
      (id,tenant_id,owner_id,space_id,project_id,computer_id,connection_id,service_id,agentport_principal_id,agentport_agent_id,
       agentport_account_id,owner_link_id,capabilities_json,status,error_code,created_at,updated_at,revoked_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',NULL,?,?,NULL)
      ON CONFLICT(tenant_id,computer_id) DO UPDATE SET connection_id=excluded.connection_id,service_id=excluded.service_id,
        agentport_principal_id=excluded.agentport_principal_id,agentport_agent_id=excluded.agentport_agent_id,
        agentport_account_id=excluded.agentport_account_id,owner_link_id=excluded.owner_link_id,capabilities_json=excluded.capabilities_json,
        status='pending',error_code=NULL,updated_at=excluded.updated_at,revoked_at=NULL
      WHERE sandbox_agentport_shares.status IN ('revoked','pending','unknown')`)
      .bind(shareId, computer.tenant_id, computer.owner_id, computer.space_id, computer.project_id, computer.id, computer.connection_id,
        serviceId, principalId, agentId, agentportAccountId, ownerLinkId, JSON.stringify(selected), now, now).run();
    const mapping = await env.PLATFORM_DB.prepare(`SELECT status,connection_id,capabilities_json,agentport_agent_id,agentport_account_id
      FROM sandbox_agentport_shares WHERE tenant_id=? AND computer_id=? AND owner_id=?`)
      .bind(computer.tenant_id, computer.id, computer.owner_id)
      .first<{status:string;connection_id:string;capabilities_json:string;agentport_agent_id:string;agentport_account_id:string}>();
    if (!mapping || mapping.connection_id !== computer.connection_id || mapping.agentport_agent_id !== agentId
      || mapping.agentport_account_id !== agentportAccountId || JSON.stringify([...JSON.parse(mapping.capabilities_json) as string[]].sort()) !== JSON.stringify(selected))
      throw new Error("agentport_share_mapping_conflict");
    if (account.status === "pending") await agentPort(env, computer.tenant_id, `/accounts/${encodeURIComponent(agentportAccountId)}/activate`, "POST", {});
    else if (account.status === "revoked") await agentPort(env, computer.tenant_id, `/accounts/${encodeURIComponent(agentportAccountId)}/reactivate`, "POST", {});
    const grant = await agentPort(env, computer.tenant_id, `/accounts/${encodeURIComponent(agentportAccountId)}/grants`, "POST", {
      agentId, grantedBy: computer.owner_id, permissions: selected,
    });
    if (!grant.result.grant) throw new Error("agentport_agent37_grant_unavailable");
    const savedAt = new Date().toISOString();
    const saved = await env.PLATFORM_DB.prepare(`UPDATE sandbox_agentport_shares SET status='active',error_code=NULL,updated_at=?
      WHERE tenant_id=? AND computer_id=? AND owner_id=? AND connection_id=? AND agentport_account_id=? AND status='pending'`)
      .bind(savedAt, computer.tenant_id, computer.id, computer.owner_id, computer.connection_id, agentportAccountId).run();
    if (saved.meta.changes !== 1) throw new Error("agentport_share_persistence_failed");
    await markOperation(env, operationRow.id, computer.tenant_id, "complete");
    return { shared: true, status: "active", capabilities: selected, idempotent: registered.response.status !== 201 };
  } catch (error) {
    const message = error instanceof Error ? error.message : "agentport_share_unknown";
    const code = /^[a-z][a-z0-9_:-]{1,120}$/.test(message) ? message : "agentport_share_unknown";
    await env.PLATFORM_DB.prepare(`UPDATE sandbox_agentport_shares SET status='unknown',error_code=?,updated_at=? WHERE tenant_id=? AND computer_id=? AND status='pending'`)
      .bind(code, new Date().toISOString(), computer.tenant_id, computer.id).run().catch(() => undefined);
    await markOperation(env, operationRow.id, computer.tenant_id, "unknown", code).catch(() => undefined);
    throw error;
  }
}

export async function revokeAgent37ComputerAgentPortShare(env: Agent37AgentPortEnv, computer: Agent37AgentPortComputer, idempotencyKey: string) {
  if (!validId(idempotencyKey)) throw new Error("idempotency_key_required");
  const current = await env.PLATFORM_DB.prepare(`SELECT id,status,agentport_account_id FROM sandbox_agentport_shares
    WHERE tenant_id=? AND computer_id=? AND owner_id=?`)
    .bind(computer.tenant_id, computer.id, computer.owner_id)
    .first<{id:string;status:string;agentport_account_id:string}>();
  if (!current || current.status === "revoked") return { revoked: true, alreadyUnlinked: true };
  const requestHash = await digest(JSON.stringify({ computerId: computer.id, accountId: current.agentport_account_id }));
  const requestJson = JSON.stringify({ agentportAccountId: current.agentport_account_id });
  const activeRevocation = await env.PLATFORM_DB.prepare(`SELECT id FROM sandbox_agentport_operations
    WHERE tenant_id=? AND owner_id=? AND computer_id=? AND operation='revoke' AND status IN ('pending','unknown')
      AND idempotency_key<>? AND json_extract(request_json,'$.agentportAccountId')=? LIMIT 1`)
    .bind(computer.tenant_id,computer.owner_id,computer.id,idempotencyKey,current.agentport_account_id).first<{id:string}>();
  if(activeRevocation)return {revoked:false,pending:true,alreadyUnlinked:false};
  const operationRow = await operation(env, computer, idempotencyKey, "revoke", requestHash, requestJson);
  if (operationRow.status === "complete") return { revoked: true, alreadyUnlinked: false };
  const operationNow = new Date();
  if (operationRow.status === "pending" && operationRow.lease_until && operationRow.lease_until > operationNow.toISOString())
    return { revoked: false, pending: true, alreadyUnlinked: false };
  const now = new Date().toISOString();
  await env.PLATFORM_DB.prepare(`UPDATE sandbox_agentport_shares SET status='revoking',updated_at=? WHERE tenant_id=? AND computer_id=? AND owner_id=? AND status IN ('active','unknown','pending','revoking')`)
    .bind(now, computer.tenant_id, computer.id, computer.owner_id).run();
  const claimed = await env.PLATFORM_DB.prepare(`UPDATE sandbox_agentport_operations SET status='pending',lease_until=?,next_reconcile_at=NULL,
      error_code=NULL,updated_at=? WHERE id=? AND tenant_id=? AND status IN ('pending','unknown')`)
    .bind(new Date(operationNow.getTime() + 120_000).toISOString(), now, operationRow.id, computer.tenant_id).run();
  if (claimed.meta.changes !== 1) return { revoked: false, pending: true, alreadyUnlinked: false };
  try {
    const { result } = await agentPort(env, computer.tenant_id, `/accounts/${encodeURIComponent(current.agentport_account_id)}/revoke`, "POST", {});
    if (result.revoked !== true) throw new Error("agentport_revoke_unconfirmed");
    const at = new Date().toISOString();
    const updated = await env.PLATFORM_DB.prepare(`UPDATE sandbox_agentport_shares SET status='revoked',error_code=NULL,revoked_at=?,updated_at=?
      WHERE tenant_id=? AND computer_id=? AND owner_id=? AND agentport_account_id=? AND status='revoking'`)
      .bind(at, at, computer.tenant_id, computer.id, computer.owner_id, current.agentport_account_id).run();
    if (updated.meta.changes !== 1) throw new Error("agentport_revoke_persistence_failed");
    await markOperation(env, operationRow.id, computer.tenant_id, "complete");
    return { revoked: true, alreadyUnlinked: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : "agentport_revoke_unknown";
    const code = /^[a-z][a-z0-9_:-]{1,120}$/.test(message) ? message : "agentport_revoke_unknown";
    const failedAt = new Date();
    await env.PLATFORM_DB.prepare(`UPDATE sandbox_agentport_shares SET status='unknown',error_code=?,updated_at=? WHERE tenant_id=? AND computer_id=? AND agentport_account_id=?`)
      .bind(code, failedAt.toISOString(), computer.tenant_id, computer.id, current.agentport_account_id).run().catch(() => undefined);
    await markOperation(env, operationRow.id, computer.tenant_id, "unknown", code,
      new Date(failedAt.getTime() + 60_000).toISOString()).catch(() => undefined);
    throw error;
  }
}

export async function authorizeAgent37AgentPortAction(env: Agent37AgentPortEnv,
  input: { tenantId: string; ownerId: string; computerId: string; connectionId: string; agentId: string; capability: Agent37AgentPortCapability; operationKey: string }) {
  if (!validId(input.agentId) || !validId(input.operationKey)) throw new Error("agentport_agent_action_invalid");
  const row = await env.PLATFORM_DB.prepare(`SELECT id,connection_id,service_id,agentport_agent_id,agentport_account_id,capabilities_json,status
    FROM sandbox_agentport_shares WHERE tenant_id=? AND owner_id=? AND computer_id=? AND connection_id=?`)
    .bind(input.tenantId, input.ownerId, input.computerId, input.connectionId)
    .first<{id:string;connection_id:string;service_id:string;agentport_agent_id:string;agentport_account_id:string;capabilities_json:string;status:string}>();
  if (!row || row.status !== "active" || row.agentport_agent_id !== input.agentId || !row.capabilities_json
    || !(JSON.parse(row.capabilities_json) as string[]).includes(input.capability)) throw new Error("agentport_agent37_capability_not_granted");
  const idempotencyKey = `ag37act_${(await digest(`${row.id}:${input.agentId}:${input.capability}:${input.operationKey}`)).slice(0, 40)}`;
  const { result } = await agentPort(env, input.tenantId, `/accounts/${encodeURIComponent(row.agentport_account_id)}/actions/authorize`, "POST", {
    agentId: input.agentId, action: input.capability, resourceRef: row.id, idempotencyKey,
  });
  if (result.decision !== "allow") throw new Error("agentport_agent37_action_denied");
  return { shareId: row.id, connectionId: row.connection_id };
}
