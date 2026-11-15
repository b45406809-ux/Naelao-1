-- A product account can own MicroApp actors in several independently sharded Spaces. Persist
-- the account-level fence before fan-out so a failed SpaceDO call cannot leave another Space's
-- product-user runtime reachable while cleanup is pending.
ALTER TABLE product_end_users ADD COLUMN erasure_started_at TEXT;
