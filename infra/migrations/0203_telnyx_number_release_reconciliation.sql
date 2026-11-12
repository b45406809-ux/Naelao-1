-- Managed Telnyx release is a paid-resource cleanup effect. Persist the exact binding and
-- provider number before DELETE; unknown outcomes are inspected read-only and never replayed.
CREATE TABLE assistant_telnyx_number_release_operations (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL REFERENCES assistant_communication_identities(id) ON DELETE CASCADE,
  binding_id TEXT NOT NULL REFERENCES assistant_phone_bindings(id) ON DELETE CASCADE,
  provider_account_fingerprint TEXT NOT NULL CHECK(length(provider_account_fingerprint)=64),
  provider_number_id TEXT NOT NULL,
  phone_number TEXT NOT NULL,
  prior_binding_status TEXT NOT NULL CHECK(prior_binding_status IN ('active','billing_hold','indeterminate')),
  status TEXT NOT NULL CHECK(status IN ('submitting','uncertain','released','failed')),
  reconcile_attempts INTEGER NOT NULL DEFAULT 0 CHECK(reconcile_attempts>=0),
  next_reconcile_at TEXT,
  lease_until TEXT,
  last_error TEXT,
  last_reconciled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX assistant_telnyx_number_release_inflight
  ON assistant_telnyx_number_release_operations(binding_id)
  WHERE status IN ('submitting','uncertain');
CREATE INDEX assistant_telnyx_number_release_due
  ON assistant_telnyx_number_release_operations(status,next_reconcile_at,lease_until,updated_at);
