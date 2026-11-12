-- Persist scheduled read-only recovery for customer-owned Telnyx number orders.
ALTER TABLE assistant_telnyx_number_order_operations ADD COLUMN reconcile_attempts INTEGER NOT NULL DEFAULT 0 CHECK(reconcile_attempts>=0);
ALTER TABLE assistant_telnyx_number_order_operations ADD COLUMN next_reconcile_at TEXT;
ALTER TABLE assistant_telnyx_number_order_operations ADD COLUMN lease_until TEXT;
ALTER TABLE assistant_telnyx_number_order_operations ADD COLUMN last_reconciled_at TEXT;

CREATE INDEX assistant_telnyx_number_order_due
  ON assistant_telnyx_number_order_operations(status,next_reconcile_at,lease_until,updated_at);
