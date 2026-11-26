-- MS-46 / MR-EVT-3: a verified provider event whose resource cannot be resolved to exactly one tenant is dead-lettered, never guessed.
-- References only: no request body is stored. Written only behind PROVIDER_EVENT_MODULE_ENABLED. Not applied remotely by the task that added it.
CREATE TABLE IF NOT EXISTS provider_event_dead_letters (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL DEFAULT '',
  resource_ref TEXT,
  reason TEXT NOT NULL,
  body_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (provider, event_id, event_type, reason)
);
CREATE INDEX IF NOT EXISTS idx_provider_event_dead_letters_created ON provider_event_dead_letters(created_at);
