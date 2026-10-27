-- Managed Telnyx outbound SMS keeps its exact plan-credit hold on the action; receipts record
-- the settled credit amount so automatic cost collection is auditable and correction-safe.
ALTER TABLE assistant_phone_actions ADD COLUMN carrier_reservation_id TEXT;
ALTER TABLE assistant_telnyx_usage_receipts ADD COLUMN managed_charge_credits INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS assistant_phone_action_carrier_reservation
  ON assistant_phone_actions(carrier_reservation_id) WHERE carrier_reservation_id IS NOT NULL;
