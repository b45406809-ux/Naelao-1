-- Keep the authoritative Billing hold attached to the exact project-main allocation generation.
-- This is a control-plane reservation receipt, not evidence of provider health or provider invoices.
ALTER TABLE project_main_runtime_registry ADD COLUMN budget_reservation_id TEXT;

CREATE INDEX IF NOT EXISTS idx_project_main_runtime_budget_reservation
  ON project_main_runtime_registry(budget_reservation_id);
