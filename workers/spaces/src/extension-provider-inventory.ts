export interface ProviderDependencyDeclaration {
  connection_id: string;
  provider: string;
  purpose: string;
  required: boolean;
}

export interface ProviderConnectionStatusRow {
  connection_id: string;
  provider: string;
  status: string;
  connected_at: string;
  last_verified_at: string | null;
}

/** Return only matching manifest declarations and non-secret connection lifecycle state. */
export function buildProviderDependencyInventory(declarations: readonly ProviderDependencyDeclaration[], rows: readonly ProviderConnectionStatusRow[]) {
  const declared = declarations.filter(item => item && typeof item.connection_id === "string"
    && /^[a-z][a-z0-9_.:-]{0,63}$/.test(item.connection_id) && typeof item.provider === "string"
    && /^[a-z][a-z0-9_.:-]{0,63}$/.test(item.provider) && typeof item.purpose === "string"
    && item.purpose.length <= 256 && typeof item.required === "boolean").slice(0, 64);
  const configured = rows.filter(row => declared.some(item => item.connection_id === row.connection_id && item.provider === row.provider)
    && ["active", "expired", "revoked", "error"].includes(row.status))
    .slice(0, 64).map(row => ({ connection_id: row.connection_id, provider: row.provider, status: row.status as "active" | "expired" | "revoked" | "error",
      connected_at: row.connected_at, last_verified_at: row.last_verified_at }));
  return { declared, configured };
}
