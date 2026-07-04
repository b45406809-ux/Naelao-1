-- Fixes a migration-history bug found while reconciling @naelao/entitlements (Phase E
-- precondition): 0022_api_key_scopes.sql's `CREATE TABLE IF NOT EXISTS api_keys` was a no-op
-- (the table already existed from 0004_billing.sql with org_id/scopes columns, not
-- tenant_id/scopes_json), so its own `CREATE INDEX ... ON api_keys (tenant_id, revoked_at)`
-- has been failing against the real schema in every environment since (deploy workflows run
-- migrations with `|| true`, so this failed silently rather than blocking deploys). Nothing in
-- the codebase reads scopes_json or these index names, so this recreates the intended indexes
-- against the columns that actually exist rather than resurrecting the abandoned scopes_json
-- column (real API key scoping now lives on BuilderAccountDO's own per-DO SQLite, unrelated to
-- this D1 table).
-- Distinct names from 0004_billing.sql's idx_api_keys_org(org_id) / idx_api_keys_hash(key_hash)
-- — CREATE INDEX IF NOT EXISTS only checks the index NAME, so reusing either would have silently
-- no-op'd instead of creating the composite/prefix indexes actually intended here.
CREATE INDEX IF NOT EXISTS idx_api_keys_org_revoked ON api_keys (org_id, revoked_at);
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys (key_prefix);

-- workers/admin's PATCH /admin/tenants/:id sets updated_at on orgs, but 0002_orgs.sql never gave
-- orgs that column (only created_at) — every admin plan/status update would have failed with
-- "no such column: updated_at". Added for real, matching the created_at pattern every other
-- platform table already follows (spaces, spacetypes, etc).
ALTER TABLE orgs ADD COLUMN updated_at TEXT;
