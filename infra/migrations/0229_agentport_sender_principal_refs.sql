-- Preserve the owner-attested AgentPort principal mapping on metadata-only inbound refs so
-- authorized consumers can resolve a sender without treating the provider sender ID as identity.
ALTER TABLE agentport_channel_message_refs ADD COLUMN sender_principal_id TEXT;

UPDATE agentport_channel_message_refs AS ref
SET sender_principal_id=(
  SELECT sender.principal_id FROM agentport_trusted_senders AS sender
  WHERE sender.tenant_id=ref.tenant_id AND sender.channel_id=ref.channel_id
    AND sender.provider_sender_id=ref.sender_id
  LIMIT 1
)
WHERE ref.direction='inbound' AND ref.trust_level='verified';
