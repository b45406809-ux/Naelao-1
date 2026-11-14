-- Preserve provider-reported purchase terms for platform and Product-user plans. These rows are
-- immutable facts keyed by the provider's purchase event identity; they do not define refund or
-- entitlement policy.
CREATE TABLE IF NOT EXISTS billing_plan_purchase_receipts (
  provider TEXT NOT NULL CHECK (provider IN ('lemon_squeezy', 'whop')),
  provider_event_id TEXT NOT NULL CHECK (length(trim(provider_event_id)) > 0),
  purchase_scope TEXT NOT NULL CHECK (purchase_scope IN ('platform_plan', 'product_user_plan')),
  org_id TEXT,
  product_id TEXT,
  end_user_id TEXT,
  plan_tier TEXT NOT NULL CHECK (plan_tier IN ('growth', 'business')),
  subscription_id TEXT,
  provider_variant_id TEXT NOT NULL CHECK (length(trim(provider_variant_id)) > 0),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  provider_event_at TEXT,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (provider, provider_event_id),
  CHECK (
    (purchase_scope = 'platform_plan' AND org_id IS NOT NULL AND product_id IS NULL AND end_user_id IS NULL)
    OR
    (purchase_scope = 'product_user_plan' AND org_id IS NULL AND product_id IS NOT NULL AND end_user_id IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_billing_plan_purchase_receipts_org
  ON billing_plan_purchase_receipts(org_id, recorded_at DESC) WHERE org_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_billing_plan_purchase_receipts_product_user
  ON billing_plan_purchase_receipts(product_id, end_user_id, recorded_at DESC) WHERE product_id IS NOT NULL;
