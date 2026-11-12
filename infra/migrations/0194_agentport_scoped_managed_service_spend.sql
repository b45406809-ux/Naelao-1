-- Parent-funded managed-service use can be explicitly delegated to one AgentPort agent.
-- The org remains the charged payer; this does not imply an agent wallet or funded balance.
ALTER TABLE managed_service_payer_mandates ADD COLUMN agentport_agent_id TEXT;
ALTER TABLE managed_service_payer_mandates ADD COLUMN max_credits_per_period INTEGER
  CHECK(max_credits_per_period IS NULL OR max_credits_per_period > 0);
ALTER TABLE managed_service_payer_mandates ADD COLUMN period_days INTEGER NOT NULL DEFAULT 30
  CHECK(period_days BETWEEN 1 AND 366);

ALTER TABLE managed_service_credit_reservations ADD COLUMN agentport_agent_id TEXT;
ALTER TABLE managed_service_credit_reservations ADD COLUMN payer_mandate_id TEXT;
-- Existing AgentMail mandate keys already bind one operation to one stable AgentPort agent ID.
UPDATE managed_service_payer_mandates SET agentport_agent_id=substr(mandate_key,11)
  WHERE payer_type='organization' AND mandate_key LIKE 'agentmail:%' AND agentport_agent_id IS NULL;
-- AgentMail permits at most two 300-credit effects in any 30-day window: initial provisioning
-- and a monthly rental at the billing boundary. Per-operation admission remains capped at 300.
UPDATE managed_service_payer_mandates SET max_credits_per_period=max_credits_per_operation * 2,period_days=30
  WHERE payer_type='organization' AND mandate_key LIKE 'agentmail:%' AND max_credits_per_period IS NULL;
CREATE INDEX IF NOT EXISTS idx_managed_service_reservations_agent_period
  ON managed_service_credit_reservations(org_id,agentport_agent_id,payer_mandate_id,status,created_at);
