-- Persist provisioning intent with the space row so a Queue outage or lost send response
-- cannot strand a space in `provisioning` without a message to resume it.
CREATE TABLE IF NOT EXISTS space_provisioning_outbox (
  space_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'cancelled')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_space_provisioning_outbox_retry
  ON space_provisioning_outbox(status, next_attempt_at, created_at);
