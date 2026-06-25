-- G-AN09: Usage metering idempotency key — prevents double-charge on queue retry.
-- event_hash is sha256(space_id || user_id || recorded_at_minute || event_type).
-- The UNIQUE constraint means at-least-once queue delivery can INSERT OR IGNORE safely.
ALTER TABLE usage_events ADD COLUMN event_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_events_hash ON usage_events(event_hash) WHERE event_hash IS NOT NULL;
