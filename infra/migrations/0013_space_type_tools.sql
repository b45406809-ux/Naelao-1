-- G-ST01..ST06: SpaceType tool bindings — tools attached to a SpaceType definition
CREATE TABLE IF NOT EXISTS space_type_tools (
  id TEXT PRIMARY KEY,
  space_type_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  tool_id TEXT NOT NULL,                     -- references tool_definitions.id
  enabled INTEGER NOT NULL DEFAULT 1,
  config_override_json TEXT,                 -- per-SpaceType tool config overrides
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_stt_space_type ON space_type_tools (space_type_id, enabled);
CREATE INDEX IF NOT EXISTS idx_stt_tenant ON space_type_tools (tenant_id);
UNIQUE INDEX IF NOT EXISTS idx_stt_unique ON space_type_tools (space_type_id, tool_id);
