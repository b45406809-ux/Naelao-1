ALTER TABLE developer_partner_profiles ADD COLUMN auto_payout_enabled INTEGER NOT NULL DEFAULT 0 CHECK(auto_payout_enabled IN (0,1));
ALTER TABLE developer_payouts ADD COLUMN destination_snapshot TEXT;
ALTER TABLE developer_payouts ADD COLUMN attempt_started_at INTEGER;
ALTER TABLE developer_payouts ADD COLUMN last_error TEXT;
