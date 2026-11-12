-- Persist customer-owned Telnyx number purchases before dispatch. Provider order
-- creation can incur charges, so ambiguous outcomes are reconciled by the stable
-- customer_reference and are never blindly submitted again.
ALTER TABLE assistant_phone_quotes ADD COLUMN upfront_cost_minor INTEGER NOT NULL DEFAULT 0 CHECK(upfront_cost_minor>=0);
ALTER TABLE assistant_phone_quotes ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD' CHECK(currency='USD');

CREATE TABLE assistant_telnyx_number_order_operations (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL REFERENCES assistant_communication_identities(id) ON DELETE CASCADE,
  quote_id TEXT NOT NULL UNIQUE REFERENCES assistant_phone_quotes(id),
  binding_id TEXT NOT NULL UNIQUE REFERENCES assistant_phone_bindings(id),
  provider_account_ref TEXT NOT NULL,
  customer_reference TEXT NOT NULL UNIQUE,
  phone_number TEXT NOT NULL,
  country_code TEXT NOT NULL,
  upfront_cost_minor INTEGER NOT NULL CHECK(upfront_cost_minor>=0),
  monthly_cost_minor INTEGER NOT NULL CHECK(monthly_cost_minor>=0),
  currency TEXT NOT NULL CHECK(currency='USD'),
  status TEXT NOT NULL CHECK(status IN ('prepared','submitting','uncertain','pending','succeeded','failed')),
  provider_order_id TEXT,
  provider_number_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX assistant_telnyx_number_order_provider_order
  ON assistant_telnyx_number_order_operations(provider_account_ref,provider_order_id)
  WHERE provider_order_id IS NOT NULL;
CREATE INDEX assistant_telnyx_number_order_owner_status
  ON assistant_telnyx_number_order_operations(identity_id,status,updated_at DESC);
