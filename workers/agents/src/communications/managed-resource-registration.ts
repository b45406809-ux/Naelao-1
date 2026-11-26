// MS-47 item 1: a Managed resource created by the MS-43 provision flow is registered in `managed_service_accounts` and linked to an
// AgentPort account, so the MS-44 owner and template grants apply instead of being deferred. Runs after the adapter has created the
// provider resource, behind MANAGED_RESOURCES_PANEL_ENABLED (the only caller is the resource-provision action).
//
// - The row id derives from (provider, provider_resource_ref), so a replay updates the same row and never adds a second one.
// - Registration is best effort after the provider call: the provider resource already exists and is billed, so a failure here is
//   reported to the caller as "not linked" (grants stay deferred) and never turns a created resource into a failed provision.
// - No grant is made here. Only the owner-approved MS-44 `resource-grant` path grants an agent anything.
import { mintInternalToken, readBoundedResponseJson } from "@naelao/http";
import type { AgentsEnv } from "../index.js";
import { ensureAgentPortAssistantIdentity, type CommunicationScope } from "./core.js";
import { ensureManagedServiceOwnerLink } from "./managed-service-ownership.js";
import type { ProviderResource } from "./providers/contract.js";

const EMAIL_CAPABILITIES = ["email.read", "email.send", "email.search", "email.threads", "email.attachments", "channels.manage", "messages.read", "messages.send"];

async function sha256Hex(value: string) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function agentPort(env: AgentsEnv, tenantId: string, path: string, method = "GET", body?: unknown) {
  const response = await env.AGENTPORT_WORKER.fetch(new Request(`https://agentport.internal/internal/agentport${path}`, {
    method,
    headers: {
      "content-type": "application/json", "x-agentport-tenant-id": tenantId, "x-agentport-actor-role": "client_system",
      "x-agentport-actor-id": tenantId, "x-agentport-internal-token": await mintInternalToken(env.PLATFORM_SECRET, tenantId),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  const result = await readBoundedResponseJson<Record<string, unknown>>(response, 64 * 1024).catch(() => ({} as Record<string, unknown>));
  // 409 is a replay of a registration that already exists.
  if (!response.ok && response.status !== 409) throw new Error(`agentport_${String(result.error_code ?? "request_failed")}`);
  return result;
}

export interface RegisterProvisionedResourceInput {
  provider: string;
  serviceId: string;
  capabilityVersion: number | null;
  offeringId: string;
  resource: ProviderResource;
  region: string;
  displayName?: string | null;
  now?: Date;
}

export interface RegisteredResource { resourceId: string; agentPortAccountId: string | null }

/** Registers the resource row. Returns its id; `agentPortAccountId` is null when the AgentPort link could not be completed. */
export async function registerProvisionedResource(
  env: AgentsEnv,
  scope: Pick<CommunicationScope, "tenantId" | "spaceId" | "projectId" | "userId" | "role">,
  input: RegisterProvisionedResourceInput,
): Promise<RegisteredResource> {
  const db = env.PLATFORM_DB;
  const ref = input.resource.provider_resource_ref;
  const resourceId = `msa_${(await sha256Hex(`${input.provider}:${ref}`)).slice(0, 40)}`;
  const at = (input.now ?? new Date()).toISOString();
  const offering = await db.prepare("SELECT category,resource_type FROM managed_service_offerings WHERE id=?").bind(input.offeringId).first<{ category: string | null; resource_type: string | null }>();
  const subscription = await db.prepare("SELECT id FROM managed_service_subscriptions WHERE tenant_id=? AND resource_id=? ORDER BY created_at DESC LIMIT 1")
    .bind(scope.tenantId, ref).first<{ id: string }>().catch(() => null);
  await db.prepare(`INSERT OR IGNORE INTO managed_service_accounts(
      id,tenant_id,space_id,project_id,provider,service_id,capability_version,connection_mode,provider_resource_ref,credential_ref,
      owner_type,owner_id,provider_payer_type,provider_payer_id,credit_payer_type,credit_payer_id,region,lifecycle_state,metadata_json,created_at,updated_at,
      category,resource_type,offering_id,access_mode,provisioning_strategy,display_name,subscription_id)
    VALUES(?,?,?,?,?,?,?,'naelao_managed',?,?,'organization',?,'platform','naelao','organization',?,?,'active',?,?,?,?,?,?,'managed','first_party',?,?)`)
    .bind(resourceId, scope.tenantId, scope.spaceId, scope.projectId ?? null, input.provider, input.serviceId, input.capabilityVersion, ref, resourceId,
      scope.tenantId, scope.tenantId, input.region, JSON.stringify({ mode: "naelao_managed", registeredBy: "resource-provision", registeredByUserId: scope.userId }), at, at,
      offering?.category ?? null, offering?.resource_type ?? input.resource.resource_type, input.offeringId,
      input.displayName ?? input.resource.address ?? null, subscription?.id ?? null).run();
  const stored = await db.prepare("SELECT tenant_id,agentport_account_id FROM managed_service_accounts WHERE id=?").bind(resourceId).first<{ tenant_id: string; agentport_account_id: string | null }>();
  if (!stored || stored.tenant_id !== scope.tenantId) throw new Error("managed_resource_registration_conflict");
  if (stored.agentport_account_id) return { resourceId, agentPortAccountId: stored.agentport_account_id };

  const commScope = { tenantId: scope.tenantId, spaceId: scope.spaceId, userId: scope.userId, role: scope.role, ...(scope.projectId ? { projectId: scope.projectId } : {}) } as CommunicationScope;
  const linked = await linkResourceToAgentPort(env, commScope, { resourceId, provider: input.provider, serviceId: input.serviceId, ref });
  return { resourceId, agentPortAccountId: linked };
}

/**
 * Creates (or reuses) the AgentPort service, principal link and account for a registered resource and records the link on its row.
 * Idempotent: AgentPort answers 409 for an existing registration and the row update only fills a missing link. Returns the AgentPort
 * account id, or null when any step failed (nothing is thrown; the caller retries later). Makes no grant.
 */
async function linkResourceToAgentPort(
  env: AgentsEnv, commScope: CommunicationScope, row: { resourceId: string; provider: string; serviceId: string; ref: string },
): Promise<string | null> {
  const db = env.PLATFORM_DB;
  const { resourceId, ref } = row;
  const tenantId = commScope.tenantId;
  try {
    const agentId = await ensureAgentPortAssistantIdentity(env, commScope);
    const serviceId = `${row.provider}-${row.serviceId}:${tenantId}`;
    await agentPort(env, tenantId, "/services", "POST", {
      id: serviceId, name: "Naelao Email", type: "managed", accountModels: ["agent_native"], capabilities: EMAIL_CAPABILITIES,
      events: [], connectionPurpose: "agent_resource", auth: { type: "api_key" }, provisioning: { mode: "approval_required" },
    });
    const identity = (await agentPort(env, tenantId, `/agents/${encodeURIComponent(agentId)}/identity`)).identity as { principal?: { id?: unknown } } | undefined;
    const principalId = identity?.principal?.id;
    if (typeof principalId !== "string") throw new Error("agentport_principal_link_unavailable");
    const ownerLinkId = await ensureManagedServiceOwnerLink(env, commScope, { ownerType: "organization", ownerId: tenantId, principalId, consentSource: "managed_resource_provision" });
    const account = (await agentPort(env, tenantId, "/accounts", "POST", {
      serviceId, accountModel: "agent_native", ownerType: "organization", ownerId: tenantId, externalAccountId: ref, credentialRef: resourceId,
      metadata: { provider: row.provider, connectionMode: "naelao_managed", resourceId },
    })).account as { id?: unknown; status?: unknown } | undefined;
    if (typeof account?.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(account.id)) throw new Error("agentport_account_link_unavailable");
    if (account.status === "pending") await agentPort(env, tenantId, `/accounts/${encodeURIComponent(account.id)}/activate`, "POST", {});
    else if (account.status === "revoked") await agentPort(env, tenantId, `/accounts/${encodeURIComponent(account.id)}/reactivate`, "POST", {});
    const saved = await db.prepare(`UPDATE managed_service_accounts SET agentport_principal_id=?,agentport_agent_id=?,agentport_account_id=?,owner_link_id=?,
        agentport_link_status='active',updated_at=? WHERE id=? AND tenant_id=? AND agentport_account_id IS NULL`)
      .bind(principalId, agentId, account.id, ownerLinkId, new Date().toISOString(), resourceId, tenantId).run();
    if (saved.meta.changes !== 1) throw new Error("managed_resource_link_persistence_failed");
    return account.id;
  } catch {
    return null;
  }
}

export const AGENTPORT_LINK_RETRY_BATCH = 10;
export const AGENTPORT_LINK_RETRY_MIN_AGE_MS = 5 * 60_000;
export interface AgentPortLinkSweepResult { checked: number; linked: number; failed: number; skipped: number }

/**
 * MS-48: retry for MS-47 item 1. Links an AgentPort account for Managed resources registered by `resource-provision` whose first
 * link failed (`agentPortLinked:false`), so owner and template grants that were deferred can apply. Behind MANAGED_RESOURCES_PANEL_ENABLED
 * (flag off: no query, no call). Bounded per sweep, skips rows touched in the last five minutes (each attempt rotates `updated_at`),
 * idempotent, never grants anything, and only touches rows that are active or owner/billing suspended Naelao-managed resources.
 */
export async function sweepManagedResourceAgentPortLinks(env: AgentsEnv, now = new Date(), limit = AGENTPORT_LINK_RETRY_BATCH): Promise<AgentPortLinkSweepResult | null> {
  if (env.MANAGED_RESOURCES_PANEL_ENABLED !== "true" || !env.AGENTPORT_WORKER) return null;
  const db = env.PLATFORM_DB;
  const rows = await db.prepare(`SELECT a.id,a.tenant_id,a.space_id,a.project_id,a.provider,a.service_id,a.provider_resource_ref,a.metadata_json,s.notify_user_id
    FROM managed_service_accounts a LEFT JOIN managed_service_subscriptions s ON s.id=a.subscription_id AND s.tenant_id=a.tenant_id
    WHERE a.connection_mode='naelao_managed' AND a.access_mode='managed' AND a.provisioning_strategy='first_party'
      AND a.lifecycle_state IN ('active','suspended') AND a.agentport_account_id IS NULL
      AND json_extract(a.metadata_json,'$.registeredBy')='resource-provision' AND a.updated_at<=?
    ORDER BY a.updated_at,a.id LIMIT ?`)
    .bind(new Date(now.getTime() - AGENTPORT_LINK_RETRY_MIN_AGE_MS).toISOString(), Math.min(Math.max(limit, 1), AGENTPORT_LINK_RETRY_BATCH))
    .all<{ id: string; tenant_id: string; space_id: string; project_id: string | null; provider: string; service_id: string; provider_resource_ref: string; metadata_json: string | null; notify_user_id: string | null }>();
  const result: AgentPortLinkSweepResult = { checked: rows.results.length, linked: 0, failed: 0, skipped: 0 };
  for (const row of rows.results) {
    let registeredBy: unknown;
    try { registeredBy = (JSON.parse(row.metadata_json ?? "{}") as { registeredByUserId?: unknown }).registeredByUserId; } catch { registeredBy = undefined; }
    const userId = typeof registeredBy === "string" && registeredBy ? registeredBy : row.notify_user_id;
    if (!userId || !row.space_id) { result.skipped++; continue; }
    // Rotate first so a persistently failing row does not starve the others behind it.
    await db.prepare("UPDATE managed_service_accounts SET updated_at=? WHERE id=? AND tenant_id=? AND agentport_account_id IS NULL").bind(now.toISOString(), row.id, row.tenant_id).run();
    const commScope = { tenantId: row.tenant_id, spaceId: row.space_id, userId, role: "owner", ...(row.project_id ? { projectId: row.project_id } : {}) } as CommunicationScope;
    const linked = await linkResourceToAgentPort(env, commScope, { resourceId: row.id, provider: row.provider, serviceId: row.service_id, ref: row.provider_resource_ref });
    if (linked) result.linked++; else result.failed++;
  }
  return result;
}
