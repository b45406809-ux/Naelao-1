-- Preserve the Naelao identity granted by a paid seat so a later provider refund can revoke
-- exactly that membership even if the provider no longer includes checkout custom_data.
ALTER TABLE launchpad_orders ADD COLUMN seat_user_id TEXT;

CREATE INDEX IF NOT EXISTS idx_launchpad_orders_seat_user
  ON launchpad_orders(space_id, seat_user_id) WHERE seat_user_id IS NOT NULL;
