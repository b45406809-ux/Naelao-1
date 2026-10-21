CREATE TABLE IF NOT EXISTS space_provisioning_leases (
  space_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  lease_token TEXT NOT NULL,
  lease_expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_space_provisioning_leases_expiry
  ON space_provisioning_leases (lease_expires_at);
