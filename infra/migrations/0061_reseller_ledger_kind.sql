-- ARCH-REVENUE-6 / ARCH-REVENUE-7: give reseller_ledger a `kind` column so a builder's payout
-- read side can break revenue down by source, and so the new builder-revenue-share attribution
-- (a builder's slice of a child business's storefront/seat sales) is distinguishable from the
-- existing wholesale/referral attribution written by recordResellerAttribution.
--
--   'attribution'           — the original per-event reseller/referral margin (default for all
--                             existing rows and every recordResellerAttribution write).
--   'builder_revenue_share' — ARCH-REVENUE-6: the builder's configured slice of a child
--                             business's own sale (settled out of the sale before the business
--                             wallet, attributed to the builder's parent tenant).
--
-- Idempotency/refund: a refund writes a matching negative-margin row with the SAME kind, so the
-- payout balance nets to zero — never deletes the original (audit trail).
ALTER TABLE reseller_ledger ADD COLUMN kind TEXT NOT NULL DEFAULT 'attribution';

CREATE INDEX IF NOT EXISTS idx_reseller_ledger_parent_kind ON reseller_ledger(parent_tenant_id, kind);

-- ARCH-REVENUE-6: record the builder's slice on the order row itself, so the wallet UI can show
-- the two deductions (Naelao cut, builder cut) explicitly rather than one opaque fee, and so
-- net_cents = gross - fee_cents - builder_fee_cents stays a checkable invariant. Defaults 0 for
-- every existing order (no builder share taken before this feature).
ALTER TABLE launchpad_orders ADD COLUMN builder_fee_cents INTEGER NOT NULL DEFAULT 0;
