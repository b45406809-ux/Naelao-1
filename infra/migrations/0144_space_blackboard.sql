-- Shared cards contain only explicitly published project information.
CREATE TABLE IF NOT EXISTS space_blackboard_cards (
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, space_id, project_id)
);
CREATE INDEX IF NOT EXISTS space_blackboard_cards_space ON space_blackboard_cards(tenant_id, space_id, updated_at);
