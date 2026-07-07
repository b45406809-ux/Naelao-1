-- Go-live monetization pass: a builder's cut of reseller_ledger.margin_cents (business
-- subscriptions, product orders, seat activations, revenue-cut surcharges — every payer class
-- already attributed there) sat in the ledger with no way to actually get PAID it. reseller_ledger
-- stays a pure append-only revenue record (unchanged); this is a separate withdrawal-request
-- ledger a builder draws against it.
--
-- v1 is manual-fulfillment by design (per the platform's own money-movement decision): Lemon
-- Squeezy is a merchant-of-record with single-account custody and no Stripe-Connect-style
-- split-payment primitive, so there is no automated payout API to wire yet. A request here is
-- fulfilled by a real bank transfer + an ops action marking it paid — the same "ship the backend
-- for real, automate later" precedent as every other manual-fulfillment step in this build.
CREATE TABLE IF NOT EXISTS payout_requests (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL,
  requested_by      TEXT,             -- user id of the builder who requested it
  amount_cents      INTEGER NOT NULL CHECK (amount_cents > 0),
  currency          TEXT NOT NULL DEFAULT 'USD',
  status            TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'paid', 'rejected')),
  requested_at      TEXT NOT NULL DEFAULT (datetime('now')),
  fulfilled_at      TEXT,
  fulfilled_by      TEXT,             -- ops identity that marked it paid/rejected
  notes             TEXT
);

CREATE INDEX IF NOT EXISTS idx_payout_requests_tenant ON payout_requests(tenant_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_payout_requests_status ON payout_requests(status);
