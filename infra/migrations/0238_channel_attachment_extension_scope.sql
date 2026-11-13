-- Fence extension media access to the exact channel installation that received a message.
ALTER TABLE channel_attachments ADD COLUMN project_id TEXT;
ALTER TABLE channel_attachments ADD COLUMN installation_id TEXT;
ALTER TABLE channel_attachments ADD COLUMN provider_connection_id TEXT;

CREATE INDEX IF NOT EXISTS idx_channel_attachments_extension_scope
  ON channel_attachments(tenant_id, space_id, task_id, channel, project_id, installation_id, provider_connection_id, expires_at);
