-- Reseller / tenant-membership subsystem (spec G-AS34 Agency Partner Program,
-- G-AS35 White-Label Reseller). Backs productConfig.membershipModel = "tenant" | "hybrid".
--
-- Kept in dedicated tables keyed by tenant_id (rather than ALTERing orgs) so the
-- account-hierarchy concern is isolated and does not depend on the orgs/organizations
-- table naming. A "reseller" is a builder whose product lets customers create their own
-- businesses (child tenants). Naelao bills the reseller wholesale (or the customer
-- directly with a rev-share), per billing_relationship.

-- Config for a tenant that operates as a reseller (one row per reseller tenant).
CREATE TABLE IF NOT EXISTS reseller_accounts (
  tenant_id            TEXT PRIMARY KEY,
  -- The reseller's product space whose productConfig enabled tenant/hybrid membership.
  product_space_id     TEXT NOT NULL,
  -- "reseller" (wholesale->retail, reseller invoices), "referral" (Naelao bills, rev-share),
  -- "platform" (no resale — child tenants billed exactly like any builder).
  billing_relationship TEXT NOT NULL DEFAULT 'platform'
    CHECK (billing_relationship IN ('reseller','referral','platform')),
  -- reseller mode: fixed wholesale cost (cents) Naelao charges the reseller per child
  -- subscription period. NULL = pass-through of the retail amount.
  wholesale_cents      INTEGER,
  -- referral mode: percent (0-100) of retail revenue Naelao pays back to the reseller.
  referral_share_pct   REAL NOT NULL DEFAULT 0.0
    CHECK (referral_share_pct >= 0.0 AND referral_share_pct <= 100.0),
  status               TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','suspended')),
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Maps each customer-created tenant to its parent reseller (the account hierarchy).
-- Child tenants stay fully isolated by the existing {tenantId}: namespacing; this table
-- only records lineage for billing rollup and the client-portfolio view.
CREATE TABLE IF NOT EXISTS tenant_hierarchy (
  child_tenant_id          TEXT PRIMARY KEY,
  parent_tenant_id         TEXT NOT NULL,
  -- The reseller's product space the customer signed up through.
  reseller_product_space_id TEXT NOT NULL,
  -- The space (business) provisioned for the customer under their own tenant.
  child_space_id           TEXT NOT NULL,
  child_owner_user_id      TEXT,
  status                   TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','suspended','terminated')),
  created_at               TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tenant_hierarchy_parent ON tenant_hierarchy(parent_tenant_id);

-- Consolidated billing rollup: one row per child-tenant billing event, attributed to the
-- parent reseller. Drives the reseller's invoice (sum of wholesale_cents) and margin report.
CREATE TABLE IF NOT EXISTS reseller_ledger (
  id               TEXT PRIMARY KEY,
  parent_tenant_id TEXT NOT NULL,
  child_tenant_id  TEXT NOT NULL,
  child_space_id   TEXT NOT NULL,
  event_type       TEXT NOT NULL,
  retail_cents     INTEGER NOT NULL DEFAULT 0,
  wholesale_cents  INTEGER NOT NULL DEFAULT 0,
  margin_cents     INTEGER NOT NULL DEFAULT 0,
  currency         TEXT NOT NULL DEFAULT 'USD',
  period           TEXT NOT NULL,             -- YYYY-MM
  recorded_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_reseller_ledger_parent_period ON reseller_ledger(parent_tenant_id, period);
CREATE INDEX IF NOT EXISTS idx_reseller_ledger_child ON reseller_ledger(child_tenant_id);
