-- G-FF01..FF04: Feature flags with percentage-based rollout
CREATE TABLE IF NOT EXISTS feature_flags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  rollout_pct INTEGER NOT NULL DEFAULT 0,    -- 0-100 percentage rollout
  overrides_json TEXT DEFAULT '{}',          -- {"tenantId": true/false} manual overrides
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ff_name ON feature_flags (name, enabled);
