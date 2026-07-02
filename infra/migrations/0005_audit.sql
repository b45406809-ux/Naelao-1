-- Audit log (append-only)
CREATE TABLE IF NOT EXISTS audit_log (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  actor_id     TEXT,
  actor_type   TEXT NOT NULL DEFAULT 'user',
  event_type   TEXT NOT NULL,
  resource_type TEXT,
  resource_id  TEXT,
  event_data   TEXT NOT NULL DEFAULT '{}',
  ip_address   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_tenant ON audit_log(tenant_id);
CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_log(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
