-- Distinguish setup compensation from ordinary disconnect/uninstall cleanup and serialize setup
-- attempts for one installed provider connection while any setup outcome remains unresolved.
ALTER TABLE extension_provider_cleanup_operations
  ADD COLUMN operation_kind TEXT NOT NULL DEFAULT 'cleanup' CHECK(operation_kind IN ('cleanup','setup'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_extension_provider_setup_pending_scope
  ON extension_provider_cleanup_operations(tenant_id,space_id,project_id,installation_id,connection_id)
  WHERE operation_kind='setup' AND status='pending';

-- Telegram bots and WhatsApp Business accounts have provider-global effects. Permit one in-flight
-- setup for a provider account at a time, even when that account is shared across Spaces.
CREATE UNIQUE INDEX IF NOT EXISTS idx_extension_provider_setup_pending_account
  ON extension_provider_cleanup_operations(provider,account_id)
  WHERE operation_kind='setup' AND status='pending';
