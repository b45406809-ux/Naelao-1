-- G-AR01..AR05: Artifacts — files/outputs produced by agent runs (stored in R2)
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  run_id TEXT,
  name TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  r2_key TEXT NOT NULL,                      -- full R2 object key
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_artifacts_session ON artifacts (session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_artifacts_space ON artifacts (space_id, tenant_id, created_at DESC);
