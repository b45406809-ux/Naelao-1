-- Preserve the notification worker's explicit unknown result for owner-visible cost alerts.
CREATE TABLE managed_service_cost_budget_alert_deliveries_v2 (
  id TEXT PRIMARY KEY,
  alert_id TEXT NOT NULL UNIQUE REFERENCES managed_service_cost_budget_alerts(id),
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','running','delivered','no_subscription','suppressed','ambiguous')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
  next_at TEXT NOT NULL,
  lease_token TEXT,
  lease_until TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  delivered_at TEXT
);

INSERT INTO managed_service_cost_budget_alert_deliveries_v2 (
  id,alert_id,tenant_id,space_id,user_id,status,attempts,next_at,lease_token,lease_until,
  last_error,created_at,updated_at,delivered_at
)
SELECT id,alert_id,tenant_id,space_id,user_id,status,attempts,next_at,lease_token,lease_until,
  last_error,created_at,updated_at,delivered_at
FROM managed_service_cost_budget_alert_deliveries;

DROP TABLE managed_service_cost_budget_alert_deliveries;
ALTER TABLE managed_service_cost_budget_alert_deliveries_v2 RENAME TO managed_service_cost_budget_alert_deliveries;

CREATE INDEX idx_managed_service_cost_budget_alert_delivery_due
  ON managed_service_cost_budget_alert_deliveries(status,next_at,lease_until,created_at);
CREATE INDEX idx_managed_service_cost_budget_alert_delivery_owner
  ON managed_service_cost_budget_alert_deliveries(tenant_id,space_id,user_id,status,created_at DESC);
