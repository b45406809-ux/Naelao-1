export type ManagedProviderCostKind = "compute" | "idle" | "storage" | "network" | "request" | "model" | "voice" | "sms" | "email" | "other";

export interface ManagedProviderCostReceiptInput {
  provider: string;
  serviceId: string;
  statementRef: string;
  receiptRef: string;
  accountRef: string;
  operationRef?: string;
  allocationRef?: string;
  usageKind: ManagedProviderCostKind;
  quantityUnit: string;
  periodStart: string;
  periodEnd: string;
  quantityMicros: number;
  providerCostMicros: number;
  currency: string;
  evidenceSha256: string;
}

export async function recordManagedProviderCostReceipts(
  db: Pick<D1Database, "prepare" | "batch">,
  input: { tenantId: string; spaceId: string; projectId?: string | null; actorId: string; receipts: ManagedProviderCostReceiptInput[]; importedAt?: string },
) {
  if (!validId(input.tenantId) || !validId(input.spaceId) || (input.projectId != null && !validId(input.projectId))
    || !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/.test(input.actorId)
    || !Array.isArray(input.receipts) || input.receipts.length < 1 || input.receipts.length > 200) {
    throw new Error("managed_provider_cost_receipts_invalid");
  }
  const importedAt = input.importedAt ?? new Date().toISOString();
  const entries = await Promise.all(input.receipts.map(async receipt => {
    if (!/^[a-z][a-z0-9_-]{1,63}$/.test(receipt.provider) || !/^[a-z][a-z0-9_.:-]{1,128}$/.test(receipt.serviceId)
      || !validRef(receipt.statementRef) || !validRef(receipt.receiptRef) || !validRef(receipt.accountRef)
      || (receipt.operationRef !== undefined && !validRef(receipt.operationRef))
      || (receipt.allocationRef !== undefined && !validRef(receipt.allocationRef))
      || !KINDS.has(receipt.usageKind) || !/^[a-z][a-z0-9_:-]{0,31}$/.test(receipt.quantityUnit)
      || !validDate(receipt.periodStart) || !validDate(receipt.periodEnd) || Date.parse(receipt.periodStart) >= Date.parse(receipt.periodEnd)
      || !validMicros(receipt.quantityMicros) || !validMicros(receipt.providerCostMicros) || !/^[A-Z]{3}$/.test(receipt.currency)
      || !/^[a-f0-9]{64}$/.test(receipt.evidenceSha256)) throw new Error("managed_provider_cost_receipt_invalid");
    const [statementHash, receiptHash, accountHash, operationHash, allocationHash] = await Promise.all([
      sha256(receipt.statementRef), sha256(receipt.receiptRef), sha256(receipt.accountRef),
      receipt.operationRef ? sha256(receipt.operationRef) : Promise.resolve(null),
      receipt.allocationRef ? sha256(receipt.allocationRef) : Promise.resolve(null),
    ]);
    const id = `mscr_${await sha256(`${input.tenantId}\0${receipt.provider}\0${receipt.serviceId}\0${statementHash}\0${receiptHash}`)}`;
    return { id, receipt, statementHash, receiptHash, accountHash, operationHash, allocationHash };
  }));
  if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error("managed_provider_cost_receipt_duplicate_in_batch");

  const inserts = entries.map(({ id, receipt, statementHash, receiptHash, accountHash, operationHash, allocationHash }) =>
    db.prepare(`INSERT OR IGNORE INTO managed_service_provider_cost_receipts(
      id,tenant_id,space_id,project_id,provider,service_id,operation_ref_hash,statement_ref_hash,receipt_ref_hash,
      account_ref_hash,allocation_ref_hash,usage_kind,quantity_unit,period_start,period_end,quantity_micros,
      provider_cost_micros,currency,evidence_sha256,provenance,imported_by,imported_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'operator_imported',?,?)`)
      .bind(id,input.tenantId,input.spaceId,input.projectId ?? null,receipt.provider,receipt.serviceId,operationHash,statementHash,receiptHash,
        accountHash,allocationHash,receipt.usageKind,receipt.quantityUnit,receipt.periodStart,receipt.periodEnd,receipt.quantityMicros,
        receipt.providerCostMicros,receipt.currency,receipt.evidenceSha256,input.actorId,importedAt));
  const writeResults = await db.batch(inserts);
  let inserted = 0;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    const row = await db.prepare(`SELECT tenant_id,space_id,project_id,provider,service_id,operation_ref_hash,statement_ref_hash,receipt_ref_hash,
        account_ref_hash,allocation_ref_hash,usage_kind,quantity_unit,period_start,period_end,quantity_micros,provider_cost_micros,currency,evidence_sha256
      FROM managed_service_provider_cost_receipts WHERE id=?`).bind(entry.id).first<Record<string, unknown>>();
    const receipt = entry.receipt;
    if (!row || row.tenant_id !== input.tenantId || row.space_id !== input.spaceId || row.project_id !== (input.projectId ?? null)
      || row.provider !== receipt.provider || row.service_id !== receipt.serviceId || row.operation_ref_hash !== entry.operationHash
      || row.statement_ref_hash !== entry.statementHash || row.receipt_ref_hash !== entry.receiptHash || row.account_ref_hash !== entry.accountHash
      || row.allocation_ref_hash !== entry.allocationHash || row.usage_kind !== receipt.usageKind || row.quantity_unit !== receipt.quantityUnit
      || row.period_start !== receipt.periodStart || row.period_end !== receipt.periodEnd || Number(row.quantity_micros) !== receipt.quantityMicros
      || Number(row.provider_cost_micros) !== receipt.providerCostMicros || row.currency !== receipt.currency || row.evidence_sha256 !== receipt.evidenceSha256) {
      throw new Error("managed_provider_cost_receipt_conflict");
    }
    inserted += writeResults[index]?.meta.changes ?? 0;
  }
  return { inserted, replayed: entries.length - inserted, provenance: "operator_imported" as const };
}

export async function summarizeManagedProviderCostReceipts(
  db: Pick<D1Database, "prepare">,
  input: { tenantId: string; spaceId?: string; provider: string; serviceId?: string; periodStart: string; periodEnd: string; currency: string },
) {
  if (!validId(input.tenantId) || (input.spaceId !== undefined && !validId(input.spaceId)) || !/^[a-z][a-z0-9_-]{1,63}$/.test(input.provider)
    || (input.serviceId !== undefined && !/^[a-z][a-z0-9_.:-]{1,128}$/.test(input.serviceId))
    || !validDate(input.periodStart) || !validDate(input.periodEnd) || Date.parse(input.periodStart) >= Date.parse(input.periodEnd)
    || !/^[A-Z]{3}$/.test(input.currency)) throw new Error("managed_provider_cost_summary_invalid");
  const result = await db.prepare(`SELECT service_id,usage_kind,quantity_unit,COUNT(*) AS receipt_count,
      SUM(quantity_micros) AS quantity_micros,SUM(provider_cost_micros) AS provider_cost_micros,
      COUNT(DISTINCT statement_ref_hash) AS statement_count
    FROM managed_service_provider_cost_receipts WHERE tenant_id=? AND (? IS NULL OR space_id=?)
      AND provider=? AND (? IS NULL OR service_id=?) AND currency=? AND period_start>=? AND period_end<=?
    GROUP BY service_id,usage_kind,quantity_unit ORDER BY service_id,usage_kind,quantity_unit`)
    .bind(input.tenantId,input.spaceId ?? null,input.spaceId ?? null,input.provider,input.serviceId ?? null,input.serviceId ?? null,
      input.currency,input.periodStart,input.periodEnd).all<Record<string, unknown>>();
  return { provider: input.provider, ...(input.serviceId ? { serviceId: input.serviceId } : {}), periodStart: input.periodStart,
    periodEnd: input.periodEnd, currency: input.currency, provenance: "operator_imported" as const,
    usage: result.results.map(row => ({ serviceId: row.service_id, kind: row.usage_kind, quantityUnit: row.quantity_unit,
      receiptCount: Number(row.receipt_count), quantityMicros: Number(row.quantity_micros ?? 0),
      providerCostMicros: Number(row.provider_cost_micros ?? 0), statementCount: Number(row.statement_count) })) };
}

const KINDS = new Set<ManagedProviderCostKind>(["compute","idle","storage","network","request","model","voice","sms","email","other"]);
function validId(value: string): boolean { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value); }
function validRef(value: string): boolean { return typeof value === "string" && value.length >= 3 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value); }
function validMicros(value: number): boolean { return Number.isSafeInteger(value) && value >= 0 && value <= 9_000_000_000_000; }
function validDate(value: string): boolean { return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value)); }
async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
