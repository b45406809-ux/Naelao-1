-- Queue events log — append-only audit of processed queue messages
CREATE TABLE IF NOT EXISTS queue_events_log (
  id           TEXT PRIMARY KEY,
  event_type   TEXT NOT NULL,
  payload      TEXT NOT NULL DEFAULT '{}',
  status       TEXT NOT NULL DEFAULT 'processed',
  processed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_queue_log_type ON queue_events_log(event_type, processed_at DESC);
