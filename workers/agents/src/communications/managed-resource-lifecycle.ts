// MS-47 items 2 and 3: owner suspend/resume of a Managed resource and subscription reactivation, behind MANAGED_RESOURCES_PANEL_ENABLED
// (item 3 also needs MANAGED_SUBSCRIPTIONS_ENABLED and MANAGED_OFFERINGS_ENABLED, like the rest of the subscription flow).
//
// Owner suspend pauses sending (adapter, `owner_suspended` tag) and marks the registry row `suspended` with metadata `suspended_by: owner`.
// It does not stop billing: the inbox still exists, so its rental continues. Resume lifts only the owner's pause, and is refused while the
// subscription itself is suspended for non-payment (that needs reactivation, which charges first). Authorization (owner/admin, not-found
// shape) is the route's job. Provider refs, strategies and credential refs are never returned.
import type { AgentsEnv } from "../index.js";
import type { CommunicationScope } from "./core.js";
import { NAELAO_EMAIL_SUBSCRIPTION_TYPE, createNaelaoEmailSubscriptionHandler } from "./managed-email-billing.js";
import { managedSubscriptionsEnabled, reactivateManagedSubscription } from "./managed-subscriptions.js";
import { NAELAO_EMAIL_PROVIDER, NAELAO_EMAIL_SERVICE_ID, createNaelaoEmailAdapter, type NaelaoEmailAdapter } from "./providers/naelao-email.js";

export type ResourceLifecycleErrorCode =
  | "bad_request" | "resource_not_found" | "capability_unsupported" | "invalid_state" | "subscription_suspended" | "provider_unavailable"
  | "charge_failed" | "reactivation_in_progress";
const STATUS: Record<ResourceLifecycleErrorCode, number> = {
  bad_request: 400, resource_not_found: 404, capability_unsupported: 501, invalid_state: 409, subscription_suspended: 409, provider_unavailable: 503,
  charge_failed: 402, reactivation_in_progress: 409,
};
export class ResourceLifecycleError extends Error {
  constructor(readonly code: ResourceLifecycleErrorCode) { super(code); this.name = "ResourceLifecycleError"; }
  get status() { return STATUS[this.code]; }
}

export type PauseAdapter = Pick<NaelaoEmailAdapter, "setSendingPaused">;
export type ReactivationAdapter = Pick<NaelaoEmailAdapter, "usageForPeriod" | "lookup" | "setSendingPaused">;
const ID = /^[A-Za-z0-9._:-]{1,200}$/;

interface Row { id: string; provider: string; service_id: string; provider_resource_ref: string; lifecycle_state: string; metadata_json: string | null }

async function load(env: AgentsEnv, scope: Pick<CommunicationScope, "tenantId" | "spaceId">, resourceId: string): Promise<Row> {
  if (typeof resourceId !== "string" || !ID.test(resourceId)) throw new ResourceLifecycleError("bad_request");
  const row = await env.PLATFORM_DB.prepare(`SELECT id,provider,service_id,provider_resource_ref,lifecycle_state,metadata_json FROM managed_service_accounts
    WHERE id=? AND tenant_id=? AND space_id=? AND access_mode='managed' AND lifecycle_state NOT IN ('revoked','retired')`)
    .bind(resourceId, scope.tenantId, scope.spaceId).first<Row>();
  if (!row) throw new ResourceLifecycleError("resource_not_found");
  // Only the Naelao Email adapter can pause a resource today; every other Managed resource answers capability_unsupported (no fake success).
  if (row.provider !== NAELAO_EMAIL_PROVIDER || row.service_id !== NAELAO_EMAIL_SERVICE_ID) throw new ResourceLifecycleError("capability_unsupported");
  return row;
}

const suspendedBy = (row: Row) => { try { return (JSON.parse(row.metadata_json ?? "{}") as { suspended_by?: unknown }).suspended_by; } catch { return undefined; } };

async function pause(adapter: PauseAdapter, tenantId: string, ref: string, paused: boolean) {
  try { await adapter.setSendingPaused({ tenantId, provider_resource_ref: ref, paused, reason: "owner_suspended" }); }
  catch { throw new ResourceLifecycleError("provider_unavailable"); }
}

export async function suspendManagedResource(
  env: AgentsEnv, scope: Pick<CommunicationScope, "tenantId" | "spaceId">, resourceId: string, adapter: PauseAdapter = createNaelaoEmailAdapter(env),
): Promise<{ resourceId: string; status: "suspended" }> {
  const row = await load(env, scope, resourceId);
  if (row.lifecycle_state === "suspended" && suspendedBy(row) === "owner") return { resourceId, status: "suspended" };
  if (row.lifecycle_state !== "active") throw new ResourceLifecycleError("invalid_state");
  await pause(adapter, scope.tenantId, row.provider_resource_ref, true);
  await env.PLATFORM_DB.prepare(`UPDATE managed_service_accounts SET lifecycle_state='suspended',metadata_json=json_set(COALESCE(metadata_json,'{}'),'$.suspended_by','owner'),
      row_version=row_version+1,updated_at=? WHERE id=? AND tenant_id=? AND lifecycle_state='active'`)
    .bind(new Date().toISOString(), resourceId, scope.tenantId).run();
  return { resourceId, status: "suspended" };
}

export async function resumeManagedResource(
  env: AgentsEnv, scope: Pick<CommunicationScope, "tenantId" | "spaceId">, resourceId: string, adapter: PauseAdapter = createNaelaoEmailAdapter(env),
): Promise<{ resourceId: string; status: "active" }> {
  const row = await load(env, scope, resourceId);
  if (row.lifecycle_state === "active") return { resourceId, status: "active" };
  if (row.lifecycle_state !== "suspended" || suspendedBy(row) !== "owner") throw new ResourceLifecycleError("invalid_state");
  // A subscription suspended for non-payment is not the owner's to lift: reactivation charges first.
  const sub = await env.PLATFORM_DB.prepare("SELECT renewal_state FROM managed_service_subscriptions WHERE tenant_id=? AND resource_id=?")
    .bind(scope.tenantId, row.provider_resource_ref).first<{ renewal_state: string }>();
  if (sub?.renewal_state === "suspended") throw new ResourceLifecycleError("subscription_suspended");
  await pause(adapter, scope.tenantId, row.provider_resource_ref, false);
  await env.PLATFORM_DB.prepare(`UPDATE managed_service_accounts SET lifecycle_state='active',metadata_json=json_remove(COALESCE(metadata_json,'{}'),'$.suspended_by'),
      row_version=row_version+1,updated_at=? WHERE id=? AND tenant_id=? AND lifecycle_state='suspended'`)
    .bind(new Date().toISOString(), resourceId, scope.tenantId).run();
  return { resourceId, status: "active" };
}

/**
 * MS-47 item 3: reactivates a resource whose subscription was suspended for non-payment. Charges the overdue period first (the
 * subscription engine's own idempotent charge rows), then lifts the billing pause. Needs MANAGED_SUBSCRIPTIONS_ENABLED and
 * MANAGED_OFFERINGS_ENABLED like the rest of the subscription flow; without them the resource looks unknown.
 */
export async function reactivateManagedResource(
  env: AgentsEnv, scope: Pick<CommunicationScope, "tenantId" | "spaceId">, resourceId: string, adapter: ReactivationAdapter = createNaelaoEmailAdapter(env), now = new Date(),
): Promise<{ resourceId: string; status: "reactivated"; sendingResumed: boolean }> {
  if (!managedSubscriptionsEnabled(env) || env.MANAGED_OFFERINGS_ENABLED !== "true") throw new ResourceLifecycleError("resource_not_found");
  const row = await load(env, scope, resourceId);
  const sub = await env.PLATFORM_DB.prepare("SELECT id FROM managed_service_subscriptions WHERE tenant_id=? AND resource_id=? AND subscription_type=?")
    .bind(scope.tenantId, row.provider_resource_ref, NAELAO_EMAIL_SUBSCRIPTION_TYPE).first<{ id: string }>();
  if (!sub) throw new ResourceLifecycleError("invalid_state");
  const result = await reactivateManagedSubscription(env, createNaelaoEmailSubscriptionHandler(adapter), { subscriptionId: sub.id, tenantId: scope.tenantId }, now);
  if (result.status === "reactivated") return { resourceId, status: "reactivated", sendingResumed: result.resumed };
  if (result.status === "failed") throw new ResourceLifecycleError("charge_failed");
  if (result.status === "busy") throw new ResourceLifecycleError("reactivation_in_progress");
  throw new ResourceLifecycleError("invalid_state");
}
