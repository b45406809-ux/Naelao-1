-- One active extension owns each WhatsApp phone number globally. Meta delivers inbound
-- messages to an app-level webhook without a Naelao tenant or installation ID, so a narrower
-- uniqueness scope would make some callbacks ambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS idx_extension_provider_whatsapp_phone
  ON extension_provider_connections(account_id)
  WHERE provider='whatsapp' AND status='active';
