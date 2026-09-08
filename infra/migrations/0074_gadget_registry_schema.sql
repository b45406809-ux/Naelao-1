-- Migration 0074: Gadget Registry and Scoping
CREATE TABLE IF NOT EXISTS gadget_instances (
  id TEXT PRIMARY KEY,
  manifest_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  tier INTEGER NOT NULL CHECK (tier IN (1, 2, 3)),
  space_id TEXT NOT NULL,
  project_id TEXT,             -- NULL for Tier 1
  owner_user_id TEXT,          -- NULL for Tier 2/3
  config_json TEXT DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'hibernating', 'archived')),
  storage_usage_bytes INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  
  -- Prevent duplicate installs of the same tool in the same scope
  UNIQUE(space_id, project_id, owner_user_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_gadget_lookup ON gadget_instances(space_id, project_id, owner_user_id);
