-- Tenant-owned references to immutable certified blueprints; activation is isolated per space.
CREATE TABLE IF NOT EXISTS marketplace_forks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  listing_id TEXT NOT NULL REFERENCES marketplace_listings(id),
  blueprint_id TEXT NOT NULL,
  artifact_json TEXT NOT NULL,
  certificate_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, listing_id)
);
