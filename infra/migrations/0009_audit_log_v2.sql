-- Audit log v2 — complete schema with all required columns
CREATE TABLE IF NOT EXISTS audit_log (
  id            TEXT PRIMARY KEY,
  event_type    TEXT NOT NULL,
  actor_id      TEXT NOT NULL,
  actor_role    TEXT,
  resource_type TEXT NOT NULL,
  resource_id   TEXT NOT NULL,
  action        TEXT NOT NULL DEFAULT 'unknown',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  ip            TEXT,
  user_agent    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_log(resource_type, resource_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_event ON audit_log(event_type, created_at DESC);
