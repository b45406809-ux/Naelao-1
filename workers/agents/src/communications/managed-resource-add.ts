// MS-43 (V-spec MR-OS-2, MR-COM-4/7/8, MR-SEC-6, OD-6): the add-resource flow behind MANAGED_RESOURCES_PANEL_ENABLED.
//   resource-options   eligible offerings for a resource type and access mode, ordered, with the reason for the automatic choice
//   resource-quote     a quote that shows every component and the minimum monthly cost
//   resource-provision approval: an unexpired matching quote, a paid plan for recurring offerings, then the provider adapter
// Authorization (owner/admin, not-found shape) is the route's job. Nothing here names a provider except the adapter table, and no
// provisioning strategy name, provider ref or credential ref is returned.
import { resolveOfferingAdmission, type AdmittedOffering, type OfferingAdmissionDb, type ProvisioningStrategy } from "@naelao/billing-core";
import { createNaelaoEmailAdapter, NAELAO_EMAIL_PROVIDER, NAELAO_EMAIL_SERVICE_ID } from "./providers/naelao-email.js";
import { ProviderAdapterError, type ProviderAdapterV1 } from "./providers/contract.js";
import type { AgentsEnv } from "../index.js";
import type { CommunicationScope } from "./core.js";
import {
  ManagedQuoteError, QUOTE_STRATEGY_CANDIDATES, computeQuoteBreakdown, createOfferingQuote, offeringPriceVersion, parseChargeComponents,
  verifyOfferingQuote, type OfferingQuote, type QuoteComponent,
} from "./managed-quotes.js";
import { registerProvisionedResource } from "./managed-resource-registration.js";
import { markManagedServiceCreditsUncertain, releaseManagedServiceCredits, reserveManagedServiceCredits, settleManagedServiceCredits } from "./managed-service-billing.js";

export type ResourceAccessMode = "managed" | "byok";
export type ResourceAddErrorCode =
  | "bad_request" | "plan_not_eligible" | "capability_unsupported" | "offering_unavailable" | "provider_not_approved" | "no_eligible_offering"
  | "quote_not_found" | "quote_binding_mismatch" | "quote_expired" | "quote_price_changed" | "quote_already_used"
  | "quote_components_invalid" | "quote_no_charge" | "quote_ttl_invalid" | "provision_failed" | "outcome_unknown" | "reservation_failed";
export class ResourceAddError extends Error {
  constructor(readonly code: ResourceAddErrorCode, readonly status: number) { super(code); this.name = "ResourceAddError"; }
}

export const RESOURCE_ADD_STATUS: Record<ResourceAddErrorCode, number> = {
  bad_request: 400, plan_not_eligible: 403, capability_unsupported: 501, offering_unavailable: 409, provider_not_approved: 409, no_eligible_offering: 409,
  quote_not_found: 404, quote_binding_mismatch: 409, quote_expired: 409, quote_price_changed: 409, quote_already_used: 409, quote_components_invalid: 409,
  quote_no_charge: 409, quote_ttl_invalid: 400, provision_failed: 502, outcome_unknown: 502, reservation_failed: 502,
};
const fail = (code: ResourceAddErrorCode) => new ResourceAddError(code, RESOURCE_ADD_STATUS[code]);

const ID = /^[A-Za-z0-9._:-]{1,200}$/;
const REGION = /^[a-z0-9][a-z0-9-]{0,31}$/;
const RESOURCE_TYPE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const LOCAL_PART = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface ResourceOption {
  offeringId: string;
  displayName: string;
  region: string;
  regions: string[];
  recurring: boolean;
  components: QuoteComponent[];
  mandatoryComponents: QuoteComponent[];
  minMonthlyCredits: number;
  initialCredits: number;
}
export interface ResourceOptions {
  resourceType: string;
  accessMode: ResourceAccessMode;
  planTier: string;
  options: ResourceOption[];
  selectedOfferingId: string | null;
  reason: string;
  excluded: { plan: number; unavailable: number };
}

type OfferingRow = { id: string; provider: string; service_id: string; regions_json: string; preference_rank: number };

async function planTier(env: Pick<AgentsEnv, "PLATFORM_DB">, tenantId: string): Promise<string> {
  const org = await env.PLATFORM_DB.prepare("SELECT plan_tier FROM orgs WHERE id=? AND status='active'").bind(tenantId).first<{ plan_tier: string }>();
  if (!org) throw fail("offering_unavailable");
  return org.plan_tier;
}

const isRecurring = (components: QuoteComponent[]) => components.some((c) => c.kind === "rental");

const creditsLabel = (credits: number) => `${credits} credit${credits === 1 ? "" : "s"}`;

/**
 * Hard filters first (type, access mode, region, offering status, verified capability, approved agreement, plan), then
 * `preference_rank`, then the lowest minimum monthly price, then id. The reason says which rule decided.
 */
export async function listResourceOptions(
  env: Pick<AgentsEnv, "PLATFORM_DB">,
  scope: Pick<CommunicationScope, "tenantId">,
  input: { resourceType: string; accessMode: ResourceAccessMode; region?: string | null; now?: Date },
): Promise<ResourceOptions> {
  if (!RESOURCE_TYPE.test(input.resourceType) || (input.accessMode !== "managed" && input.accessMode !== "byok")
    || (input.region != null && !REGION.test(input.region))) throw fail("bad_request");
  const now = input.now ?? new Date();
  const tier = await planTier(env, scope.tenantId);
  const rows = (await env.PLATFORM_DB.prepare(`SELECT id,provider,service_id,regions_json,preference_rank FROM managed_service_offerings
    WHERE resource_type=? ORDER BY preference_rank ASC,id ASC LIMIT 200`).bind(input.resourceType).all<OfferingRow>()).results ?? [];
  const strategies: readonly ProvisioningStrategy[] = input.accessMode === "byok" ? ["customer_connection"] : QUOTE_STRATEGY_CANDIDATES;
  const db = env.PLATFORM_DB as unknown as OfferingAdmissionDb;
  const eligible: Array<ResourceOption & { rank: number }> = [];
  let excludedPlan = 0, excludedUnavailable = 0;
  for (const row of rows) {
    let regionList: string[] = [];
    try { const parsed: unknown = JSON.parse(row.regions_json); if (Array.isArray(parsed)) regionList = parsed.filter((r): r is string => typeof r === "string"); } catch { /* fails closed below */ }
    const candidates = input.region ? [input.region] : regionList.filter((r) => r !== "*" && REGION.test(r));
    const admittedRegions: string[] = [];
    let admitted: AdmittedOffering | null = null;
    for (const region of candidates) {
      for (const strategy of strategies) {
        const admission = await resolveOfferingAdmission(db, {
          tenantId: scope.tenantId, provider: row.provider, serviceId: row.service_id, operation: "provision", region, strategy, now, offeringId: row.id,
        });
        if (admission.ok) { admittedRegions.push(region); admitted ??= admission.offering; break; }
      }
    }
    if (!admitted) { excludedUnavailable++; continue; }
    let components: QuoteComponent[];
    try { components = parseChargeComponents(admitted.chargeComponents); } catch { excludedUnavailable++; continue; }
    const recurring = isRecurring(components);
    // MR-SEC-6 / OD-6: no managed recurring resources on Free.
    if (input.accessMode === "managed" && recurring && tier === "free") { excludedPlan++; continue; }
    const breakdown = computeQuoteBreakdown(components);
    eligible.push({
      offeringId: admitted.id, displayName: admitted.displayName, region: admittedRegions[0]!, regions: admittedRegions, recurring, components,
      mandatoryComponents: breakdown.mandatory, minMonthlyCredits: breakdown.minMonthlyCredits, initialCredits: breakdown.initialCredits, rank: admitted.preferenceRank,
    });
  }
  eligible.sort((a, b) => a.rank - b.rank || a.minMonthlyCredits - b.minMonthlyCredits || a.offeringId.localeCompare(b.offeringId));
  const best = eligible[0];
  let reason: string;
  if (!best) {
    reason = excludedPlan > 0 && excludedUnavailable === 0
      ? "Recurring managed resources need a paid plan."
      : "No offering of this type is currently available for this Space.";
  } else {
    const tied = eligible.filter((o) => o.rank === best.rank);
    reason = eligible.length === 1
      ? `${best.displayName} is the only available option.`
      : tied.length > 1
        ? `${best.displayName} is tied for first choice with ${tied.length - 1} other option${tied.length > 2 ? "s" : ""} and has the lowest minimum monthly cost (${creditsLabel(best.minMonthlyCredits)}).`
        : `${best.displayName} is the preferred option of ${eligible.length} available.`;
  }
  return {
    resourceType: input.resourceType, accessMode: input.accessMode, planTier: tier,
    options: eligible.map(({ rank: _rank, ...option }) => option), selectedOfferingId: best?.offeringId ?? null, reason,
    excluded: { plan: excludedPlan, unavailable: excludedUnavailable },
  };
}

export interface ResourceQuoteInput {
  resourceType: string;
  accessMode: ResourceAccessMode;
  /** Absent means Automatic. */
  offeringId?: string | null;
  region?: string | null;
  localPart?: string | null;
  displayName?: string | null;
  now?: Date;
}

export interface ResourceTypeSummary { resourceType: string; category: string | null; optionCount: number; planRequired: boolean }

/**
 * MS-47 item 5: the resource types the add flow can offer, read from the offerings table instead of a hard-coded list. A type is listed
 * when at least one of its offerings passes the same hard filters as `resource-options` for this tenant (Managed), or is held back only by
 * the plan (`planRequired`). Draft, disabled and deprecated offerings never contribute a type.
 */
export async function listResourceTypes(
  env: Pick<AgentsEnv, "PLATFORM_DB">,
  scope: Pick<CommunicationScope, "tenantId">,
  input: { now?: Date } = {},
): Promise<{ types: ResourceTypeSummary[] }> {
  const rows = (await env.PLATFORM_DB.prepare(`SELECT resource_type,MIN(category) AS category FROM managed_service_offerings
    WHERE status IN ('testing','available','restricted') GROUP BY resource_type ORDER BY resource_type LIMIT 50`).all<{ resource_type: string; category: string | null }>()).results ?? [];
  const types: ResourceTypeSummary[] = [];
  for (const row of rows) {
    if (!RESOURCE_TYPE.test(row.resource_type)) continue;
    const options = await listResourceOptions(env, scope, { resourceType: row.resource_type, accessMode: "managed", ...(input.now ? { now: input.now } : {}) });
    if (options.options.length === 0 && options.excluded.plan === 0) continue;
    types.push({ resourceType: row.resource_type, category: row.category, optionCount: options.options.length, planRequired: options.options.length === 0 });
  }
  return { types };
}

function configurationOf(input: { localPart?: string | null; displayName?: string | null }) {
  return { localPart: input.localPart ?? "", displayName: input.displayName ?? "" };
}

function validateConfiguration(input: { localPart?: string | null; displayName?: string | null }) {
  if (input.localPart != null && !LOCAL_PART.test(input.localPart)) throw fail("bad_request");
  if (input.displayName != null && (input.displayName.length < 1 || input.displayName.length > 120 || /[\u0000-\u001f\u007f]/.test(input.displayName))) throw fail("bad_request");
}

export async function createResourceQuote(
  env: Pick<AgentsEnv, "PLATFORM_DB">,
  scope: Pick<CommunicationScope, "tenantId" | "spaceId" | "projectId" | "userId">,
  input: ResourceQuoteInput,
): Promise<{ quote: OfferingQuote; reason: string; chosen: "automatic" | "provider" }> {
  validateConfiguration(input);
  // Managed purchases only: a Bring-your-own connection needs credentials, not a quote (no adapter creates one here).
  if (input.accessMode !== "managed") throw fail("capability_unsupported");
  const options = await listResourceOptions(env, scope, { resourceType: input.resourceType, accessMode: "managed", region: input.region ?? null, ...(input.now ? { now: input.now } : {}) });
  const pick = input.offeringId ? options.options.find((o) => o.offeringId === input.offeringId) : options.options[0];
  if (!pick) {
    if (input.offeringId) throw fail(options.excluded.plan > 0 && options.excluded.unavailable === 0 ? "plan_not_eligible" : "offering_unavailable");
    throw fail(options.excluded.plan > 0 && options.excluded.unavailable === 0 ? "plan_not_eligible" : "no_eligible_offering");
  }
  const offering = await env.PLATFORM_DB.prepare("SELECT provider,service_id FROM managed_service_offerings WHERE id=?").bind(pick.offeringId).first<{ provider: string; service_id: string }>();
  if (!offering) throw fail("offering_unavailable");
  const region = input.region ?? pick.region;
  try {
    const quote = await createOfferingQuote(env, {
      scope: { tenantId: scope.tenantId, spaceId: scope.spaceId, projectId: scope.projectId ?? null, userId: scope.userId },
      planTier: options.planTier, provider: offering.provider, serviceId: offering.service_id, operationName: "provision", region,
      offeringId: pick.offeringId, configuration: configurationOf(input), ...(input.now ? { now: input.now } : {}),
    });
    return { quote, chosen: input.offeringId ? "provider" : "automatic", reason: input.offeringId ? `You chose ${pick.displayName}.` : options.reason };
  } catch (error) {
    if (error instanceof ManagedQuoteError) throw fail(error.code);
    throw error;
  }
}

export type ResourceAdapters = Record<string, ProviderAdapterV1>;
const adapterKey = (provider: string, serviceId: string) => `${provider}/${serviceId}`;

/** Only naelao-email has a provision adapter; every other offering answers `capability_unsupported` (no adapter, no fake success). */
export function defaultResourceAdapters(env: AgentsEnv): ResourceAdapters {
  return { [adapterKey(NAELAO_EMAIL_PROVIDER, NAELAO_EMAIL_SERVICE_ID)]: createNaelaoEmailAdapter(env) };
}

async function sha256Hex(value: string) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export interface ResourceProvisionInput {
  quoteId: string;
  offeringId: string;
  region: string;
  localPart?: string | null;
  displayName?: string | null;
  now?: Date;
}

export interface ResourceProvisionResult {
  operationId: string;
  offeringId: string;
  resource: { resourceType: string; address?: string; status: string };
  /** MS-47: the registered `managed_service_accounts` id; present only when the resource row was registered. */
  resourceId?: string;
  /** MS-47: true when an AgentPort account exists, so owner and template grants apply now instead of being deferred. */
  agentPortLinked?: boolean;
}

export async function provisionManagedResource(
  env: AgentsEnv,
  scope: Pick<CommunicationScope, "tenantId" | "spaceId" | "projectId" | "userId" | "role">,
  input: ResourceProvisionInput,
  adapters: ResourceAdapters = defaultResourceAdapters(env),
): Promise<ResourceProvisionResult> {
  if (!/^msq_[A-Fa-f0-9]{32}$/.test(input.quoteId) || !ID.test(input.offeringId) || !REGION.test(input.region)) throw fail("bad_request");
  validateConfiguration(input);
  const now = input.now ?? new Date();
  const db = env.PLATFORM_DB;
  const row = await db.prepare(`SELECT o.provider,o.service_id,o.resource_type,o.charge_components_json
    FROM managed_service_offerings o WHERE o.id=?`).bind(input.offeringId).first<{ provider: string; service_id: string; resource_type: string; charge_components_json: string }>();
  // The quote must belong to this Space and requester; a foreign quote looks like an unknown one.
  const owned = await db.prepare("SELECT space_id,project_id,requester_user_id,plan_tier,credits FROM managed_service_operation_quotes WHERE quote_id=? AND tenant_id=?")
    .bind(input.quoteId, scope.tenantId).first<{ space_id: string; project_id: string | null; requester_user_id: string; plan_tier: string; credits: number }>();
  if (!row || !owned || owned.space_id !== scope.spaceId || owned.project_id !== (scope.projectId ?? null) || owned.requester_user_id !== scope.userId) throw fail("quote_not_found");
  let components: QuoteComponent[];
  try { components = parseChargeComponents(JSON.parse(row.charge_components_json) as unknown); } catch { throw fail("quote_components_invalid"); }
  // MR-SEC-6 / OD-6: re-read the plan now, not the plan at quote time.
  if (isRecurring(components) && await planTier(env, scope.tenantId) === "free") throw fail("plan_not_eligible");
  const adapter = adapters[adapterKey(row.provider, row.service_id)];
  if (!adapter?.provision) throw fail("capability_unsupported");

  const verified = await verifyOfferingQuote(env, input.quoteId, {
    tenantId: scope.tenantId, offeringId: input.offeringId, region: input.region, configuration: configurationOf(input),
    priceVersion: await offeringPriceVersion(input.offeringId, components), now,
  });
  if (!verified.ok) throw fail(verified.error_code);

  // The operation is recorded before the provider is called (reconcile uncertain outcomes, never blind-retry).
  const operationId = `res_${(await sha256Hex(`add-resource:${input.quoteId}`)).slice(0, 40)}`;
  const reservationId = `${operationId}:reserve`;
  const requestHash = await sha256Hex(JSON.stringify({ offering: input.offeringId, region: input.region, ...configurationOf(input), space: scope.spaceId, user: scope.userId }));
  const stamp = now.toISOString();
  const claim = await db.batch([
    db.prepare(`INSERT OR IGNORE INTO managed_service_operations(operation_id,tenant_id,space_id,project_id,provider,service_id,capability_version,operation_name,region,
      idempotency_key,request_sha256,request_json,status,quote_id,price_version,reserved_credits,created_at,updated_at)
      SELECT ?,?,?,?,?,?,q.capability_version,'provision',?,?,?,?,'pending',q.quote_id,q.price_version,q.credits,?,? FROM managed_service_operation_quotes q WHERE q.quote_id=?`)
      .bind(operationId, scope.tenantId, scope.spaceId, scope.projectId ?? null, row.provider, row.service_id, input.region, operationId, requestHash,
        JSON.stringify({ offeringId: input.offeringId, region: input.region }), stamp, stamp, input.quoteId),
    db.prepare(`UPDATE managed_service_operation_quotes SET status='consumed',operation_id=?,consumed_at=? WHERE quote_id=? AND status='quoted' AND expires_at>? AND tenant_id=?`)
      .bind(operationId, stamp, input.quoteId, stamp, scope.tenantId),
  ]);
  if ((claim[1]?.meta?.changes ?? 0) !== 1) throw fail("quote_already_used");

  const quoteRow = await db.prepare("SELECT price_version,credits FROM managed_service_operation_quotes WHERE quote_id=?").bind(input.quoteId).first<{ price_version: string; credits: number }>();
  const setStatus = (status: string) => db.prepare("UPDATE managed_service_operations SET status=?,updated_at=? WHERE operation_id=? AND tenant_id=?")
    .bind(status, new Date().toISOString(), operationId, scope.tenantId).run();
  const billingScope: CommunicationScope = { tenantId: scope.tenantId, spaceId: scope.spaceId, userId: scope.userId, role: scope.role, ...(scope.projectId ? { projectId: scope.projectId } : {}) };
  try {
    await reserveManagedServiceCredits(env, billingScope, {
      reservationId, operationId, provider: row.provider, serviceId: row.service_id, operationName: "provision", region: input.region,
      credits: quoteRow!.credits, priceVersion: quoteRow!.price_version, enforceProjectSpend: true,
    });
  } catch { await setStatus("failed"); throw fail("reservation_failed"); }
  await setStatus("running");
  try {
    const result = await adapter.provision({
      tenantId: scope.tenantId, region: input.region, reservationId, offeringId: input.offeringId,
      ...(input.localPart ? { localPart: input.localPart } : {}), ...(input.displayName ? { displayName: input.displayName } : {}),
      // MS-41 item 4: the billing scope that lets the adapter enroll the new resource in its subscription.
      spaceId: scope.spaceId, projectId: scope.projectId ?? null, userId: scope.userId,
    }, { operation_id: operationId, idempotency_key: operationId });
    // The first period is paid here (the subscription charges the next one at renewal). A failed settle leaves the hold for reconciliation.
    await settleManagedServiceCredits(env, billingScope, reservationId, quoteRow!.credits).catch(() => undefined);
    await setStatus("complete");
    // MS-47 item 1: register the resource and its AgentPort account so grants can apply. The provider resource exists and is paid for,
    // so a registration failure never fails the provision; the caller sees no resourceId and records its grants as deferred.
    const registered = await registerProvisionedResource(env, scope, {
      provider: row.provider, serviceId: row.service_id, capabilityVersion: result.capability_version, offeringId: input.offeringId,
      resource: result.resource, region: input.region, displayName: input.displayName ?? null, now,
    }).catch(() => null);
    return { operationId, offeringId: input.offeringId, resource: { resourceType: row.resource_type, status: result.resource.status, ...(result.resource.address ? { address: result.resource.address } : {}) },
      ...(registered ? { resourceId: registered.resourceId, agentPortLinked: registered.agentPortAccountId !== null } : {}) };
  } catch (error) {
    const code = error instanceof ProviderAdapterError ? error.code : "provision_failed";
    if (code === "outcome_unknown") {
      // Ambiguous: keep the hold and let reconciliation decide. A retry would need a new quote.
      await setStatus("uncertain");
      await markManagedServiceCreditsUncertain(env, billingScope, reservationId).catch(() => undefined);
      throw fail("outcome_unknown");
    }
    await setStatus("failed");
    await releaseManagedServiceCredits(env, billingScope, reservationId, "no_effect").catch(() => undefined);
    throw fail(code === "capability_unsupported" ? "capability_unsupported" : "provision_failed");
  }
}
