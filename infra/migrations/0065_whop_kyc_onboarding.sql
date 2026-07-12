-- Whop "connected accounts" (their current name for what migration 0064 called sub-merchants —
-- same Platforms API, same invite-only access) have TWO separate readiness states that migration
-- 0064 conflated into one: the company record can be created instantly via API, but a brand-new
-- owner (no prior Whop account) must additionally complete an emailed onboarding link with KYC
-- verification before that connected account can actually RECEIVE TRANSFERS/payouts. Treating
-- "created" as "active" would have silently told an owner their wallet was ready when payouts
-- would in fact fail — this migration adds the missing intermediate state instead.
--
-- SQLite can't ALTER a CHECK constraint in place (same limitation 0052 hit) — rebuild the table.

CREATE TABLE whop_sub_merchants_v2 (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  space_id       TEXT NOT NULL,
  company_id     TEXT NOT NULL,
  owner_email    TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'awaiting_kyc', 'active', 'error')),
  -- Set only while status = 'awaiting_kyc' — the one-time Whop-hosted KYC/onboarding link the
  -- owner must complete before payouts work. Cleared once status flips to 'active'.
  onboarding_url TEXT,
  balance_cents  INTEGER NOT NULL DEFAULT 0,
  currency       TEXT NOT NULL DEFAULT 'USD',
  last_synced_at TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO whop_sub_merchants_v2
  (id, tenant_id, space_id, company_id, owner_email, status, balance_cents, currency, last_synced_at, created_at, updated_at)
  SELECT id, tenant_id, space_id, company_id, owner_email, status, balance_cents, currency, last_synced_at, created_at, updated_at
  FROM whop_sub_merchants;

DROP TABLE whop_sub_merchants;
ALTER TABLE whop_sub_merchants_v2 RENAME TO whop_sub_merchants;

CREATE UNIQUE INDEX IF NOT EXISTS idx_whop_sub_merchants_space ON whop_sub_merchants(space_id);
CREATE INDEX IF NOT EXISTS idx_whop_sub_merchants_tenant ON whop_sub_merchants(tenant_id);
CREATE INDEX IF NOT EXISTS idx_whop_sub_merchants_company ON whop_sub_merchants(company_id);
