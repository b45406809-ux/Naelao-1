-- Tier 2/3 follow-up: GDPR Art. 17 erasure existed for product_end_users' export (ProductUserDO's
-- GET /export, GDPR Art. 20) but not deletion — an end user had a way to download their data, but
-- no way to actually have it erased. `deleted_at` marks a roster row whose PII (email/
-- display_name/password_hash) has been anonymized by DELETE /spaces/:spaceId/product-users/me —
-- the row itself is kept (not hard-deleted) so foreign-key-shaped references elsewhere
-- (business_memberships, agent_activity_log) don't orphan, same soft-delete precedent as `spaces.
-- status='deleted'` uses elsewhere in this schema.
ALTER TABLE product_end_users ADD COLUMN deleted_at TEXT;
