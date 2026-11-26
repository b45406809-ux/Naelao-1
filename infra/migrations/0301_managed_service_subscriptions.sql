-- MS-36 (V-spec §6.4, MR-COM-9, MR-LIFE-2): managed service subscriptions and owner notices. Not applied remotely.
-- Read and written only behind MANAGED_SUBSCRIPTIONS_ENABLED (default "false"). All timestamps are epoch milliseconds.
-- Columns beyond the §6.4 sketch: subscription_type (routes a row to its renewal handler; 'agentmail_rental' is the first),
-- notify_user_id (who gets the notices), grace_started_at / suspended_at / release_warning_at (grace and MR-LIFE-2 clocks).
CREATE TABLE IF NOT EXISTS managed_service_subscriptions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  subscription_type TEXT NOT NULL,
  offering_id TEXT NOT NULL,
  price_version TEXT NOT NULL,
  interval TEXT NOT NULL CHECK(interval IN ('month')),
  current_period_start INTEGER NOT NULL,
  current_period_end INTEGER NOT NULL,
  renewal_state TEXT NOT NULL CHECK(renewal_state IN ('active','renewing','grace','suspended','cancelled')),
  grace_days INTEGER NOT NULL CHECK(grace_days >= 0),
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0 CHECK(cancel_at_period_end IN (0,1)),
  upstream_commitment_json TEXT,
  last_renewal_operation_id TEXT,
  notify_user_id TEXT,
  grace_started_at INTEGER,
  suspended_at INTEGER,
  release_warning_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(tenant_id, resource_id)
);
CREATE INDEX IF NOT EXISTS idx_managed_service_subscriptions_due
  ON managed_service_subscriptions(renewal_state, current_period_end);

-- One notice per (subscription, kind, period); the unique key makes notices idempotent across sweep replays.
CREATE TABLE IF NOT EXISTS managed_service_subscription_notices (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('renewal_failed_grace','suspended','release_warning')),
  period_start INTEGER NOT NULL,
  notify_user_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(subscription_id, kind, period_start)
);
