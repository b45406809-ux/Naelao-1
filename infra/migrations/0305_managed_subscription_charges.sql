-- MS-40: one row per (subscription, period, charge kind). Makes period-end settlement idempotent and keeps the metered count stable
-- across retries (the credits of a reservation must not change between attempts). Not applied remotely.
--   kind 'overage': Naelao Email sends above the allowance in the period that just ended (usage_count, credits).
--   kind 'rental' : the rental for the period that starts at period_start.
-- status: pending (computed, not yet charged), settled, skipped (nothing to charge, e.g. within the included allowance).
CREATE TABLE IF NOT EXISTS managed_service_subscription_charges (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('rental','overage')),
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  usage_count INTEGER,
  credits INTEGER NOT NULL CHECK(credits >= 0),
  status TEXT NOT NULL CHECK(status IN ('pending','settled','skipped')),
  operation_id TEXT,
  reservation_id TEXT,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(subscription_id, kind, period_start)
);
CREATE INDEX IF NOT EXISTS idx_managed_service_subscription_charges_tenant ON managed_service_subscription_charges(tenant_id, status, period_start);
