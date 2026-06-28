-- G-AD02: Add token_version counter to users for strongly-consistent session revocation.
-- Incrementing token_version atomically invalidates ALL active tokens for that user.
ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;
