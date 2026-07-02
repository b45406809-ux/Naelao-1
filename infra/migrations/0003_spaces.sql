-- Spaces and SpaceTypes
CREATE TABLE IF NOT EXISTS spacetypes (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL,
  name           TEXT NOT NULL,
  description    TEXT,
  version        TEXT NOT NULL DEFAULT '1.0.0',
  schema_json    TEXT NOT NULL DEFAULT '{}',
  status         TEXT NOT NULL DEFAULT 'draft',
  published_at   TEXT,
  runtime_version TEXT NOT NULL DEFAULT '1.0.0',
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS spaces (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  spacetype_id TEXT NOT NULL,
  name         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active',
  config_json  TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  created_by   TEXT
);

CREATE INDEX IF NOT EXISTS idx_spaces_tenant ON spaces(tenant_id);
CREATE INDEX IF NOT EXISTS idx_spaces_spacetype ON spaces(spacetype_id);
CREATE INDEX IF NOT EXISTS idx_spacetypes_org ON spacetypes(org_id);
