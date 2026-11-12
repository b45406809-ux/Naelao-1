-- Managed-service settlement and its metering queue intent commit together. Queue delivery is
-- at least once; the consumer deduplicates by the immutable usage event ID.
CREATE TABLE IF NOT EXISTS managed_service_meter_outbox (
  event_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','leased','sent')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
  lease_until TEXT,
  sent_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_managed_service_meter_outbox_retry
  ON managed_service_meter_outbox(status,next_attempt_at,created_at);

CREATE TABLE IF NOT EXISTS managed_service_meter_deliveries (
  event_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  delivered_at TEXT NOT NULL
);

-- Recover older settlements whose queue send may have failed after the usage row committed.
INSERT OR IGNORE INTO managed_service_meter_outbox(event_id,org_id,payload_json,status,next_attempt_at,created_at,updated_at)
SELECT id,org_id,json_object(
  'type','meter','org_id',org_id,'space_id',space_id,'event_type',event_type,'quantity',quantity,
  'event_id',id,'event_hash',event_hash,'recorded_at',recorded_at,'schema_version',schema_version,
  'unit',unit,'rate_card_version',rate_card_version,'cost_credits',cost_credits,'run_id',run_id,
  'provider',provider,'model_id',model_id,'project_id',project_id,'payer_kind',payer_kind,'decision',decision
), 'pending',datetime('now'),recorded_at,recorded_at
FROM usage_events WHERE id LIKE 'managed-service:%' AND event_type='infra_credits';
