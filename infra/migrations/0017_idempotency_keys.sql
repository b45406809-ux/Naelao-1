-- G-IK01..IK03: Idempotency key store for safe request replay
CREATE TABLE IF NOT EXISTS idempotency_keys (
  id TEXT PRIMARY KEY,                       -- the idempotency key itself
  tenant_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,               -- 'api_call', 'billing', etc.
  status TEXT NOT NULL DEFAULT 'locked',     -- 'locked', 'completed', 'failed'
  request_hash TEXT NOT NULL,                -- SHA-256 of the request body
  response_json TEXT,
  error_code TEXT,
  expires_at TEXT NOT NULL,                  -- TTL: 24 hours from creation
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_ik_tenant ON idempotency_keys (tenant_id, resource_type);
CREATE INDEX IF NOT EXISTS idx_ik_expires ON idempotency_keys (expires_at)
  WHERE status != 'completed';
