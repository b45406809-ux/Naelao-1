export type SandboxBillingProvider = "agent37" | "opensandbox" | "cloudflare";
export interface SandboxBillingReconciliationInput {
  tenantId: string;
  provider: SandboxBillingProvider;
  periodStart: string;
  periodEnd: string;
  statementRef: string;
  measuredMicros: number;
  providerMicros: number;
}
export interface SandboxBillingReconciliationResult {
  id: string;
  status: "matched" | "variance";
  varianceMicros: number;
  replay: boolean;
}

/** Store an immutable invoice comparison. Variance is escalated for manual review and never
 * converted into a charge, credit, or provider-side retry automatically. */
export async function recordSandboxBillingReconciliation(
  db: Pick<D1Database, "prepare">,
  input: SandboxBillingReconciliationInput,
  observedAt = new Date().toISOString(),
): Promise<SandboxBillingReconciliationResult> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(input.tenantId) ||
      !["agent37", "opensandbox", "cloudflare"].includes(input.provider) ||
      !validPeriod(input.periodStart) || !validPeriod(input.periodEnd) ||
      Date.parse(input.periodStart) >= Date.parse(input.periodEnd) ||
      typeof input.statementRef !== "string" || input.statementRef.length < 8 || input.statementRef.length > 512 ||
      !validMicros(input.measuredMicros) || !validMicros(input.providerMicros)) {
    throw new Error("sandbox_billing_reconciliation_invalid");
  }
  const statementHash = await sha256(input.statementRef);
  const id = `sbill_${await sha256(`${input.tenantId}\0${input.provider}\0${input.periodStart}\0${input.periodEnd}\0${statementHash}`)}`;
  const varianceMicros = input.providerMicros - input.measuredMicros;
  const status = varianceMicros === 0 ? "matched" : "variance";
  const inserted = await db.prepare(
    `INSERT OR IGNORE INTO sandbox_billing_reconciliations
      (id,tenant_id,provider,period_start,period_end,statement_ref_hash,measured_micros,provider_micros,variance_micros,currency,status,observed_at)
     VALUES (?,?,?,?,?,?,?,?,?,'USD',?,?)`,
  ).bind(id, input.tenantId, input.provider, input.periodStart, input.periodEnd, statementHash,
    input.measuredMicros, input.providerMicros, varianceMicros, status, observedAt).run();
  const row = await db.prepare(
    `SELECT id,measured_micros,provider_micros,variance_micros,status FROM sandbox_billing_reconciliations
      WHERE tenant_id=? AND provider=? AND period_start=? AND period_end=? AND statement_ref_hash=?`,
  ).bind(input.tenantId, input.provider, input.periodStart, input.periodEnd, statementHash).first<{
    id: string; measured_micros: number; provider_micros: number; variance_micros: number; status: "matched" | "variance";
  }>();
  if (!row || row.measured_micros !== input.measuredMicros || row.provider_micros !== input.providerMicros || row.variance_micros !== varianceMicros) {
    throw new Error("sandbox_billing_statement_conflict");
  }
  return { id: row.id, status: row.status, varianceMicros: row.variance_micros, replay: inserted.meta.changes === 0 };
}

function validMicros(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 9_000_000_000_000;
}
function validPeriod(value: string): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && value.length <= 40;
}
async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
