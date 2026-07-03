-- Three-Tier Platform Model, Phase 3 (docs/spec-appendix A1.17): the Builder Dashboard API.
--
-- builder_api_key_index: a bare "Authorization: Bearer nbk_..." key carries no tenant hint, but
-- BuilderAccountDO is HMAC-addressed BY tenantId — so a request arriving with only a raw key has
-- no way to know which BuilderAccountDO instance to ask. This table is PURE ROUTING information
-- (key_hash -> tenant_id), not a second source of truth: the actual validity/expiry/revocation/
-- scopes decision is always re-verified against the authoritative BuilderAccountDO.api_keys row
-- (POST /api-keys/verify). A stale index row (key later revoked) is harmless — it only causes one
-- extra DO round-trip that then correctly reports invalid, never a false grant.
CREATE TABLE IF NOT EXISTS builder_api_key_index (
  key_hash   TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  key_id     TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_builder_api_key_index_tenant ON builder_api_key_index(tenant_id);

-- product_end_users: the enumerable roster of a product's end users. Deliberately NOT the same
-- table as SpaceDO's internal space_members (that's platform-user Team collaborators, a
-- structurally different population — CLAUDE.md #23's Bucket A/B split) and NOT the legacy D1
-- space_members from the retired Whop-niche BusinessDO (migration 0021). ProductUserDO instances
-- (Phase 2) hold the actual per-user state (credits/sessions/prefs) but aren't bulk-enumerable —
-- this table is the roster index a builder's Users tab lists from. Populated starting Phase 6
-- (end-user session creation); the schema + read/suspend contract belongs here since it's part
-- of the Builder Dashboard API surface.
CREATE TABLE IF NOT EXISTS product_end_users (
  product_space_id TEXT NOT NULL,
  end_user_id      TEXT NOT NULL,
  email            TEXT,
  display_name     TEXT,
  first_seen_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at     TEXT,
  -- Consent for the builder to read this user's conversation metadata (one leg of the
  -- conversation-access triple-gate below) — distinct from feature-flag/staff-approval legs.
  consented_at     TEXT,
  suspended_at     TEXT,
  PRIMARY KEY (product_space_id, end_user_id)
);
CREATE INDEX IF NOT EXISTS idx_product_end_users_product ON product_end_users(product_space_id);

-- conversation_access_audit: append-only. Written every time a builder successfully reads an end
-- user's conversation metadata through the gated endpoint — never on a denied attempt (nothing to
-- audit if nothing was disclosed). No UPDATE/DELETE path is ever wired to this table.
CREATE TABLE IF NOT EXISTS conversation_access_audit (
  id               TEXT PRIMARY KEY,
  product_space_id TEXT NOT NULL,
  end_user_id      TEXT NOT NULL,
  accessed_by      TEXT NOT NULL, -- the builder-side actor (tenant/user id) who read it
  accessed_at      TEXT NOT NULL DEFAULT (datetime('now')),
  purpose          TEXT
);
CREATE INDEX IF NOT EXISTS idx_conversation_access_audit_product ON conversation_access_audit(product_space_id);

-- product_webhooks: a builder's own webhook endpoints for product lifecycle events (order
-- placed, user suspended, etc). Deliberately a small dedicated table, not folded into
-- config_json — webhooks are operational plumbing a builder adds/removes frequently, not
-- product configuration a builder edits rarely (same reasoning as keeping api_keys off
-- config_json in Phase 1).
CREATE TABLE IF NOT EXISTS product_webhooks (
  id               TEXT PRIMARY KEY,
  product_space_id TEXT NOT NULL,
  url              TEXT NOT NULL,
  event_types_json TEXT NOT NULL DEFAULT '[]',
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_product_webhooks_product ON product_webhooks(product_space_id);
