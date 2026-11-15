-- Scheduled UserPort recovery must find connector operations whose worker lease expired
-- before a terminal receipt was written.
CREATE INDEX IF NOT EXISTS idx_managed_service_operations_expired_userport
  ON managed_service_operations(lease_until, created_at)
  WHERE operation_name IN ('agentport_connector_sync','agentport_connector_revoke') AND status='running';
