type CostDatabase = Pick<D1Database, "prepare">;

export interface ProviderApiCostObservationInput {
  tenantId: string;
  spaceId: string;
  projectId?: string | null;
  provider: string;
  serviceId: string;
  operationRef: string;
  accountRef: string;
  usageKind: "compute" | "idle" | "storage" | "network" | "request" | "model" | "voice" | "sms" | "email" | "other";
  quantityUnit: string;
  quantityMicros: number;
  providerCost: string;
  currency: string;
  periodStart: string;
  sourceApi: string;
  observedAt?: string;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const REF = /^[^\u0000-\u001f\u007f]{3,512}$/;

/** Convert decimal provider amounts to integer micros with half-up rounding. */
export function providerCostToMicros(amount: string): number {
  const match = /^(\d{1,12})(?:\.(\d{1,12}))?$/.exec(amount);
  if (!match) throw new Error("provider_cost_amount_invalid");
  const fraction = (match[2] ?? "").padEnd(7, "0");
  const micros = BigInt(match[1]!) * 1_000_000n + BigInt(fraction.slice(0, 6)) + (fraction[6]! >= "5" ? 1n : 0n);
  if (micros > 9_000_000_000_000n) throw new Error("provider_cost_amount_limit");
  return Number(micros);
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Store an API-observed cost without provider account, operation, phone number, or content refs. */
export async function recordProviderApiCostObservation(db: CostDatabase, input: ProviderApiCostObservationInput) {
  if (!ID.test(input.tenantId) || !ID.test(input.spaceId) || (input.projectId != null && !ID.test(input.projectId))
    || !/^[a-z][a-z0-9_-]{1,63}$/.test(input.provider) || !/^[a-z][a-z0-9_.:-]{1,128}$/.test(input.serviceId)
    || !REF.test(input.operationRef) || !REF.test(input.accountRef)
    || !["compute", "idle", "storage", "network", "request", "model", "voice", "sms", "email", "other"].includes(input.usageKind)
    || !/^[a-z][a-z0-9_:-]{0,31}$/.test(input.quantityUnit) || !Number.isSafeInteger(input.quantityMicros)
    || input.quantityMicros < 0 || !/^[A-Z]{3}$/.test(input.currency) || !/^[a-z][a-z0-9_.:/-]{1,127}$/.test(input.sourceApi)
    || !Number.isFinite(Date.parse(input.periodStart))) throw new Error("provider_cost_observation_invalid");

  const periodStart = new Date(input.periodStart).toISOString();
  const periodEnd = new Date(Date.parse(periodStart) + 1).toISOString();
  const observedAt = input.observedAt ? new Date(input.observedAt).toISOString() : new Date().toISOString();
  const providerCostMicros = providerCostToMicros(input.providerCost);
  const [operationHash, accountHash, evidenceHash] = await Promise.all([
    sha256(input.operationRef), sha256(input.accountRef),
    sha256(JSON.stringify([input.tenantId, input.spaceId, input.projectId ?? null, input.provider, input.serviceId,
      input.operationRef, input.accountRef, input.usageKind, input.quantityUnit, periodStart,
      input.quantityMicros, providerCostMicros, input.currency, input.sourceApi])),
  ]);
  const id = `mspo_${await sha256(`${input.tenantId}\0${input.provider}\0${input.serviceId}\0${evidenceHash}`)}`;
  const result = await db.prepare(`INSERT OR IGNORE INTO managed_service_provider_cost_observations(
    id,tenant_id,space_id,project_id,provider,service_id,operation_ref_sha256,account_ref_sha256,usage_kind,
    quantity_unit,period_start,period_end,quantity_micros,provider_cost_micros,currency,evidence_sha256,source_api,observed_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(id,input.tenantId,input.spaceId,input.projectId ?? null,input.provider,input.serviceId,operationHash,accountHash,input.usageKind,
      input.quantityUnit,periodStart,periodEnd,input.quantityMicros,providerCostMicros,input.currency,evidenceHash,input.sourceApi,observedAt).run();
  const prior = await db.prepare(`SELECT tenant_id,space_id,project_id,provider,service_id,operation_ref_sha256,account_ref_sha256,
      usage_kind,quantity_unit,period_start,period_end,quantity_micros,provider_cost_micros,currency,evidence_sha256,source_api
    FROM managed_service_provider_cost_observations WHERE id=?`).bind(id).first<Record<string, unknown>>();
  if (!prior || prior.tenant_id !== input.tenantId || prior.space_id !== input.spaceId || prior.project_id !== (input.projectId ?? null)
    || prior.provider !== input.provider || prior.service_id !== input.serviceId || prior.operation_ref_sha256 !== operationHash
    || prior.account_ref_sha256 !== accountHash || prior.usage_kind !== input.usageKind || prior.quantity_unit !== input.quantityUnit
    || prior.period_start !== periodStart || prior.period_end !== periodEnd || Number(prior.quantity_micros) !== input.quantityMicros
    || Number(prior.provider_cost_micros) !== providerCostMicros || prior.currency !== input.currency
    || prior.evidence_sha256 !== evidenceHash || prior.source_api !== input.sourceApi) {
    throw new Error("provider_cost_observation_conflict");
  }
  return { inserted: result.meta.changes === 1, replayed: result.meta.changes !== 1, provenance: "provider_api_observed" as const,
    providerCostMicros, currency: input.currency };
}

/** Read one exact minimized provider receipt without returning its hashed references. */
export async function getProviderApiCostObservation(db: CostDatabase, input: Pick<ProviderApiCostObservationInput,
  "tenantId" | "spaceId" | "projectId" | "provider" | "serviceId" | "operationRef" | "accountRef" | "usageKind" | "sourceApi">) {
  if (!ID.test(input.tenantId) || !ID.test(input.spaceId) || (input.projectId != null && !ID.test(input.projectId))
    || !/^[a-z][a-z0-9_-]{1,63}$/.test(input.provider) || !/^[a-z][a-z0-9_.:-]{1,128}$/.test(input.serviceId)
    || !REF.test(input.operationRef) || !REF.test(input.accountRef)
    || !["compute", "idle", "storage", "network", "request", "model", "voice", "sms", "email", "other"].includes(input.usageKind)
    || !/^[a-z][a-z0-9_.:/-]{1,127}$/.test(input.sourceApi)) throw new Error("provider_cost_observation_lookup_invalid");
  const [operationHash, accountHash] = await Promise.all([sha256(input.operationRef), sha256(input.accountRef)]);
  const row = await db.prepare(`SELECT provider_cost_micros,currency FROM managed_service_provider_cost_observations
    WHERE tenant_id=? AND space_id=? AND project_id IS ? AND provider=? AND service_id=?
      AND operation_ref_sha256=? AND account_ref_sha256=? AND usage_kind=? AND source_api=?
    ORDER BY observed_at DESC,id LIMIT 1`)
    .bind(input.tenantId, input.spaceId, input.projectId ?? null, input.provider, input.serviceId,
      operationHash, accountHash, input.usageKind, input.sourceApi)
    .first<{ provider_cost_micros: number; currency: string }>();
  const amount = row ? Number(row.provider_cost_micros) : NaN;
  if (!row || !Number.isSafeInteger(amount) || amount < 0 || !/^[A-Z]{3}$/.test(row.currency))
    return { status: "unknown" as const, provider_cost_micros: null, currency: null, provenance: null };
  return { status: "reported" as const, provider_cost_micros: amount, currency: row.currency,
    provenance: "provider_api_observed" as const };
}
