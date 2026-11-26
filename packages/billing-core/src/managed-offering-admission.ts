// MS-28 / V-spec MR-CAT-3: fail-closed admission for managed provisioning.
//
// A pure function over a D1-like handle so Billing (MS-29 reserve path) and the Agents worker call
// the same rules. It reads only; it never writes. Timestamps on offerings and agreements are epoch
// milliseconds; capability `valid_until` is an ISO-8601 string (the capability table's own format).
//
// Admission requires, for the requested offering, region and strategy:
//   1. the offering is `available`, or `testing` for a tenant on its `testing_tenant_ids_json`;
//   2. its capability version is `verified`, unexpired, and supports the operation, region and mode;
//   3. unless the strategy is `customer_connection` (BYOK needs no agreement), an `approved`,
//      effective, unexpired agreement that permits managed provisioning, lists the offering id,
//      permits the strategy and permits the region.
// `"*"` in an offering's or agreement's regions list means every region. It is not accepted in the
// capability's verified regions, which must name the region explicitly.

export type OfferingAdmissionErrorCode = "offering_unavailable" | "provider_not_approved" | "capability_unsupported";

export type ProvisioningStrategy = "first_party" | "managed_master" | "native_subaccount" | "customer_connection" | "partner_direct";

/** The subset of D1Database admission needs; a real D1Database satisfies it structurally. */
export interface OfferingAdmissionDb {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all<T = unknown>(): Promise<{ results?: T[] }>;
    };
  };
}

export interface OfferingAdmissionInput {
  tenantId: string;
  provider: string;
  serviceId: string;
  operation: string;
  region: string;
  strategy: ProvisioningStrategy;
  now?: Date | number;
  /** Pin one offering. Without it the best admissible offering by `preference_rank` is returned. */
  offeringId?: string;
}

export interface AdmittedOffering {
  id: string;
  provider: string;
  serviceId: string;
  capabilityVersion: number;
  resourceType: string;
  category: string;
  displayName: string;
  accessModes: string[];
  strategies: string[];
  regions: string[];
  chargeComponents: unknown;
  quotePolicy: "none" | "required_for_recurring" | "always";
  preferenceRank: number;
  status: "testing" | "available";
}

export interface AdmittedAgreement {
  id: string;
  provider: string;
  agreementType: string;
  permittedRegions: string[];
  effectiveFrom: number;
  expiresAt: number | null;
  approvedBy: string;
  approvedAt: number;
}

export type OfferingAdmission =
  | { ok: true; offering: AdmittedOffering; agreement: AdmittedAgreement | null; capabilityVersion: number }
  | { ok: false; error_code: OfferingAdmissionErrorCode };

interface OfferingRow {
  id: string; provider: string; service_id: string; capability_version: number; resource_type: string; category: string;
  display_name: string; access_modes_json: string; strategies_json: string; regions_json: string; charge_components_json: string;
  quote_policy: string; preference_rank: number; status: string; testing_tenant_ids_json: string | null;
}
interface CapabilityRow {
  status: string; verified_by: string | null; verified_at: string | null; valid_until: string | null;
  operations_json: string; regions_json: string; account_modes_json: string;
}
interface AgreementRow {
  id: string; provider: string; agreement_type: string; permitted_offering_ids_json: string; permits_managed_provisioning: number;
  permits_master_account_distribution: number; permits_subaccount_distribution: number; permitted_regions_json: string;
  effective_from: number; expires_at: number | null; verification_status: string; approved_by: string | null; approved_at: number | null;
}

const fail = (error_code: OfferingAdmissionErrorCode): OfferingAdmission => ({ ok: false, error_code });

function stringList(value: string | null | undefined): string[] | null {
  if (value === null || value === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string") ? parsed : null;
  } catch { return null; }
}

const regionPermitted = (regions: string[], region: string) => regions.includes("*") || regions.includes(region);

/** capability_versions.account_modes_json uses connection-mode names (MR-RES-1 mapping). */
function connectionModeFor(strategy: ProvisioningStrategy): string | null {
  switch (strategy) {
    case "first_party": case "managed_master": return "naelao_managed";
    case "customer_connection": return "user_connected";
    case "native_subaccount": return "provider_managed";
    default: return null; // partner_direct is deferred (MD-12): never admitted
  }
}

function agreementPermitsStrategy(agreement: AgreementRow, strategy: ProvisioningStrategy): boolean {
  switch (strategy) {
    case "managed_master": return agreement.permits_master_account_distribution === 1;
    case "native_subaccount": return agreement.permits_subaccount_distribution === 1;
    case "first_party": return agreement.agreement_type === "first_party";
    default: return false;
  }
}

async function admitOffering(db: OfferingAdmissionDb, input: OfferingAdmissionInput, offering: OfferingRow, nowMs: number): Promise<OfferingAdmission> {
  if (offering.status === "testing") {
    const allowlist = stringList(offering.testing_tenant_ids_json);
    if (!allowlist || !input.tenantId || !allowlist.includes(input.tenantId)) return fail("offering_unavailable");
  } else if (offering.status !== "available") {
    return fail("offering_unavailable");
  }
  const strategies = stringList(offering.strategies_json), regions = stringList(offering.regions_json), accessModes = stringList(offering.access_modes_json);
  if (!strategies || !regions || !accessModes || !["none", "required_for_recurring", "always"].includes(offering.quote_policy)) return fail("offering_unavailable");
  const accessMode = input.strategy === "customer_connection" ? "byok" : "managed";
  if (!strategies.includes(input.strategy) || !accessModes.includes(accessMode) || !regionPermitted(regions, input.region)) return fail("offering_unavailable");
  let chargeComponents: unknown;
  try { chargeComponents = JSON.parse(offering.charge_components_json); } catch { return fail("offering_unavailable"); }

  const connectionMode = connectionModeFor(input.strategy);
  if (!connectionMode) return fail("capability_unsupported");
  const capability = (await db.prepare(`SELECT status,verified_by,verified_at,valid_until,operations_json,regions_json,account_modes_json
    FROM managed_service_capability_versions WHERE provider=? AND service_id=? AND version=?`)
    .bind(offering.provider, offering.service_id, offering.capability_version).all<CapabilityRow>()).results?.[0];
  if (!capability || capability.status !== "verified" || !capability.verified_by || !capability.verified_at) return fail("capability_unsupported");
  const validUntil = Date.parse(capability.valid_until ?? "");
  if (!Number.isFinite(validUntil) || validUntil <= nowMs) return fail("capability_unsupported");
  const operations = stringList(capability.operations_json), capabilityRegions = stringList(capability.regions_json), modes = stringList(capability.account_modes_json);
  if (!operations || !capabilityRegions || !modes || !operations.includes(input.operation) || !modes.includes(connectionMode)
    || !capabilityRegions.includes(input.region)) return fail("capability_unsupported");

  const admittedOffering: AdmittedOffering = {
    id: offering.id, provider: offering.provider, serviceId: offering.service_id, capabilityVersion: offering.capability_version,
    resourceType: offering.resource_type, category: offering.category, displayName: offering.display_name, accessModes, strategies, regions,
    chargeComponents, quotePolicy: offering.quote_policy as AdmittedOffering["quotePolicy"], preferenceRank: offering.preference_rank,
    status: offering.status as AdmittedOffering["status"],
  };
  if (input.strategy === "customer_connection") return { ok: true, offering: admittedOffering, agreement: null, capabilityVersion: offering.capability_version };

  const agreements = (await db.prepare(`SELECT id,provider,agreement_type,permitted_offering_ids_json,permits_managed_provisioning,
      permits_master_account_distribution,permits_subaccount_distribution,permitted_regions_json,effective_from,expires_at,
      verification_status,approved_by,approved_at
    FROM managed_service_commercial_agreements WHERE provider=? AND verification_status='approved' ORDER BY id`)
    .bind(offering.provider).all<AgreementRow>()).results ?? [];
  for (const agreement of agreements) {
    if (agreement.permits_managed_provisioning !== 1 || !agreement.approved_by || agreement.approved_at === null) continue;
    if (agreement.effective_from > nowMs || (agreement.expires_at !== null && agreement.expires_at <= nowMs)) continue;
    const offeringIds = stringList(agreement.permitted_offering_ids_json), permittedRegions = stringList(agreement.permitted_regions_json);
    if (!offeringIds || !permittedRegions || !offeringIds.includes(offering.id) || !regionPermitted(permittedRegions, input.region)) continue;
    if (!agreementPermitsStrategy(agreement, input.strategy)) continue;
    return {
      ok: true, offering: admittedOffering, capabilityVersion: offering.capability_version,
      agreement: { id: agreement.id, provider: agreement.provider, agreementType: agreement.agreement_type, permittedRegions,
        effectiveFrom: agreement.effective_from, expiresAt: agreement.expires_at, approvedBy: agreement.approved_by, approvedAt: agreement.approved_at },
    };
  }
  return fail("provider_not_approved");
}

export async function resolveOfferingAdmission(db: OfferingAdmissionDb, input: OfferingAdmissionInput): Promise<OfferingAdmission> {
  const nowMs = input.now instanceof Date ? input.now.getTime() : input.now ?? Date.now();
  const rows = (await db.prepare(`SELECT id,provider,service_id,capability_version,resource_type,category,display_name,access_modes_json,
      strategies_json,regions_json,charge_components_json,quote_policy,preference_rank,status,testing_tenant_ids_json
    FROM managed_service_offerings WHERE provider=? AND service_id=? AND (? IS NULL OR id=?) ORDER BY preference_rank ASC, id ASC`)
    .bind(input.provider, input.serviceId, input.offeringId ?? null, input.offeringId ?? null).all<OfferingRow>()).results ?? [];
  let firstFailure: OfferingAdmission = fail("offering_unavailable");
  let sawFailure = false;
  for (const row of rows) {
    const result = await admitOffering(db, input, row, nowMs);
    if (result.ok) return result;
    if (!sawFailure) { firstFailure = result; sawFailure = true; }
  }
  return firstFailure;
}
