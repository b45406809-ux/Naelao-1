-- Bind managed Telnyx retail rates to the owner-approved phone activation. Runtime
-- configuration changes must not silently reprice existing numbers or pending operations.
ALTER TABLE assistant_phone_bindings ADD COLUMN managed_price_version TEXT;
ALTER TABLE assistant_phone_bindings ADD COLUMN managed_rental_credits_per_month INTEGER
  CHECK(managed_rental_credits_per_month IS NULL OR managed_rental_credits_per_month > 0);
ALTER TABLE assistant_phone_bindings ADD COLUMN managed_sms_credits_per_segment INTEGER
  CHECK(managed_sms_credits_per_segment IS NULL OR managed_sms_credits_per_segment > 0);
ALTER TABLE assistant_phone_bindings ADD COLUMN managed_call_credits_per_minute INTEGER
  CHECK(managed_call_credits_per_minute IS NULL OR managed_call_credits_per_minute > 0);

ALTER TABLE assistant_managed_phone_rentals ADD COLUMN price_version TEXT;
ALTER TABLE assistant_phone_actions ADD COLUMN managed_price_version TEXT;
ALTER TABLE assistant_phone_actions ADD COLUMN managed_reserved_credits INTEGER
  CHECK(managed_reserved_credits IS NULL OR managed_reserved_credits >= 0);
ALTER TABLE assistant_live_calls ADD COLUMN managed_price_version TEXT;
ALTER TABLE assistant_managed_telnyx_message_costs ADD COLUMN price_version TEXT;
