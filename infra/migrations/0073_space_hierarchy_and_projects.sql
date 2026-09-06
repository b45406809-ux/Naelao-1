-- Migration: 0073_space_hierarchy_and_projects.sql
-- Establish the 2-level enterprise hierarchy + project automation anchoring.

CREATE INDEX IF NOT EXISTS idx_spaces_parent_depth ON spaces(tenant_id, parent_space_id, depth);

ALTER TABLE spaces ADD COLUMN is_automation_anchor INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS cross_space_grants_d1 (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  granting_space_id TEXT NOT NULL,
  receiving_space_id TEXT NOT NULL,
  target_project_id TEXT,
  grant_type TEXT NOT NULL CHECK (grant_type IN ('read', 'write', 'admin', 'delegate_task')),
  allowed_operations_json TEXT, -- JSON array of strings
  granted_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_cross_space_grants_tenant ON cross_space_grants_d1(tenant_id);
CREATE INDEX IF NOT EXISTS idx_cross_space_grants_granting ON cross_space_grants_d1(granting_space_id);
CREATE INDEX IF NOT EXISTS idx_cross_space_grants_receiving ON cross_space_grants_d1(receiving_space_id);
