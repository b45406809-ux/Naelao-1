-- Batch 03: make logical connector scope and audit guarantees durable.
-- 0075's CHECK allowed a user-private row to retain an unrelated project id. Triggers protect
-- both new and existing deployments without rebuilding a referenced table in place.
CREATE TRIGGER IF NOT EXISTS connector_alias_scope_insert_guard
BEFORE INSERT ON connector_aliases
WHEN (NEW.scope = 'space' AND (NEW.project_id IS NOT NULL OR NEW.user_id IS NOT NULL))
  OR (NEW.scope = 'project' AND (NEW.project_id IS NULL OR NEW.user_id IS NOT NULL))
  OR (NEW.scope = 'user' AND (NEW.user_id IS NULL OR NEW.project_id IS NOT NULL))
BEGIN
  SELECT RAISE(ABORT, 'invalid connector alias scope');
END;

CREATE TRIGGER IF NOT EXISTS connector_alias_scope_update_guard
BEFORE UPDATE OF scope, project_id, user_id ON connector_aliases
WHEN (NEW.scope = 'space' AND (NEW.project_id IS NOT NULL OR NEW.user_id IS NOT NULL))
  OR (NEW.scope = 'project' AND (NEW.project_id IS NULL OR NEW.user_id IS NOT NULL))
  OR (NEW.scope = 'user' AND (NEW.user_id IS NULL OR NEW.project_id IS NOT NULL))
BEGIN
  SELECT RAISE(ABORT, 'invalid connector alias scope');
END;

CREATE TABLE IF NOT EXISTS connector_alias_audit (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  alias_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('created', 'deleted', 'called', 'scope_denied', 'dlp_denied')),
  actor_id TEXT NOT NULL,
  project_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_connector_alias_audit_scope
  ON connector_alias_audit(tenant_id, space_id, created_at DESC);
