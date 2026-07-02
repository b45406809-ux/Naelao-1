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
-- These columns sit on the platform `spaces` table so the reseller portfolio, the
-- promote-to-product flow, and cross-product hierarchy queries can run in D1 without
-- opening every SpaceDO. Department-level (depth 2) hierarchy lives inside the SpaceDO
-- `spaces` registry (migration v10), not here.

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
