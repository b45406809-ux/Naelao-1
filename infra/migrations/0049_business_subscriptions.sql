-- Phase E (§A1.17): tracks the state of a business's subscription to one of its product's
-- builder-defined plans (productConfig.pricingConfig.plans). Keyed by business_space_id — a
-- business as a whole subscribes (mirroring memberBilling's "the whole space pays" shape), not
-- an individual end user. One row per business; upserted on every Lemon Squeezy
-- subscription_created/updated/cancelled webhook (unique on ls_subscription_id so a webhook
-- retry re-sets the same row instead of creating a duplicate).
CREATE TABLE IF NOT EXISTS business_subscriptions (
  id                  TEXT PRIMARY KEY,
  business_space_id   TEXT NOT NULL,
  product_space_id    TEXT NOT NULL,
  plan_id             TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'past_due', 'paused', 'cancelled', 'expired')),
  ls_subscription_id  TEXT,
  ls_customer_id      TEXT,
  current_period_end  TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A business has at most one row (its current plan) — re-subscribing/switching plans updates it
-- rather than accumulating history; the reseller_ledger is the historical revenue record.
CREATE UNIQUE INDEX IF NOT EXISTS idx_business_subscriptions_space ON business_subscriptions(business_space_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_business_subscriptions_ls_sub ON business_subscriptions(ls_subscription_id) WHERE ls_subscription_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_business_subscriptions_product ON business_subscriptions(product_space_id);
