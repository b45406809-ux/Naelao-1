CREATE TABLE IF NOT EXISTS extension_publisher_keys (
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  publisher_id TEXT NOT NULL,
  key_id TEXT NOT NULL CHECK(length(key_id)=64),
  algorithm TEXT NOT NULL DEFAULT 'ECDSA_P256_SHA256' CHECK(algorithm='ECDSA_P256_SHA256'),
  public_key_b64url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_by TEXT,
  revoked_at TEXT,
  PRIMARY KEY(tenant_id,space_id,key_id),
  UNIQUE(tenant_id,space_id,publisher_id,key_id)
);

CREATE INDEX IF NOT EXISTS idx_extension_publisher_keys_status
  ON extension_publisher_keys(tenant_id,space_id,status,publisher_id);
