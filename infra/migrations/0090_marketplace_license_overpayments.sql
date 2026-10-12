-- A second provider charge must never create a duplicate license or developer earning.
-- Capture it in an explicit refund queue for operator reconciliation.
CREATE TABLE IF NOT EXISTS marketplace_license_overpayments (
  provider_event_id TEXT PRIMARY KEY,
  purchase_id TEXT NOT NULL REFERENCES marketplace_license_purchases(id),
  tenant_id TEXT NOT NULL,
  listing_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
  status TEXT NOT NULL DEFAULT 'refund_required' CHECK(status IN ('refund_required','refunded')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
