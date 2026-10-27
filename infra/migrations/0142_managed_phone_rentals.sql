-- One Naelao plan-metered phone rental per managed Telnyx binding and UTC billing month.
CREATE TABLE IF NOT EXISTS assistant_managed_phone_rentals (
  binding_id TEXT NOT NULL REFERENCES assistant_phone_bindings(id) ON DELETE CASCADE,
  billing_period TEXT NOT NULL CHECK(billing_period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  workflow_id TEXT NOT NULL UNIQUE,
  credits INTEGER NOT NULL CHECK(credits>0),
  status TEXT NOT NULL CHECK(status IN ('pending','running','paid','held')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL,
  lease_until INTEGER,
  last_error TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(binding_id,billing_period)
);
CREATE INDEX IF NOT EXISTS assistant_managed_phone_rentals_due
  ON assistant_managed_phone_rentals(status,next_at,lease_until);
