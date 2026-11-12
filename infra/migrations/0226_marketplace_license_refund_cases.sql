-- Persist refund evidence for fixed-license marketplace sales without guessing access,
-- author-earnings clawback, or payout-recovery policy.
CREATE TABLE IF NOT EXISTS marketplace_license_refund_cases (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider = 'lemon_squeezy'),
  provider_order_id TEXT NOT NULL,
  webhook_body_sha256 TEXT NOT NULL UNIQUE CHECK (length(webhook_body_sha256) = 64),
  purchase_id TEXT REFERENCES marketplace_license_purchases(id),
  tenant_id TEXT NOT NULL,
  listing_id TEXT NOT NULL,
  order_amount_cents INTEGER CHECK (order_amount_cents IS NULL OR order_amount_cents > 0),
  refund_amount_cents INTEGER CHECK (refund_amount_cents IS NULL OR refund_amount_cents > 0),
  currency TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('review_required', 'unmatched_purchase', 'policy_conflict')),
  review_reason TEXT NOT NULL CHECK (review_reason IN (
    'policy_pending', 'purchase_not_observed', 'tenant_mismatch', 'purchase_identity_mismatch',
    'order_amount_mismatch', 'refund_amount_invalid', 'refund_exceeds_purchase', 'unsupported_currency'
  )),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_marketplace_license_refund_cases_review
  ON marketplace_license_refund_cases(state, created_at, id);
CREATE INDEX IF NOT EXISTS idx_marketplace_license_refund_cases_order
  ON marketplace_license_refund_cases(provider_order_id, tenant_id, listing_id);
