-- Managed live-call reservations are released only after their one-time code is unused,
-- expired or revoked. Preserve retry state when Billing is unavailable.
ALTER TABLE assistant_live_calls ADD COLUMN managed_reservation_status TEXT NOT NULL DEFAULT 'none'
  CHECK(managed_reservation_status IN ('none','pending','held','release_pending','released','settled'));
ALTER TABLE assistant_live_calls ADD COLUMN managed_reservation_attempts INTEGER NOT NULL DEFAULT 0
  CHECK(managed_reservation_attempts >= 0);
ALTER TABLE assistant_live_calls ADD COLUMN managed_reservation_last_error TEXT;
ALTER TABLE assistant_live_calls ADD COLUMN managed_reservation_updated_at INTEGER;

CREATE INDEX assistant_live_call_reservation_reconcile
  ON assistant_live_calls(managed_reservation_status,status,expires_at);
