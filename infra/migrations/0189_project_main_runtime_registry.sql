-- Durable host-side identity for the one serialized main computer assigned to a project.
-- Speculative model-race branches remain separate staging runtimes and never own this row.
CREATE TABLE IF NOT EXISTS project_main_runtime_registry (
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  runtime_kind TEXT NOT NULL CHECK(runtime_kind='dynamic_sandbox'),
  runtime_object_name TEXT NOT NULL,
  allocation_generation INTEGER NOT NULL DEFAULT 0 CHECK(allocation_generation >= 0),
  fencing_token INTEGER NOT NULL DEFAULT 0 CHECK(fencing_token >= 0),
  active_branch TEXT NOT NULL DEFAULT 'main',
  state TEXT NOT NULL DEFAULT 'registered' CHECK(state IN ('registered','active','sleeping','recovery_required','erased')),
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id,space_id,project_id),
  UNIQUE(runtime_kind,runtime_object_name)
);
CREATE INDEX IF NOT EXISTS idx_project_main_runtime_state
  ON project_main_runtime_registry(tenant_id,state,last_seen_at);
