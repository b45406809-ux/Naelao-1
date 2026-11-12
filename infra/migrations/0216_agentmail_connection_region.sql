-- Retain the upstream API region for customer-owned inboxes so later provider requests
-- use the same documented regional endpoint selected when the connection was verified.
ALTER TABLE assistant_agentmail_accounts
  ADD COLUMN provider_region TEXT CHECK(provider_region IS NULL OR provider_region IN ('us','eu'));
