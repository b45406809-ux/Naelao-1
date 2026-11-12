-- Queue GraphQL analytics are interval observations, not current backlog or DLQ depth.
-- Persist missing/incomplete telemetry explicitly and route actionable alerts to the existing
-- platform_failures operator inbox.
CREATE TABLE IF NOT EXISTS queue_health_checks (
  triggered_at TEXT PRIMARY KEY,
  observed_at TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('cloudflare_graphql_analytics', 'unavailable')),
  status TEXT NOT NULL CHECK (status IN ('unknown', 'incomplete', 'degraded')),
  unavailable_reason TEXT,
  metrics_json TEXT NOT NULL,
  alert_count INTEGER NOT NULL CHECK (alert_count >= 0),
  alerts_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_queue_health_checks_status_observed
  ON queue_health_checks(status, observed_at DESC);
