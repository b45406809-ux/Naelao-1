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
      scope.tenantId, scope.tenantId, input.region, JSON.stringify({ mode: "naelao_managed", registeredBy: "resource-provision" }), at, at,
      offering?.category ?? null, offering?.resource_type ?? input.resource.resource_type, input.offeringId,
      input.displayName ?? input.resource.address ?? null, subscription?.id ?? null).run();
  const stored = await db.prepare("SELECT tenant_id,agentport_account_id FROM managed_service_accounts WHERE id=?").bind(resourceId).first<{ tenant_id: string; agentport_account_id: string | null }>();
  if (!stored || stored.tenant_id !== scope.tenantId) throw new Error("managed_resource_registration_conflict");
  if (stored.agentport_account_id) return { resourceId, agentPortAccountId: stored.agentport_account_id };

  try {
    const commScope = { tenantId: scope.tenantId, spaceId: scope.spaceId, userId: scope.userId, role: scope.role, ...(scope.projectId ? { projectId: scope.projectId } : {}) } as CommunicationScope;
    const agentId = await ensureAgentPortAssistantIdentity(env, commScope);
    const serviceId = `${input.provider}-${input.serviceId}:${scope.tenantId}`;
    await agentPort(env, scope.tenantId, "/services", "POST", {
      id: serviceId, name: "Naelao Email", type: "managed", accountModels: ["agent_native"], capabilities: EMAIL_CAPABILITIES,
      events: [], connectionPurpose: "agent_resource", auth: { type: "api_key" }, provisioning: { mode: "approval_required" },
    });
    const identity = (await agentPort(env, scope.tenantId, `/agents/${encodeURIComponent(agentId)}/identity`)).identity as { principal?: { id?: unknown } } | undefined;
    const principalId = identity?.principal?.id;
    if (typeof principalId !== "string") throw new Error("agentport_principal_link_unavailable");
    const ownerLinkId = await ensureManagedServiceOwnerLink(env, commScope, { ownerType: "organization", ownerId: scope.tenantId, principalId, consentSource: "managed_resource_provision" });
    const account = (await agentPort(env, scope.tenantId, "/accounts", "POST", {
      serviceId, accountModel: "agent_native", ownerType: "organization", ownerId: scope.tenantId, externalAccountId: ref, credentialRef: resourceId,
      metadata: { provider: input.provider, connectionMode: "naelao_managed", resourceId },
    })).account as { id?: unknown; status?: unknown } | undefined;
    if (typeof account?.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(account.id)) throw new Error("agentport_account_link_unavailable");
    if (account.status === "pending") await agentPort(env, scope.tenantId, `/accounts/${encodeURIComponent(account.id)}/activate`, "POST", {});
    else if (account.status === "revoked") await agentPort(env, scope.tenantId, `/accounts/${encodeURIComponent(account.id)}/reactivate`, "POST", {});
    const saved = await db.prepare(`UPDATE managed_service_accounts SET agentport_principal_id=?,agentport_agent_id=?,agentport_account_id=?,owner_link_id=?,
        agentport_link_status='active',updated_at=? WHERE id=? AND tenant_id=?`)
      .bind(principalId, agentId, account.id, ownerLinkId, new Date().toISOString(), resourceId, scope.tenantId).run();
    if (saved.meta.changes !== 1) throw new Error("managed_resource_link_persistence_failed");
    return { resourceId, agentPortAccountId: account.id };
  } catch {
    return { resourceId, agentPortAccountId: null };
  }
}
