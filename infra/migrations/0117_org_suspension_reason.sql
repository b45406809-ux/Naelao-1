-- Preserve the suspension source at the tenant level so erasure cancellation cannot
-- reactivate an organization held by an administrator or another platform control.
ALTER TABLE orgs ADD COLUMN suspension_reason TEXT;
