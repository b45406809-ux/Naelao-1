import { mintInternalToken, readBoundedResponseJson } from "@naelao/http";

export interface UserPortRevocationEnv {
  PLATFORM_SECRET: string;
  PLATFORM_DB: D1Database;
  AGENTPORT_WORKER?: Fetcher;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

async function sha256(value: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function revokeAccount(env: UserPortRevocationEnv, tenantId: string, accountId: string) {
  if (!ID.test(accountId)) throw new Error("userport_agentport_account_invalid");
  if (!env.AGENTPORT_WORKER) throw new Error("agentport_worker_unavailable");
  const response = await env.AGENTPORT_WORKER.fetch(new Request(
    `https://agentport.internal/internal/agentport/accounts/${encodeURIComponent(accountId)}/revoke`,
    { method: "POST", headers: { "content-type": "application/json", "x-agentport-tenant-id": tenantId,
      "x-agentport-actor-role": "client_system", "x-agentport-actor-id": tenantId,
      "x-agentport-internal-token": await mintInternalToken(env.PLATFORM_SECRET, tenantId) }, body: "{}" },
  ));
  if (response.status === 404) return;
  const result = await readBoundedResponseJson<{ revoked?: unknown }>(response, 16 * 1024).catch(() => null);
  if (!response.ok || result?.revoked !== true) throw new Error("userport_agentport_revoke_unconfirmed");
}

/** Journal revocation before AgentPort egress; local authorization stays fail-closed until receipts arrive. */
export async function revokeUserPortAliasBinding(env: UserPortRevocationEnv, tenantId: string, spaceId: string, aliasId: string) {
  const pendingSync=await env.PLATFORM_DB.prepare(`SELECT operation_id,status FROM managed_service_operations
    WHERE tenant_id=? AND space_id=? AND operation_name='agentport_connector_sync'
      AND status IN ('pending','running','uncertain','held') AND json_extract(request_json,'$.aliasId')=? LIMIT 1`)
    .bind(tenantId,spaceId,aliasId).first<{operation_id:string;status:string}>();
  if (pendingSync?.status==="held") {
    const at=new Date().toISOString();
    await env.PLATFORM_DB.prepare(`UPDATE agentport_userport_connector_bindings SET status='sync_required',updated_at=?
      WHERE tenant_id=? AND space_id=? AND alias_id=? AND status='active'`).bind(at,tenantId,spaceId,aliasId).run();
    await env.PLATFORM_DB.prepare(`UPDATE managed_service_operations SET status='uncertain',error_code='userport_connector_cleanup_requested',
      lease_until=NULL,next_reconcile_at=?,updated_at=? WHERE operation_id=? AND tenant_id=? AND status='held'`)
      .bind(at,at,pendingSync.operation_id,tenantId).run();
    throw new Error("userport_agentport_sync_cleanup_pending");
  }
  if (pendingSync) throw new Error("userport_agentport_sync_pending");
  const binding = await env.PLATFORM_DB.prepare(`SELECT account_id,previous_account_id,service_id,provider,status FROM agentport_userport_connector_bindings
    WHERE tenant_id=? AND space_id=? AND alias_id=?`).bind(tenantId, spaceId, aliasId)
    .first<{account_id:string;previous_account_id:string|null;service_id:string;provider:string;status:string}>();
  if (!binding) return { revoked: true, alreadyUnlinked: true };
  if (!ID.test(tenantId) || !ID.test(spaceId) || !ID.test(aliasId)) throw new Error("userport_agentport_revoke_scope_invalid");
  if (binding.status === "pending") throw new Error("userport_agentport_sync_pending");
  const accountIds = [...new Set([binding.account_id, binding.previous_account_id].filter((id): id is string => !!id))].sort();
  const requestHash = await sha256(JSON.stringify({ tenantId, spaceId, aliasId, accountIds }));
  const operationId = `upc_revoke_${requestHash.slice(0, 40)}`;
  const at = new Date().toISOString();
  await env.PLATFORM_DB.prepare(`INSERT OR IGNORE INTO managed_service_operations(
      operation_id,tenant_id,space_id,provider,service_id,operation_name,idempotency_key,request_sha256,
      status,request_json,created_at,updated_at)
    VALUES(?,?,?,?,?,'agentport_connector_revoke',?,?,'pending',?,?,?)`)
    .bind(operationId, tenantId, spaceId, binding.provider, binding.service_id, operationId, requestHash,
      JSON.stringify({ aliasId, accountIds }), at, at).run();
  const operation = await env.PLATFORM_DB.prepare(`SELECT request_sha256,status,lease_until FROM managed_service_operations
    WHERE operation_id=? AND tenant_id=?`).bind(operationId, tenantId)
    .first<{request_sha256:string;status:string;lease_until:string|null}>();
  if (!operation || operation.request_sha256 !== requestHash) throw new Error("userport_agentport_revoke_operation_conflict");

  if (operation.status === "complete") {
    await env.PLATFORM_DB.prepare(`UPDATE agentport_userport_connector_bindings SET status='revoked',
      revoked_at=COALESCE(revoked_at,?),updated_at=?
      WHERE tenant_id=? AND space_id=? AND alias_id=? AND account_id=?`)
      .bind(at, at, tenantId, spaceId, aliasId, binding.account_id).run();
    return { revoked: true, alreadyUnlinked: false, idempotent: true };
  }

  await env.PLATFORM_DB.prepare(`UPDATE agentport_userport_connector_bindings SET status='sync_required',
    previous_account_id=COALESCE(previous_account_id,?),updated_at=?
    WHERE tenant_id=? AND space_id=? AND alias_id=? AND account_id=?`)
    .bind(binding.account_id, at, tenantId, spaceId, aliasId, binding.account_id).run();
  const claimed = await env.PLATFORM_DB.prepare(`UPDATE managed_service_operations SET status='running',lease_until=?,
      error_code=NULL,updated_at=? WHERE operation_id=? AND tenant_id=?
      AND (status IN ('pending','held','uncertain') OR (status='running' AND (lease_until IS NULL OR lease_until<=?)))`)
    .bind(new Date(Date.now() + 120_000).toISOString(), at, operationId, tenantId, at).run();
  if (!claimed.meta.changes) throw new Error("userport_agentport_revoke_pending");

  try {
    for (const accountId of accountIds) await revokeAccount(env, tenantId, accountId);
    const completedAt = new Date().toISOString();
    await env.PLATFORM_DB.prepare(`UPDATE agentport_userport_connector_bindings SET status='revoked',
      revoked_at=COALESCE(revoked_at,?),updated_at=?
      WHERE tenant_id=? AND space_id=? AND alias_id=? AND account_id=?`)
      .bind(completedAt, completedAt, tenantId, spaceId, aliasId, binding.account_id).run();
    await env.PLATFORM_DB.prepare(`UPDATE managed_service_operations SET status='complete',error_code=NULL,
      lease_until=NULL,next_reconcile_at=NULL,updated_at=? WHERE operation_id=? AND tenant_id=?`)
      .bind(completedAt, operationId, tenantId).run();
    return { revoked: true, alreadyUnlinked: false, idempotent: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : "userport_agentport_revoke_uncertain";
    const errorCode = /^[a-z][a-z0-9_:-]{1,120}$/.test(message) ? message : "userport_agentport_revoke_uncertain";
    await env.PLATFORM_DB.prepare(`UPDATE managed_service_operations SET status='uncertain',error_code=?,
      lease_until=NULL,next_reconcile_at=?,updated_at=? WHERE operation_id=? AND tenant_id=?`)
      .bind(errorCode, new Date(Date.now() + 60_000).toISOString(), new Date().toISOString(), operationId, tenantId).run().catch(() => undefined);
    throw error;
  }
}
