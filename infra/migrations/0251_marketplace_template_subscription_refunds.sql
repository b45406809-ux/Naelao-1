-- Preserve recurring-template refund notifications for policy review. This receipt is evidence
-- only: it does not alter subscription access, paid cycles, developer earnings, or payouts.
CREATE TABLE IF NOT EXISTS marketplace_template_subscription_refund_cases (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider = 'lemon_squeezy'),
  provider_event_id TEXT NOT NULL,
  provider_invoice_id TEXT,
  provider_subscription_id TEXT,
  webhook_body_sha256 TEXT NOT NULL UNIQUE CHECK (length(webhook_body_sha256) = 64),
  template_subscription_id TEXT REFERENCES template_subscriptions(id),
  space_id TEXT,
  listing_id TEXT REFERENCES marketplace_listings(id),
  refund_amount_cents INTEGER CHECK (refund_amount_cents IS NULL OR refund_amount_cents > 0),
  currency TEXT NOT NULL CHECK (length(currency) BETWEEN 1 AND 8),
  state TEXT NOT NULL CHECK (state IN ('review_required', 'unmatched_subscription', 'policy_conflict')),
  review_reason TEXT NOT NULL CHECK (review_reason IN (
    'policy_pending', 'subscription_not_observed', 'space_mismatch', 'subscription_identity_conflict',
    'invoice_identity_missing', 'refund_amount_unknown', 'refund_amount_invalid', 'unsupported_currency'
  )),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_template_subscription_refund_review
  ON marketplace_template_subscription_refund_cases(state, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_template_subscription_refund_listing
  ON marketplace_template_subscription_refund_cases(listing_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_template_subscription_refund_space
  ON marketplace_template_subscription_refund_cases(space_id, created_at DESC, id DESC);
