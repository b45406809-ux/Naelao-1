ALTER TABLE managed_service_accounts ADD COLUMN agentport_link_status TEXT
  CHECK(agentport_link_status IS NULL OR agentport_link_status IN ('pending','active','revoking','revoked','failed','unknown'));
