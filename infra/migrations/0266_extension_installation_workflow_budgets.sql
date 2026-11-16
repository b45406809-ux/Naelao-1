-- Pin the owner-approved installation budget that admitted each workflow reservation.
ALTER TABLE workflow_budget_reservations
  ADD COLUMN installation_budget_credits INTEGER CHECK (installation_budget_credits IS NULL OR installation_budget_credits > 0);
ALTER TABLE workflow_budget_reservations
  ADD COLUMN installation_budget_revision INTEGER CHECK (installation_budget_revision IS NULL OR installation_budget_revision > 0);
CREATE INDEX IF NOT EXISTS idx_workflow_budget_installation_status
  ON workflow_budget_reservations(org_id, installation_id, status, expires_at);
