-- G-D11: Platform DLQ failure tracking table.
-- Dead-letter queue messages are written here before the 4-day CF retention window expires.
CREATE TABLE IF NOT EXISTS platform_failures (
  id            TEXT PRIMARY KEY,
  message_type  TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  failure_reason TEXT,
  failed_at     TEXT NOT NULL DEFAULT (datetime('now')),
  retry_count   INTEGER NOT NULL DEFAULT 0,
  reviewed      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_platform_failures_type ON platform_failures(message_type, failed_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_failures_reviewed ON platform_failures(reviewed, failed_at DESC);
