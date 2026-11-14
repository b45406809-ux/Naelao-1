-- Email is an explicit second channel for owner-configured cost alerts. Existing thresholds stay
-- push/in-app only until the author opts in; no recipient address is copied into the outbox.
ALTER TABLE managed_service_cost_budgets
  ADD COLUMN email_alerts_enabled INTEGER NOT NULL DEFAULT 0 CHECK(email_alerts_enabled IN (0,1));
ALTER TABLE managed_service_cost_budgets
  ADD COLUMN email_recipient_kind TEXT NOT NULL DEFAULT 'builder_user'
    CHECK(email_recipient_kind IN ('builder_user','product_end_user'));

CREATE TABLE managed_service_cost_budget_email_deliveries (
  id TEXT PRIMARY KEY,
  alert_id TEXT NOT NULL UNIQUE REFERENCES managed_service_cost_budget_alerts(id),
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  project_id TEXT,
  user_id TEXT NOT NULL,
  recipient_kind TEXT NOT NULL CHECK(recipient_kind IN ('builder_user','product_end_user')),
  status TEXT NOT NULL CHECK(status IN ('pending','running','provider_accepted','provider_rejected','ambiguous','suppressed','no_recipient')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
  next_at TEXT NOT NULL,
  lease_token TEXT,
  lease_until TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  accepted_at TEXT
);

CREATE INDEX idx_managed_service_cost_budget_email_due
  ON managed_service_cost_budget_email_deliveries(status,next_at,lease_until,created_at);
CREATE INDEX idx_managed_service_cost_budget_email_owner
  ON managed_service_cost_budget_email_deliveries(tenant_id,space_id,user_id,status,created_at DESC);
