import type { AgentsEnv } from "../index.js";
import type { CommunicationScope } from "./core.js";

const id = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

export async function ensureManagedServiceOwnerLink(
  env: AgentsEnv,
  scope: CommunicationScope,
  input: { ownerType: "user" | "organization"; ownerId: string; principalId: string; consentSource: string },
) {
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(input.ownerId) || !/^[A-Za-z0-9._:-]{1,160}$/.test(input.principalId)
    || !/^[a-z][a-z0-9._:-]{1,100}$/.test(input.consentSource)
    || (input.ownerType === "user" && input.ownerId !== scope.userId)
    || (input.ownerType === "organization" && input.ownerId !== scope.tenantId)) {
    throw new Error("managed_service_owner_link_invalid");
  }
  const at = new Date().toISOString();
  await env.PLATFORM_DB.prepare("UPDATE managed_service_owner_links SET status='revoked',revoked_at=COALESCE(revoked_at,?),updated_at=? WHERE tenant_id=? AND owner_type=? AND owner_id=? AND status='active' AND revoked_at IS NOT NULL")
    .bind(at,at,scope.tenantId,input.ownerType,input.ownerId).run();
  const existing = await env.PLATFORM_DB.prepare(`SELECT id,status,agentport_principal_id FROM managed_service_owner_links
    WHERE tenant_id=? AND owner_type=? AND owner_id=? AND agentport_principal_id=? AND status='active' LIMIT 1`)
    .bind(scope.tenantId,input.ownerType,input.ownerId,input.principalId)
    .first<{id:string;status:string;agentport_principal_id:string}>();
  if (existing) return existing.id;
  const linkId = id("msol");
  await env.PLATFORM_DB.prepare(`INSERT OR IGNORE INTO managed_service_owner_links(
    id,tenant_id,owner_type,owner_id,agentport_principal_id,linked_by_user_id,consent_source,consented_at,status,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,'active',?,?)`)
    .bind(linkId,scope.tenantId,input.ownerType,input.ownerId,input.principalId,scope.userId,input.consentSource,at,at,at).run();
  const linked = await env.PLATFORM_DB.prepare(`SELECT id,status,agentport_principal_id FROM managed_service_owner_links
    WHERE tenant_id=? AND owner_type=? AND owner_id=? AND agentport_principal_id=? AND status='active' LIMIT 1`)
    .bind(scope.tenantId,input.ownerType,input.ownerId,input.principalId)
    .first<{id:string;status:string;agentport_principal_id:string}>();
  if (!linked || linked.agentport_principal_id !== input.principalId) throw new Error("managed_service_owner_link_unavailable");
  return linked.id;
}

/** Record the owner-authorized service charge and renewal scope before first provider dispatch. */
export async function ensureOrganizationPayerMandate(
  env: AgentsEnv,
  scope: CommunicationScope,
  input: { mandateKey: string; provider: string; serviceId: string; operationName?: string; maxCreditsPerOperation: number; allowRenewal: boolean;
    agentPortAgentId?: string; maxCreditsPerPeriod?: number; periodDays?: number },
) {
  const operationName = input.operationName ?? "provision";
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(input.mandateKey) || !/^[a-z][a-z0-9_-]{1,63}$/.test(input.provider)
    || !/^[a-z][a-z0-9_.:-]{1,128}$/.test(input.serviceId) || !Number.isSafeInteger(input.maxCreditsPerOperation)
    || !/^[a-z][a-z0-9_.:-]{1,128}$/.test(operationName)
    || input.maxCreditsPerOperation < 1 || input.maxCreditsPerOperation > 10_000_000
    || (input.agentPortAgentId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(input.agentPortAgentId))
    || (input.maxCreditsPerPeriod !== undefined && (!Number.isSafeInteger(input.maxCreditsPerPeriod) || input.maxCreditsPerPeriod < input.maxCreditsPerOperation || input.maxCreditsPerPeriod > 10_000_000))
    || (input.periodDays !== undefined && (!Number.isInteger(input.periodDays) || input.periodDays < 1 || input.periodDays > 366))
    || (input.agentPortAgentId !== undefined && (input.maxCreditsPerPeriod === undefined || input.periodDays === undefined))) {
    throw new Error("managed_service_payer_mandate_invalid");
  }
  const scopes = [`${input.provider}:${input.serviceId}:${operationName}`, ...(input.allowRenewal ? [`${input.provider}:${input.serviceId}:renew`] : [])];
  const scopesJson = JSON.stringify(scopes);
  const at = new Date().toISOString();
  await env.PLATFORM_DB.prepare(`UPDATE managed_service_payer_mandates SET status='expired',updated_at=?
    WHERE tenant_id=? AND payer_type='organization' AND payer_id=? AND mandate_key=? AND status='active' AND expires_at IS NOT NULL AND expires_at<=?`)
    .bind(at,scope.tenantId,scope.tenantId,input.mandateKey,at).run();
  const existing = await env.PLATFORM_DB.prepare(`SELECT id,operation_scopes_json,max_credits_per_operation,auto_renew,expires_at,agentport_agent_id,max_credits_per_period,period_days
    FROM managed_service_payer_mandates WHERE tenant_id=? AND payer_type='organization' AND payer_id=? AND mandate_key=? AND status='active' LIMIT 1`)
    .bind(scope.tenantId,scope.tenantId,input.mandateKey)
    .first<{id:string;operation_scopes_json:string;max_credits_per_operation:number;auto_renew:number;expires_at:string|null;agentport_agent_id:string|null;max_credits_per_period:number|null;period_days:number}>();
  if (existing) {
    let existingScopes: unknown;
    try { existingScopes = JSON.parse(existing.operation_scopes_json); } catch { throw new Error("managed_service_payer_mandate_invalid"); }
    if (!Array.isArray(existingScopes) || scopes.some((item) => !existingScopes.includes(item))
      || existing.max_credits_per_operation < input.maxCreditsPerOperation
      || (input.allowRenewal && existing.auto_renew !== 1)
      || existing.agentport_agent_id !== (input.agentPortAgentId ?? null)
      || (input.maxCreditsPerPeriod !== undefined && (existing.max_credits_per_period === null || existing.max_credits_per_period < input.maxCreditsPerPeriod))
      || (input.periodDays !== undefined && existing.period_days !== input.periodDays)) {
      throw new Error("managed_service_payer_mandate_conflict");
    }
    return existing.id;
  }
  const mandateId = id("mspm");
  await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare(`INSERT OR IGNORE INTO managed_service_payer_mandates(
      id,tenant_id,payer_type,payer_id,mandate_key,authorized_by_user_id,operation_scopes_json,
      max_credits_per_operation,auto_renew,status,created_at,updated_at,agentport_agent_id,max_credits_per_period,period_days)
      VALUES(?,?,'organization',?,?,?,?,?,?,'active',?,?,?,?,?)`)
      .bind(mandateId,scope.tenantId,scope.tenantId,input.mandateKey,scope.userId,scopesJson,input.maxCreditsPerOperation,input.allowRenewal?1:0,at,at,
        input.agentPortAgentId ?? null,input.maxCreditsPerPeriod ?? null,input.periodDays ?? 30),
    env.PLATFORM_DB.prepare(`INSERT INTO managed_service_payer_mandate_audit(id,mandate_id,action,actor_user_id,reason,created_at)
      SELECT ?,?,'authorized',?,?,? WHERE EXISTS(SELECT 1 FROM managed_service_payer_mandates WHERE id=? AND status='active')`)
      .bind(id("mspma"),mandateId,scope.userId,`Authorized during explicit managed ${input.provider} ${input.serviceId} ${operationName} request.`,at,mandateId),
  ]);
  const created = await env.PLATFORM_DB.prepare(`SELECT id,operation_scopes_json,max_credits_per_operation,auto_renew,agentport_agent_id,max_credits_per_period,period_days
    FROM managed_service_payer_mandates WHERE tenant_id=? AND payer_type='organization' AND payer_id=? AND mandate_key=? AND status='active' LIMIT 1`)
    .bind(scope.tenantId,scope.tenantId,input.mandateKey)
    .first<{id:string;operation_scopes_json:string;max_credits_per_operation:number;auto_renew:number;agentport_agent_id:string|null;max_credits_per_period:number|null;period_days:number}>();
  if (!created || created.max_credits_per_operation < input.maxCreditsPerOperation || created.auto_renew !== (input.allowRenewal?1:0)
    || created.agentport_agent_id !== (input.agentPortAgentId ?? null)
    || (input.maxCreditsPerPeriod !== undefined && (created.max_credits_per_period === null || created.max_credits_per_period < input.maxCreditsPerPeriod))
    || (input.periodDays !== undefined && created.period_days !== input.periodDays)) {
    throw new Error("managed_service_payer_mandate_conflict");
  }
  return created.id;
}

export async function revokeOrganizationPayerMandate(
  env: AgentsEnv,
  scope: CommunicationScope,
  mandateKey: string,
  reason: string,
) {
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(mandateKey) || reason.trim().length < 3 || reason.length > 300) {
    throw new Error("managed_service_payer_mandate_invalid");
  }
  const prior = await env.PLATFORM_DB.prepare(`SELECT id FROM managed_service_payer_mandates
    WHERE tenant_id=? AND payer_type='organization' AND payer_id=? AND mandate_key=? AND status='active' LIMIT 1`)
    .bind(scope.tenantId,scope.tenantId,mandateKey).first<{id:string}>();
  if (!prior) return { revoked: false, deduplicated: true };
  const at = new Date().toISOString();
  const results = await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare(`UPDATE managed_service_payer_mandates SET status='revoked',revoked_by_user_id=?,revoked_at=?,updated_at=?
      WHERE id=? AND tenant_id=? AND status='active'`).bind(scope.userId,at,at,prior.id,scope.tenantId),
    env.PLATFORM_DB.prepare(`INSERT INTO managed_service_payer_mandate_audit(id,mandate_id,action,actor_user_id,reason,created_at)
      SELECT ?,?,'revoked',?,?,? WHERE EXISTS(SELECT 1 FROM managed_service_payer_mandates WHERE id=? AND status='revoked' AND revoked_by_user_id=? AND revoked_at=?)`)
      .bind(id("mspma"),prior.id,scope.userId,reason.trim(),at,prior.id,scope.userId,at),
  ]);
  if (!results[0]?.meta.changes || !results[1]?.meta.changes) throw new Error("managed_service_payer_mandate_revoke_conflict");
  return { revoked: true, mandateId: prior.id };
}
