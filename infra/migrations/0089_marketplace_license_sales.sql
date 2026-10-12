ALTER TABLE marketplace_listings ADD COLUMN developer_user_id TEXT;
ALTER TABLE marketplace_listings ADD COLUMN ls_license_product_id TEXT;
ALTER TABLE marketplace_listings ADD COLUMN ls_license_variant_id TEXT;
ALTER TABLE marketplace_listings ADD COLUMN ls_license_provisioning_token TEXT;
ALTER TABLE marketplace_listings ADD COLUMN ls_license_provisioning_started_at INTEGER;

CREATE TABLE IF NOT EXISTS marketplace_license_purchases (
  id TEXT PRIMARY KEY,
  provider_event_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  listing_id TEXT NOT NULL REFERENCES marketplace_listings(id),
  buyer_space_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_marketplace_license_tenant_listing ON marketplace_license_purchases(tenant_id, listing_id);

CREATE TABLE IF NOT EXISTS developer_license_earnings (
  id TEXT PRIMARY KEY,
  purchase_id TEXT NOT NULL UNIQUE REFERENCES marketplace_license_purchases(id),
  developer_user_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
  payout_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_developer_license_pending ON developer_license_earnings(developer_user_id, payout_id);
