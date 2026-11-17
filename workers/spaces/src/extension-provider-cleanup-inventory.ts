export interface ProviderCleanupReceiptRow {
  provider: string;
  operation_kind: string;
  status: string;
  attempt_count: number;
  last_attempt_at: string | null;
  updated_at: string;
}

const PROVIDERS = new Set(["slack", "telegram", "whatsapp"]);

/** Return only bounded receipt fields suitable for the owner resource inventory. */
export function buildProviderCleanupInventory(rows: readonly ProviderCleanupReceiptRow[]) {
  return rows.slice(0, 30).map(row => ({
    provider: PROVIDERS.has(row.provider) ? row.provider : "other",
    operation: row.operation_kind === "setup" ? "setup" as const : "cleanup" as const,
    status: row.status === "complete" ? "complete" as const
      : row.status === "not_supported" ? "not_supported" as const : "pending" as const,
    attempts: Number.isSafeInteger(row.attempt_count) ? Math.max(0, Math.min(row.attempt_count, 1_000_000)) : 0,
    last_attempt_at: row.last_attempt_at,
    updated_at: row.updated_at,
  }));
}
