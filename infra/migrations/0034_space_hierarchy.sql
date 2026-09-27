-- Space hierarchy + tenancy topology (spec G-Y15 CRITICAL "Tenancy Model Not a
-- First-Class Configurable Dimension", G-Y16 "Per-End-User Isolation", §49 Sub-Space
-- Architecture). Tenancy is the data-topology contract a builder picks per product:
--
--   single  — one owner, one SpaceDO.
--   team    — one shared SpaceDO; sub-spaces (departments) live inside it, isolated by
--             space_id in the SpaceDO `spaces` registry. Shared members.
--   saas    — product root + per-end-user isolation: each customer business is its OWN
--             D1 spaces row under its OWN child tenant with its OWN SpaceDO (structural
--             isolation, not a WHERE clause). Linked to the parent product via
--             parent_space_id here and via tenant_hierarchy (reseller subsystem).
--
-- These columns sit on the platform `spaces` table so cross-product hierarchy queries
-- can run in D1 without opening every SpaceDO. Organizational hierarchy is exactly two
-- tiers: company roots at depth 0 and departments at depth 1.

ALTER TABLE spaces ADD COLUMN parent_space_id TEXT;
ALTER TABLE spaces ADD COLUMN depth INTEGER NOT NULL DEFAULT 0;
ALTER TABLE spaces ADD COLUMN tenancy_mode TEXT NOT NULL DEFAULT 'team'
  CHECK (tenancy_mode IN ('single','team','saas'));
ALTER TABLE spaces ADD COLUMN agency_shell INTEGER NOT NULL DEFAULT 0;
-- organizational = same-type departments; agency-child = mixed-type client space;
-- user-workspace = end-user-created business in a saas/hybrid product.
ALTER TABLE spaces ADD COLUMN scenario_type TEXT
  CHECK (scenario_type IN ('organizational','agency-child','user-workspace'));

CREATE INDEX IF NOT EXISTS idx_spaces_parent ON spaces(parent_space_id);

CREATE TRIGGER IF NOT EXISTS spaces_hierarchy_depth_insert
BEFORE INSERT ON spaces WHEN NEW.depth NOT IN (0, 1)
BEGIN
  SELECT RAISE(ABORT, 'space hierarchy depth must be 0 or 1');
END;

CREATE TRIGGER IF NOT EXISTS spaces_hierarchy_depth_update
BEFORE UPDATE OF depth, parent_space_id ON spaces
WHEN NEW.depth NOT IN (0, 1)
  OR (NEW.depth = 0 AND NEW.parent_space_id IS NOT NULL)
  OR (NEW.depth = 1 AND NEW.parent_space_id IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'invalid two-tier space hierarchy');
END;

CREATE TABLE IF NOT EXISTS cross_space_grants (
  id TEXT PRIMARY KEY,
  grantee_space_id TEXT NOT NULL,
  target_space_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  CHECK (grantee_space_id <> target_space_id)
);
CREATE INDEX IF NOT EXISTS idx_cross_space_grants_active
  ON cross_space_grants(grantee_space_id, target_space_id, resource_id, expires_at);
