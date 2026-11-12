-- Retryable notification outbox for owner-configured provider-cost alert crossings.
-- Push is sent only to the user who configured the threshold and only through an
-- existing browser subscription; the alert row remains the authoritative dashboard event.
CREATE TABLE IF NOT EXISTS managed_service_cost_budget_alert_deliveries (
  id TEXT PRIMARY KEY,
  alert_id TEXT NOT NULL UNIQUE REFERENCES managed_service_cost_budget_alerts(id),
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','running','delivered','no_subscription','suppressed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
  next_at TEXT NOT NULL,
  lease_token TEXT,
  lease_until TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_managed_service_cost_budget_alert_delivery_due
  ON managed_service_cost_budget_alert_deliveries(status,next_at,lease_until,created_at);
CREATE INDEX IF NOT EXISTS idx_managed_service_cost_budget_alert_delivery_owner
  ON managed_service_cost_budget_alert_deliveries(tenant_id,space_id,user_id,status,created_at DESC);
