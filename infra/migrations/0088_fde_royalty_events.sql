-- Later partner-economics correction: a 50-developer pioneer cohort and a lifetime
-- 40/25 -> 20 -> 5 percent decay, with account age tracked across plan changes.
ALTER TABLE developer_partner_profiles ADD COLUMN pioneer_rank INTEGER CHECK (pioneer_rank BETWEEN 1 AND 50);
CREATE UNIQUE INDEX IF NOT EXISTS idx_developer_pioneer_rank ON developer_partner_profiles(pioneer_rank) WHERE pioneer_rank IS NOT NULL;
ALTER TABLE template_subscriptions ADD COLUMN paid_cycles_total INTEGER NOT NULL DEFAULT 0 CHECK (paid_cycles_total >= 0);
ALTER TABLE template_subscriptions ADD COLUMN pioneer_eligible INTEGER NOT NULL DEFAULT 0 CHECK (pioneer_eligible IN (0,1));
ALTER TABLE developer_earnings_ledger ADD COLUMN provider_event_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_developer_earnings_provider_event ON developer_earnings_ledger(provider_event_id) WHERE provider_event_id IS NOT NULL;
