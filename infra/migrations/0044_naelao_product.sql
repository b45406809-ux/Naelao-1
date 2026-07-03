-- Three-Tier Platform Model (spec "Three-Tier Platform Model" / "How Builders Use Naelao"),
-- Phase 1 (docs/spec-appendix/A1-script-agents-and-space-assistants.md §A1.17).
--
-- Only two genuinely new, cross-space-queryable concerns get real columns here — NOT the full
-- ~20-field NaelaoProduct list the spec describes verbatim, because most of those fields
-- already have a home: SpaceTypeProductConfig (workers/spaces/src/do/SpaceTypeRegistryDO.ts),
-- stored as a config_json.productConfig override on the space row exactly like member billing
-- (CLAUDE.md #17) and assistant policy (#20) already do. Adding new flat columns for those would
-- create the split-brain this migration exists to avoid — e.g. a `product_domain` column here
-- would duplicate the `business_services` table, which already tracks storefront/custom-domain
-- identity end-to-end (CLAUDE.md #16).
--
-- product_slug: the platform-subdomain identity a builder picks for their product
-- ({slug}.naelao.app) at launch time. Genuinely new — no existing table tracks this — and needs
-- a platform-wide uniqueness check the launch wizard runs before allowing signup, so it must be
-- a real indexed column, not buried in JSON.
--
-- conversation_access_approved_by / _at: the spec's legally-gated conversation-log-access
-- approval (a Naelao platform-admin must manually review and approve before a builder can read
-- ANY end-user conversation, even metadata-only). Naelao staff need to query this across every
-- space for the platform-wide approval queue (spec Surface 1) — an audit field, not a
-- builder-editable config value, so it does not belong in config_json.

ALTER TABLE spaces ADD COLUMN product_slug TEXT;
ALTER TABLE spaces ADD COLUMN conversation_access_approved_by TEXT;
ALTER TABLE spaces ADD COLUMN conversation_access_approved_at TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_spaces_product_slug ON spaces(product_slug)
  WHERE product_slug IS NOT NULL;
