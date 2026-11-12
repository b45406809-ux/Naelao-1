import type { ManagedServiceCapabilityManifest } from "@naelao/types";

type CapabilityRow = {
  provider: string;
  service_id: string;
  version: number;
  category: string;
  operations_json: string;
  regions_json: string;
  account_modes_json: string;
  isolation_model: string;
  provisioning_json: string;
  metering_json: string;
  external_effects_json: string;
  evidence_json: string;
  status: "draft" | "verified" | "disabled";
  verified_by: string | null;
  verified_at: string | null;
  valid_until: string | null;
};

function parseList(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new Error("managed_service_capability_invalid");
  }
  return parsed;
}

function parseObject(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("managed_service_capability_invalid");
  }
  return parsed as Record<string, unknown>;
}

function validEvidence(value: unknown, now: Date): value is ManagedServiceCapabilityManifest["evidence"] {
  return Array.isArray(value) && value.length > 0 && value.length <= 30 && value.every((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const item = entry as Record<string, unknown>;
    if (typeof item.url !== "string" || typeof item.checkedAt !== "string") return false;
    try {
      const url = new URL(item.url);
      const checkedAt = Date.parse(item.checkedAt);
      return url.protocol === "https:" && !url.username && !url.password && Number.isFinite(checkedAt)
        && checkedAt <= now.getTime() + 60_000
        && (item.note === undefined || (typeof item.note === "string" && item.note.length <= 500));
    } catch { return false; }
  });
}

async function sha256(value: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function verifyManagedServiceCapability(
  db: D1Database,
  input: {
    provider: string;
    serviceId: string;
    version: number;
    actorId: string;
    reason: string;
    validUntil: string;
    regions: string[];
    evidence: unknown;
    metering: Record<string, unknown>;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const until = Date.parse(input.validUntil);
  if (!/^[a-z][a-z0-9_-]{1,62}$/.test(input.provider) || !/^[a-z][a-z0-9_.:-]{1,127}$/.test(input.serviceId)
    || !Number.isSafeInteger(input.version) || input.version < 1 || !/^[A-Za-z0-9._:@-]{1,160}$/.test(input.actorId)
    || input.reason.trim().length < 10 || input.reason.length > 500 || !Number.isFinite(until)
    || until <= now.getTime() || until > now.getTime() + 180 * 86_400_000
    || !input.regions.length || input.regions.length > 50
    || input.regions.some((region) => !/^[a-z0-9][a-z0-9-]{0,31}$/.test(region))
    || new Set(input.regions).size !== input.regions.length
    || !validEvidence(input.evidence, now)
    || typeof input.metering.priceVersion !== "string" || !/^[A-Za-z0-9._:-]{1,100}$/.test(input.metering.priceVersion)
    || typeof input.metering.chargeModel !== "string" || input.metering.chargeModel.length > 120) {
    throw new Error("managed_service_capability_verification_invalid");
  }
  const prior = await db.prepare(`SELECT status,operations_json,account_modes_json,isolation_model,external_effects_json
    FROM managed_service_capability_versions WHERE provider=? AND service_id=? AND version=?`)
    .bind(input.provider, input.serviceId, input.version)
    .first<{status:string;operations_json:string;account_modes_json:string;isolation_model:string;external_effects_json:string}>();
  if (!prior) throw new Error("managed_service_capability_not_found");
  if (prior.status === "disabled") throw new Error("managed_service_capability_disabled_create_new_version");
  try {
    if (!parseList(prior.operations_json).length || !parseList(prior.account_modes_json).length
      || !prior.isolation_model.trim() || !parseList(prior.external_effects_json)) {
      throw new Error("invalid");
    }
  } catch { throw new Error("managed_service_capability_invalid"); }
  const evidence = JSON.stringify(input.evidence);
  const evidenceHash = await sha256(evidence);
  const metering = JSON.stringify(input.metering);
  const at = now.toISOString();
  const auditId = `msa_${crypto.randomUUID().replaceAll("-", "")}`;
  const result = await db.batch([
    db.prepare(`UPDATE managed_service_capability_versions SET regions_json=?,evidence_json=?,metering_json=?,status='verified',
      verified_by=?,verified_at=?,valid_until=?,updated_at=? WHERE provider=? AND service_id=? AND version=? AND status IN ('draft','verified')`)
      .bind(JSON.stringify(input.regions), evidence, metering, input.actorId, at, new Date(until).toISOString(), at, input.provider, input.serviceId, input.version),
    db.prepare(`INSERT INTO managed_service_capability_audit(id,provider,service_id,version,action,actor_id,reason,evidence_sha256,created_at)
      SELECT ?,?,?,?,'verified',?,?,?,? WHERE EXISTS(SELECT 1 FROM managed_service_capability_versions WHERE provider=? AND service_id=? AND version=? AND status='verified' AND verified_at=?)`)
      .bind(auditId, input.provider, input.serviceId, input.version, input.actorId, input.reason.trim(), evidenceHash, at,
        input.provider, input.serviceId, input.version, at),
  ]);
  if (!result[0]?.meta.changes || !result[1]?.meta.changes) throw new Error("managed_service_capability_verification_conflict");
  return { verified: true, provider: input.provider, serviceId: input.serviceId, version: input.version, validUntil: new Date(until).toISOString() };
}

export async function disableManagedServiceCapability(
  db: D1Database,
  input: { provider: string; serviceId: string; version: number; actorId: string; reason: string; now?: Date },
) {
  if (!/^[A-Za-z0-9._:@-]{1,160}$/.test(input.actorId) || input.reason.trim().length < 10 || input.reason.length > 500) {
    throw new Error("managed_service_capability_disable_invalid");
  }
  const now = input.now ?? new Date();
  const prior = await db.prepare("SELECT evidence_json,status FROM managed_service_capability_versions WHERE provider=? AND service_id=? AND version=?")
    .bind(input.provider,input.serviceId,input.version).first<{evidence_json:string;status:string}>();
  if (!prior) throw new Error("managed_service_capability_not_found");
  if (prior.status === "disabled") return { disabled: true, deduplicated: true };
  const at = now.toISOString();
  const auditId = `msa_${crypto.randomUUID().replaceAll("-", "")}`;
  const evidenceHash = await sha256(prior.evidence_json);
  const result = await db.batch([
    db.prepare("UPDATE managed_service_capability_versions SET status='disabled',updated_at=? WHERE provider=? AND service_id=? AND version=? AND status IN ('draft','verified')")
      .bind(at,input.provider,input.serviceId,input.version),
    db.prepare(`INSERT INTO managed_service_capability_audit(id,provider,service_id,version,action,actor_id,reason,evidence_sha256,created_at)
      SELECT ?,?,?,?,'disabled',?,?,?,? WHERE EXISTS(SELECT 1 FROM managed_service_capability_versions WHERE provider=? AND service_id=? AND version=? AND status='disabled' AND updated_at=?)`)
      .bind(auditId,input.provider,input.serviceId,input.version,input.actorId,input.reason.trim(),evidenceHash,at,input.provider,input.serviceId,input.version,at),
  ]);
  if (!result[0]?.meta.changes || !result[1]?.meta.changes) throw new Error("managed_service_capability_disable_conflict");
  return { disabled: true, provider: input.provider, serviceId: input.serviceId, version: input.version };
}

/** Select the newest operator-verified manifest and fail closed on missing evidence or region. */
export async function requireManagedServiceCapability(
  db: D1Database,
  input: {
    provider: string;
    serviceId: string;
    operation: string;
    connectionMode: "naelao_managed" | "user_connected" | "provider_managed";
    region?: string;
    now?: Date;
  },
): Promise<ManagedServiceCapabilityManifest> {
  const row = await db.prepare(`SELECT provider,service_id,version,category,operations_json,regions_json,
      account_modes_json,isolation_model,provisioning_json,metering_json,external_effects_json,evidence_json,
      status,verified_by,verified_at,valid_until
    FROM managed_service_capability_versions WHERE provider=? AND service_id=? ORDER BY version DESC LIMIT 1`)
    .bind(input.provider, input.serviceId).first<CapabilityRow>();
  if (!row || row.status !== "verified" || !row.verified_by || !row.verified_at) {
    throw new Error("managed_service_capability_unverified");
  }
  const now = input.now ?? new Date();
  if (!row.valid_until || !Number.isFinite(Date.parse(row.valid_until)) || Date.parse(row.valid_until) <= now.getTime()) {
    throw new Error("managed_service_capability_expired");
  }

  let operations: string[], regions: string[], connectionModes: string[], externalEffects: string[];
  let provisioning: Record<string, unknown>, metering: Record<string, unknown>, evidence: unknown;
  try {
    operations = parseList(row.operations_json);
    regions = parseList(row.regions_json);
    connectionModes = parseList(row.account_modes_json);
    externalEffects = parseList(row.external_effects_json);
    provisioning = parseObject(row.provisioning_json);
    metering = parseObject(row.metering_json);
    evidence = JSON.parse(row.evidence_json);
  } catch {
    throw new Error("managed_service_capability_invalid");
  }
  if (!Array.isArray(evidence) || evidence.length === 0) throw new Error("managed_service_capability_evidence_missing");
  if (!operations.includes(input.operation) || !connectionModes.includes(input.connectionMode)) {
    throw new Error("managed_service_operation_not_verified");
  }
  if (!input.region || !regions.includes(input.region)) throw new Error("managed_service_region_not_verified");

  return {
    provider: row.provider,
    serviceId: row.service_id,
    version: row.version,
    category: row.category,
    operations,
    regions,
    connectionModes: connectionModes as ManagedServiceCapabilityManifest["connectionModes"],
    isolationModel: row.isolation_model,
    provisioning,
    metering,
    externalEffects,
    evidence: evidence as ManagedServiceCapabilityManifest["evidence"],
    status: row.status,
    verifiedBy: row.verified_by,
    verifiedAt: row.verified_at,
    validUntil: row.valid_until,
  };
}
