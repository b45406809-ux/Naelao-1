-- Explicit, revision-bound autonomy grants and a per-run credit ceiling for scheduled jobs.
-- Empty grants preserve the existing read-safe-only autonomous policy.
ALTER TABLE scheduled_jobs ADD COLUMN approved_actions_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE scheduled_jobs ADD COLUMN max_run_credits INTEGER NOT NULL DEFAULT 0;
