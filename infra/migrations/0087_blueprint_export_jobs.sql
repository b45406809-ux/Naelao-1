CREATE TABLE IF NOT EXISTS blueprint_export_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  artifact_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
