ALTER TABLE assistant_verification_waits ADD COLUMN transport TEXT NOT NULL DEFAULT 'email';
ALTER TABLE assistant_verification_waits ADD COLUMN phone_binding_id TEXT REFERENCES assistant_phone_bindings(id) ON DELETE SET NULL;
-- An SMS number has no per-website alias. Serialize pending verification across its websites.
CREATE UNIQUE INDEX assistant_phone_verification_active ON assistant_verification_waits(phone_binding_id)
 WHERE transport='sms' AND status IN ('waiting','received');
