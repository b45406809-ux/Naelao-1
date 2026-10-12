-- Bug fix (business-wallet audit): whop_payout_requests.approval_token_hash never expired — a single
-- emailed link that moves real money would work forever, unlike every comparable token in this
-- codebase (business_invites, password_reset_tokens: hashed + single-use + 7-day-expiring). Add
-- the missing expiry column; a NULL means "not yet backfilled" and is treated as expired by the
-- application (fails closed, never open) rather than requiring a data migration.

ALTER TABLE whop_payout_requests ADD COLUMN expires_at TEXT;
