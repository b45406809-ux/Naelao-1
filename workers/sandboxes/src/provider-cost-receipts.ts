export type CostReceiptProvider = "agent37" | "opensandbox" | "cloudflare";
export type CostReceiptKind = "compute" | "idle" | "storage" | "network" | "other";

export interface ProviderCostReceiptInput {
  provider: CostReceiptProvider;
  statementRef: string;
  receiptRef: string;
  accountRef: string;
  allocationRef?: string;
  usageKind: CostReceiptKind;
  periodStart: string;
  periodEnd: string;
  quantityMicros: number;
  providerCostMicros: number;
  currency: string;
  evidenceSha256: string;
}

export interface ProviderCostReceiptResult { inserted: number; replayed: number; provenance: "operator_imported"; }

const PROVIDERS = new Set<CostReceiptProvider>(["agent37", "opensandbox", "cloudflare"]);
const KINDS = new Set<CostReceiptKind>(["compute", "idle", "storage", "network", "other"]);

export async function recordProviderCostReceipts(
  db: Pick<D1Database, "prepare" | "batch">,
  input: { tenantId: string; actorId: string; receipts: ProviderCostReceiptInput[]; importedAt?: string },
): Promise<ProviderCostReceiptResult> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(input.tenantId) || !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/.test(input.actorId)
      || !Array.isArray(input.receipts) || input.receipts.length < 1 || input.receipts.length > 200) throw new Error("provider_cost_receipts_invalid");
  const importedAt = input.importedAt ?? new Date().toISOString();
  const normalized = await Promise.all(input.receipts.map(async receipt => {
    if (!PROVIDERS.has(receipt.provider) || !KINDS.has(receipt.usageKind) ||
        !validRef(receipt.statementRef) || !validRef(receipt.receiptRef) || !validRef(receipt.accountRef) ||
        (receipt.allocationRef !== undefined && !validRef(receipt.allocationRef)) ||
        !validPeriod(receipt.periodStart) || !validPeriod(receipt.periodEnd) || Date.parse(receipt.periodStart) >= Date.parse(receipt.periodEnd) ||
        !validMicros(receipt.quantityMicros) || !validMicros(receipt.providerCostMicros) || !/^[A-Z]{3}$/.test(receipt.currency) ||
        !/^[a-f0-9]{64}$/.test(receipt.evidenceSha256)) throw new Error("provider_cost_receipt_invalid");
    const statementHash = await sha256(receipt.statementRef), receiptHash = await sha256(receipt.receiptRef), accountHash = await sha256(receipt.accountRef);
    const allocationHash = receipt.allocationRef ? await sha256(receipt.allocationRef) : null;
    const id = `pcr_${await sha256(`${input.tenantId}\0${receipt.provider}\0${statementHash}\0${receiptHash}`)}`;
    return { receipt, id, statementHash, receiptHash, accountHash, allocationHash };
  }));
  const unique = new Set(normalized.map(item => item.id));
  if (unique.size !== normalized.length) throw new Error("provider_cost_receipt_duplicate_in_batch");
  const result = await db.batch(normalized.map(item => db.prepare(`INSERT OR IGNORE INTO sandbox_provider_cost_receipts(
    id,tenant_id,provider,statement_ref_hash,receipt_ref_hash,account_ref_hash,allocation_ref_hash,usage_kind,period_start,period_end,
    quantity_micros,provider_cost_micros,currency,evidence_sha256,provenance,imported_by,imported_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'operator_imported',?,?)`).bind(item.id,input.tenantId,item.receipt.provider,item.statementHash,
      item.receiptHash,item.accountHash,item.allocationHash,item.receipt.usageKind,item.receipt.periodStart,item.receipt.periodEnd,
      item.receipt.quantityMicros,item.receipt.providerCostMicros,item.receipt.currency,item.receipt.evidenceSha256,input.actorId,importedAt)));
  let inserted = 0;
  for (let index = 0; index < normalized.length; index++) {
    const item = normalized[index]!;
    const row = await db.prepare(`SELECT account_ref_hash,allocation_ref_hash,usage_kind,period_start,period_end,quantity_micros,provider_cost_micros,currency,evidence_sha256
      FROM sandbox_provider_cost_receipts WHERE id=? AND tenant_id=?`).bind(item.id,input.tenantId)
      .first<Record<string,unknown>>();
    if (!row || row.account_ref_hash !== item.accountHash || row.allocation_ref_hash !== item.allocationHash || row.usage_kind !== item.receipt.usageKind ||
        row.period_start !== item.receipt.periodStart || row.period_end !== item.receipt.periodEnd || Number(row.quantity_micros) !== item.receipt.quantityMicros ||
        Number(row.provider_cost_micros) !== item.receipt.providerCostMicros || row.currency !== item.receipt.currency || row.evidence_sha256 !== item.receipt.evidenceSha256)
      throw new Error("provider_cost_receipt_conflict");
    inserted += result[index]?.meta.changes ?? 0;
  }
  return { inserted, replayed: normalized.length - inserted, provenance: "operator_imported" };
}

export async function summarizeProviderCostReceipts(
  db: Pick<D1Database, "prepare">,
  input: { tenantId: string; provider: CostReceiptProvider; periodStart: string; periodEnd: string; currency: string },
) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(input.tenantId) || !PROVIDERS.has(input.provider) ||
      !validPeriod(input.periodStart) || !validPeriod(input.periodEnd) || Date.parse(input.periodStart) >= Date.parse(input.periodEnd) || !/^[A-Z]{3}$/.test(input.currency))
    throw new Error("provider_cost_summary_invalid");
  const rows = await db.prepare(`SELECT usage_kind,COUNT(*) AS receipt_count,SUM(quantity_micros) AS quantity_micros,
      SUM(provider_cost_micros) AS provider_cost_micros,COUNT(DISTINCT statement_ref_hash) AS statement_count
    FROM sandbox_provider_cost_receipts WHERE tenant_id=? AND provider=? AND currency=? AND period_start>=? AND period_end<=? GROUP BY usage_kind`)
    .bind(input.tenantId,input.provider,input.currency,input.periodStart,input.periodEnd).all<Record<string,unknown>>();
  return { provider: input.provider, periodStart: input.periodStart, periodEnd: input.periodEnd, currency: input.currency,
    provenance: "operator_imported" as const, usage: (rows.results ?? []).map(row => ({ kind: row.usage_kind, receiptCount: Number(row.receipt_count),
      quantityMicros: Number(row.quantity_micros ?? 0), providerCostMicros: Number(row.provider_cost_micros ?? 0), statementCount: Number(row.statement_count) })) };
}

function validRef(value: string): boolean { return typeof value === "string" && value.length >= 3 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value); }
function validMicros(value: number): boolean { return Number.isSafeInteger(value) && value >= 0 && value <= 9_000_000_000_000; }
function validPeriod(value: string): boolean { return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value)); }
async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2,"0")).join("");
}
