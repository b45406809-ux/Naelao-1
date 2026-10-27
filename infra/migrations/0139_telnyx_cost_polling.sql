CREATE TABLE IF NOT EXISTS assistant_telnyx_cost_polls (
  action_id TEXT PRIMARY KEY REFERENCES assistant_phone_actions(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('pending','running','observed','held','expired')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL,
  lease_until INTEGER,
  last_error TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS assistant_telnyx_cost_due ON assistant_telnyx_cost_polls(status,next_at,lease_until);
