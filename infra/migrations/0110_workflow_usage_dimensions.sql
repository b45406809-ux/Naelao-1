ALTER TABLE workflow_budget_reservations ADD COLUMN project_id TEXT;
ALTER TABLE workflow_budget_reservations ADD COLUMN installation_id TEXT;
ALTER TABLE workflow_budget_reservations ADD COLUMN runtime_tier INTEGER CHECK (runtime_tier IS NULL OR (runtime_tier >= 1 AND runtime_tier <= 6));

CREATE INDEX IF NOT EXISTS idx_workflow_budget_project_status
  ON workflow_budget_reservations(org_id, space_id, project_id, status, expires_at);
