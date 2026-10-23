-- Tie every new recurring FDE royalty to the exact published marketplace template sold.
ALTER TABLE template_subscriptions ADD COLUMN marketplace_listing_id TEXT REFERENCES marketplace_listings(id);
CREATE INDEX IF NOT EXISTS idx_template_subscriptions_listing ON template_subscriptions(marketplace_listing_id, status, updated_at DESC);
