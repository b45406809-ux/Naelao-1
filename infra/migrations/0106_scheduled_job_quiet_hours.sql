ALTER TABLE scheduled_jobs ADD COLUMN quiet_hours_start TEXT;
ALTER TABLE scheduled_jobs ADD COLUMN quiet_hours_end TEXT;
ALTER TABLE scheduled_jobs ADD COLUMN quiet_hours_timezone TEXT NOT NULL DEFAULT 'UTC';
