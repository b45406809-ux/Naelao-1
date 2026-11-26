// MS-28 (V-spec MD-3, §6.2-6.3): operator writes for managed-service offerings and commercial
// agreements. Same shape as the capability verify/disable helpers: validate, read the prior row,
// then one D1 batch that writes the row and its audit record together (the audit insert only runs
// when the row write took effect). Every write carries the operator id and a reason. Agreement
// evidence is stored only as a sha256 digest, never the document. Timestamps are epoch ms.

const ID = /^[a-z][a-z0-9_.:-]{1,127}$/;
const PROVIDER = /^[a-z][a-z0-9_-]{1,62}$/;
const SERVICE = /^[a-z][a-z0-9_.:-]{1,127}$/;
const REGION = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ACTOR = /^[A-Za-z0-9._:@-]{1,160}$/;
const TENANT = /^[A-Za-z0-9._:@-]{1,160}$/;
const OFFERING_STATUS = ["draft", "testing", "available", "restricted", "deprecated", "disabled"] as const;
const QUOTE_POLICY = ["none", "required_for_recurring", "always"] as const;
const STRATEGIES = ["first_party", "managed_master", "native_subaccount", "customer_connection", "partner_direct"] as const;
const ACCESS_MODES = ["managed", "byok"] as const;
const CATEGORIES = ["email", "phone", "messaging", "model", "browser", "compute", "storage", "search"] as const;
const AGREEMENT_TYPES = ["standard_terms", "reseller", "wholesale", "platform_partner", "referral", "first_party"] as const;
/** `approved` is reachable only through approveCommercialAgreement. */
const AGREEMENT_EDIT_STATUS = ["unverified", "under_review", "expired", "revoked"] as const;

export class ManagedOfferingAdminError extends Error {
  constructor(readonly code: string, readonly status: 400 | 404 | 409) { super(code); }
}
const bad = (code: string) => new ManagedOfferingAdminError(code, 400);

function validReason(reason: unknown): string {
  if (typeof reason !== "string" || reason.trim().length < 10 || reason.length > 500) throw bad("managed_offering_reason_invalid");
  return reason.trim();
}
function validActor(actorId: unknown): string {
  if (typeof actorId !== "string" || !ACTOR.test(actorId)) throw bad("managed_offering_actor_invalid");
  return actorId;
}
function enumList<T extends string>(value: unknown, allowed: readonly T[], code: string, max = 20): T[] {
  if (!Array.isArray(value) || value.length > max || new Set(value).size !== value.length || value.some((entry) => !allowed.includes(entry as T))) throw bad(code);
  return value as T[];
}
function regionList(value: unknown, code: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50 || new Set(value).size !== value.length
    || value.some((entry) => typeof entry !== "string" || (entry !== "*" && !REGION.test(entry)))) throw bad(code);
  return value as string[];
}
function jsonValue(value: unknown, code: string, max = 16 * 1024): string {
  let text: string | undefined;
  try { text = JSON.stringify(value); } catch { text = undefined; }
  if (value === undefined || text === undefined || text.length > max) throw bad(code);
  return text;
}
const auditId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

export type OfferingInput = {
  offeringId: string; provider: string; serviceId: string; capabilityVersion: number; resourceType: string; category: string;
  displayName: string; accessModes: unknown; strategies: unknown; regions: unknown; configurationSchema: unknown;
  chargeComponents: unknown; quotePolicy: string; dataHandling: unknown; preferenceRank?: number; status: string;
  testingTenantIds?: unknown; actorId: string; reason: string; now?: Date;
};

export async function upsertManagedServiceOffering(db: D1Database, input: OfferingInput) {
  const actorId = validActor(input.actorId), reason = validReason(input.reason);
  if (!ID.test(input.offeringId) || !PROVIDER.test(input.provider) || !SERVICE.test(input.serviceId)
    || !Number.isSafeInteger(input.capabilityVersion) || input.capabilityVersion < 1
    || typeof input.resourceType !== "string" || !/^[a-z][a-z0-9_.-]{1,63}$/.test(input.resourceType)
    || !(CATEGORIES as readonly string[]).includes(input.category)
    || typeof input.displayName !== "string" || !input.displayName.trim() || input.displayName.length > 120
    || !(QUOTE_POLICY as readonly string[]).includes(input.quotePolicy)
    || !(OFFERING_STATUS as readonly string[]).includes(input.status)
    || (input.preferenceRank !== undefined && (!Number.isSafeInteger(input.preferenceRank) || input.preferenceRank < 0 || input.preferenceRank > 10_000))) {
    throw bad("managed_offering_invalid");
  }
  const accessModes = enumList(input.accessModes, ACCESS_MODES, "managed_offering_access_modes_invalid", 2);
  const strategies = enumList(input.strategies, STRATEGIES, "managed_offering_strategies_invalid");
  if (!accessModes.length || !strategies.length) throw bad("managed_offering_invalid");
  const regions = regionList(input.regions, "managed_offering_regions_invalid");
  const testingTenants = input.testingTenantIds ?? [];
  if (!Array.isArray(testingTenants) || testingTenants.length > 100 || new Set(testingTenants).size !== testingTenants.length
    || testingTenants.some((tenant) => typeof tenant !== "string" || !TENANT.test(tenant))) throw bad("managed_offering_testing_tenants_invalid");
  const configurationSchema = jsonValue(input.configurationSchema, "managed_offering_configuration_schema_invalid");
  const chargeComponents = jsonValue(input.chargeComponents, "managed_offering_charge_components_invalid");
  const dataHandling = jsonValue(input.dataHandling, "managed_offering_data_handling_invalid");
  const capability = await db.prepare("SELECT status FROM managed_service_capability_versions WHERE provider=? AND service_id=? AND version=?")
    .bind(input.provider, input.serviceId, input.capabilityVersion).first<{ status: string }>();
  if (!capability) throw new ManagedOfferingAdminError("managed_service_capability_not_found", 404);

  const prior = await db.prepare("SELECT * FROM managed_service_offerings WHERE id=?").bind(input.offeringId).first<Record<string, unknown>>();
  if (prior && (prior.provider !== input.provider || prior.service_id !== input.serviceId)) throw new ManagedOfferingAdminError("managed_offering_identity_conflict", 409);
  const nowMs = (input.now ?? new Date()).getTime();
  // Keep updated_at strictly increasing so the guarded audit insert can recognise this write.
  const updatedAt = prior ? Math.max(nowMs, Number(prior.updated_at) + 1) : nowMs;
  const values = [input.provider, input.serviceId, input.capabilityVersion, input.resourceType, input.category, input.displayName.trim(),
    JSON.stringify(accessModes), JSON.stringify(strategies), JSON.stringify(regions), configurationSchema, chargeComponents, input.quotePolicy,
    dataHandling, input.preferenceRank ?? 100, input.status, JSON.stringify(testingTenants)];
  const write = prior
    ? db.prepare(`UPDATE managed_service_offerings SET provider=?,service_id=?,capability_version=?,resource_type=?,category=?,display_name=?,
        access_modes_json=?,strategies_json=?,regions_json=?,configuration_schema_json=?,charge_components_json=?,quote_policy=?,data_handling_json=?,
        preference_rank=?,status=?,testing_tenant_ids_json=?,updated_at=? WHERE id=? AND updated_at=?`)
        .bind(...values, updatedAt, input.offeringId, prior.updated_at)
    : db.prepare(`INSERT INTO managed_service_offerings(provider,service_id,capability_version,resource_type,category,display_name,
        access_modes_json,strategies_json,regions_json,configuration_schema_json,charge_components_json,quote_policy,data_handling_json,
        preference_rank,status,testing_tenant_ids_json,updated_at,id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(...values, updatedAt, input.offeringId, updatedAt);
  const after = { id: input.offeringId, provider: input.provider, service_id: input.serviceId, capability_version: input.capabilityVersion,
    resource_type: input.resourceType, category: input.category, display_name: input.displayName.trim(), access_modes: accessModes, strategies,
    regions, quote_policy: input.quotePolicy, preference_rank: input.preferenceRank ?? 100, status: input.status, testing_tenant_ids: testingTenants };
  const result = await db.batch([
    write,
    db.prepare(`INSERT INTO managed_service_offering_audit(id,offering_id,actor_id,before_json,after_json,reason,created_at)
      SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM managed_service_offerings WHERE id=? AND updated_at=?)`)
      .bind(auditId("msoa"), input.offeringId, actorId, prior ? JSON.stringify(prior) : null, JSON.stringify(after), reason, updatedAt, input.offeringId, updatedAt),
  ]).catch(() => { throw new ManagedOfferingAdminError("managed_offering_write_conflict", 409); });
  if (!result[0]?.meta.changes || !result[1]?.meta.changes) throw new ManagedOfferingAdminError("managed_offering_write_conflict", 409);
  return { saved: true, created: !prior, offeringId: input.offeringId, status: input.status };
}

export type AgreementInput = {
  agreementId: string; provider: string; agreementType: string; permittedOfferingIds: unknown; permitsManagedProvisioning: boolean;
  permitsMasterAccountDistribution: boolean; permitsSubaccountDistribution: boolean; permitsSharedResources: boolean;
  permittedRegions: unknown; minimumCommitmentCredits?: number | null; effectiveFrom: number; expiresAt?: number | null;
  verificationStatus?: string; evidenceSha256?: string | null; actorId: string; reason: string; now?: Date;
};

const SHA256 = /^[0-9a-f]{64}$/;

/** Create or edit an agreement. It can never become `approved` here, and editing an approved agreement
 *  drops it back to `under_review` and clears the approval, so changed terms need a fresh approval. */
export async function upsertCommercialAgreement(db: D1Database, input: AgreementInput) {
  const actorId = validActor(input.actorId), reason = validReason(input.reason);
  const status = input.verificationStatus ?? "unverified";
  if (!ID.test(input.agreementId) || !PROVIDER.test(input.provider) || !(AGREEMENT_TYPES as readonly string[]).includes(input.agreementType)
    || !(AGREEMENT_EDIT_STATUS as readonly string[]).includes(status)
    || [input.permitsManagedProvisioning, input.permitsMasterAccountDistribution, input.permitsSubaccountDistribution, input.permitsSharedResources].some((flag) => typeof flag !== "boolean")
    || !Number.isSafeInteger(input.effectiveFrom) || input.effectiveFrom < 0
    || (input.expiresAt !== undefined && input.expiresAt !== null && (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= input.effectiveFrom))
    || (input.minimumCommitmentCredits !== undefined && input.minimumCommitmentCredits !== null && (!Number.isSafeInteger(input.minimumCommitmentCredits) || input.minimumCommitmentCredits < 0))
    || (input.evidenceSha256 !== undefined && input.evidenceSha256 !== null && !SHA256.test(input.evidenceSha256))) {
    throw bad("managed_agreement_invalid");
  }
  const offeringIds = input.permittedOfferingIds;
  if (!Array.isArray(offeringIds) || offeringIds.length > 200 || new Set(offeringIds).size !== offeringIds.length
    || offeringIds.some((id) => typeof id !== "string" || !ID.test(id))) throw bad("managed_agreement_offerings_invalid");
  const regions = regionList(input.permittedRegions, "managed_agreement_regions_invalid");
  const prior = await db.prepare("SELECT * FROM managed_service_commercial_agreements WHERE id=?").bind(input.agreementId).first<Record<string, unknown>>();
  if (prior && prior.provider !== input.provider) throw new ManagedOfferingAdminError("managed_agreement_identity_conflict", 409);
  if (prior?.verification_status === "revoked") throw new ManagedOfferingAdminError("managed_agreement_revoked_create_new", 409);
  const nowMs = (input.now ?? new Date()).getTime();
  const updatedAt = prior ? Math.max(nowMs, Number(prior.updated_at) + 1) : nowMs;
  const evidence = input.evidenceSha256 === undefined ? (prior?.evidence_sha256 as string | null | undefined) ?? null : input.evidenceSha256;
  const resultingStatus = prior?.verification_status === "approved" ? "under_review" : status;
  const values = [input.provider, input.agreementType, JSON.stringify(offeringIds), input.permitsManagedProvisioning ? 1 : 0,
    input.permitsMasterAccountDistribution ? 1 : 0, input.permitsSubaccountDistribution ? 1 : 0, input.permitsSharedResources ? 1 : 0,
    JSON.stringify(regions), input.minimumCommitmentCredits ?? null, input.effectiveFrom, input.expiresAt ?? null, resultingStatus, evidence];
  const write = prior
    ? db.prepare(`UPDATE managed_service_commercial_agreements SET provider=?,agreement_type=?,permitted_offering_ids_json=?,permits_managed_provisioning=?,
        permits_master_account_distribution=?,permits_subaccount_distribution=?,permits_shared_resources=?,permitted_regions_json=?,
        minimum_commitment_credits=?,effective_from=?,expires_at=?,verification_status=?,evidence_sha256=?,approved_by=NULL,approved_at=NULL,updated_at=?
        WHERE id=? AND updated_at=?`).bind(...values, updatedAt, input.agreementId, prior.updated_at)
    : db.prepare(`INSERT INTO managed_service_commercial_agreements(provider,agreement_type,permitted_offering_ids_json,permits_managed_provisioning,
        permits_master_account_distribution,permits_subaccount_distribution,permits_shared_resources,permitted_regions_json,minimum_commitment_credits,
        effective_from,expires_at,verification_status,evidence_sha256,updated_at,id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(...values, updatedAt, input.agreementId, updatedAt);
  return commitAgreementWrite(db, input.agreementId, updatedAt, write, prior, actorId, reason, "created_or_edited");
}

async function commitAgreementWrite(db: D1Database, agreementId: string, updatedAt: number, write: D1PreparedStatement,
  prior: Record<string, unknown> | null, actorId: string, reason: string, action: string) {
  // The audit "after" is read back inside the batch so it records what was stored, not what was requested.
  const result = await db.batch([
    write,
    db.prepare(`INSERT INTO managed_service_commercial_agreement_audit(id,agreement_id,actor_id,before_json,after_json,reason,created_at)
      SELECT ?,?,?,?,(SELECT json_object('action',?,'verification_status',verification_status,'evidence_sha256',evidence_sha256,'approved_by',approved_by,
        'approved_at',approved_at,'effective_from',effective_from,'expires_at',expires_at,'permitted_offering_ids_json',permitted_offering_ids_json,
        'permitted_regions_json',permitted_regions_json,'permits_managed_provisioning',permits_managed_provisioning,
        'permits_master_account_distribution',permits_master_account_distribution,'permits_subaccount_distribution',permits_subaccount_distribution,
        'permits_shared_resources',permits_shared_resources,'agreement_type',agreement_type) FROM managed_service_commercial_agreements WHERE id=?),?,?
      WHERE EXISTS(SELECT 1 FROM managed_service_commercial_agreements WHERE id=? AND updated_at=?)`)
      .bind(auditId("msca"), agreementId, actorId, prior ? JSON.stringify(prior) : null, action, agreementId, reason, updatedAt, agreementId, updatedAt),
  ]).catch(() => { throw new ManagedOfferingAdminError("managed_agreement_write_conflict", 409); });
  if (!result[0]?.meta.changes || !result[1]?.meta.changes) throw new ManagedOfferingAdminError("managed_agreement_write_conflict", 409);
  const row = await db.prepare("SELECT verification_status FROM managed_service_commercial_agreements WHERE id=?").bind(agreementId).first<{ verification_status: string }>();
  return { saved: true, created: !prior, agreementId, verificationStatus: row?.verification_status ?? null };
}

/** Approval records the operator as approver and requires evidence, stored only as its sha256. */
export async function approveCommercialAgreement(db: D1Database, input: {
  agreementId: string; actorId: string; reason: string; evidenceSha256?: string; now?: Date;
}) {
  const actorId = validActor(input.actorId), reason = validReason(input.reason);
  if (input.evidenceSha256 !== undefined && !SHA256.test(input.evidenceSha256)) throw bad("managed_agreement_invalid");
  const prior = await db.prepare("SELECT * FROM managed_service_commercial_agreements WHERE id=?").bind(input.agreementId).first<Record<string, unknown>>();
  if (!prior) throw new ManagedOfferingAdminError("managed_agreement_not_found", 404);
  if (prior.verification_status === "revoked") throw new ManagedOfferingAdminError("managed_agreement_revoked_create_new", 409);
  const evidence = input.evidenceSha256 ?? (prior.evidence_sha256 as string | null);
  if (!evidence) throw bad("managed_agreement_evidence_required");
  const nowMs = (input.now ?? new Date()).getTime();
  const updatedAt = Math.max(nowMs, Number(prior.updated_at) + 1);
  return commitAgreementWrite(db, input.agreementId, updatedAt,
    db.prepare(`UPDATE managed_service_commercial_agreements SET verification_status='approved',evidence_sha256=?,approved_by=?,approved_at=?,updated_at=?
      WHERE id=? AND updated_at=? AND verification_status!='revoked'`).bind(evidence, actorId, updatedAt, updatedAt, input.agreementId, prior.updated_at),
    prior, actorId, reason, "approved");
}

export async function revokeCommercialAgreement(db: D1Database, input: { agreementId: string; actorId: string; reason: string; now?: Date }) {
  const actorId = validActor(input.actorId), reason = validReason(input.reason);
  const prior = await db.prepare("SELECT * FROM managed_service_commercial_agreements WHERE id=?").bind(input.agreementId).first<Record<string, unknown>>();
  if (!prior) throw new ManagedOfferingAdminError("managed_agreement_not_found", 404);
  if (prior.verification_status === "revoked") return { saved: true, deduplicated: true, agreementId: input.agreementId, verificationStatus: "revoked" };
  const updatedAt = Math.max((input.now ?? new Date()).getTime(), Number(prior.updated_at) + 1);
  return commitAgreementWrite(db, input.agreementId, updatedAt,
    db.prepare("UPDATE managed_service_commercial_agreements SET verification_status='revoked',updated_at=? WHERE id=? AND updated_at=?")
      .bind(updatedAt, input.agreementId, prior.updated_at), prior, actorId, reason, "revoked");
}
