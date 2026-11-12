-- Store the provider's accepted-request receipt on the existing encrypted auth-email outbox.
-- This is an acceptance receipt only; it does not establish inbox delivery or reading.
ALTER TABLE product_auth_email_outbox ADD COLUMN provider_receipt_id TEXT;
