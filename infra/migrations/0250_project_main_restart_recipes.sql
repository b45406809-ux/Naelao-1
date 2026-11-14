-- Owner-configured recovery notes for project-main services. Recipes are inert metadata until a
-- supported runtime adapter can safely execute and verify them; no credentials are stored here.
CREATE TABLE IF NOT EXISTS project_main_restart_recipe_sets (
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  recipes_json TEXT NOT NULL CHECK(length(recipes_json) <= 12000),
  version INTEGER NOT NULL CHECK(version > 0),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id,space_id,project_id)
);

CREATE TABLE IF NOT EXISTS project_main_restart_recipe_audit (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  previous_version INTEGER NOT NULL CHECK(previous_version >= 0),
  new_version INTEGER NOT NULL CHECK(new_version > previous_version),
  recipe_count INTEGER NOT NULL CHECK(recipe_count BETWEEN 0 AND 10),
  recipes_sha256 TEXT NOT NULL CHECK(length(recipes_sha256) = 64),
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_project_main_restart_recipe_audit_revision
  ON project_main_restart_recipe_audit(tenant_id,space_id,project_id,new_version);
