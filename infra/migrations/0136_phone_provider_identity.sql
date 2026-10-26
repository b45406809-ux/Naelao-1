-- Preserve all existing numbers and callbacks as Twilio. Provider resource IDs are opaque
-- within a carrier; the E.164 address remains globally unique across active bindings.
ALTER TABLE assistant_phone_bindings ADD COLUMN provider TEXT NOT NULL DEFAULT 'twilio'
  CHECK(provider IN ('twilio','telnyx'));
ALTER TABLE assistant_phone_quotes ADD COLUMN provider TEXT NOT NULL DEFAULT 'twilio'
  CHECK(provider IN ('twilio','telnyx'));
DROP INDEX assistant_phone_active_number;
CREATE UNIQUE INDEX assistant_phone_active_number
  ON assistant_phone_bindings(provider,provider_number_sid)
  WHERE status NOT IN ('released','detached');
