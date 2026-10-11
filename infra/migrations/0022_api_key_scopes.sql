-- G-AK01..AK06: API keys with fine-grained scopes
--
-- 0004_billing.sql already creates api_keys with org_id/scopes columns. This migration originally
-- tried to create a second shape with tenant_id/scopes_json, but CREATE TABLE IF NOT EXISTS made
-- that a no-op and the tenant_id index failed on fresh local databases. Keep the intended lookup
-- indexes on the real table shape.
CREATE INDEX IF NOT EXISTS idx_api_keys_org_revoked ON api_keys (org_id, revoked_at);
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys (key_prefix);
