-- G-DO01..DO03: Durable Object name registry — tracks DO name → tenantId mappings
CREATE TABLE IF NOT EXISTS do_registry (
  do_name TEXT PRIMARY KEY,                  -- HMAC-SHA256 derived DO name
  do_type TEXT NOT NULL,                     -- 'SpaceDO', 'AgentDO', 'SessionDO', etc.
  tenant_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,                 -- the original resource ID
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_active_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_dor_tenant ON do_registry (tenant_id, do_type);
CREATE INDEX IF NOT EXISTS idx_dor_resource ON do_registry (do_type, resource_id);
