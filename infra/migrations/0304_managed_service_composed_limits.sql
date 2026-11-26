-- MS-39 (V-spec MR-COM-10/11): composed spending-limit admission for Managed credit reservations.
-- Not applied to any remote database by the repository. Used only with MANAGED_LIMITS_COMPOSED_ENABLED="true" in Billing.
--
-- `composed_limits_json` records the externally owned limits a reservation was admitted under (per-install, per-goal,
-- Project spend, grant maxSpend), each as {kind, scope_key, headroom_credits}. Billing sums its own active reservations
-- that carry the same kind+scope_key inside the reservation INSERT, so parallel reserves cannot exceed a scope's headroom.
-- NULL for every reservation made with the flag off.
ALTER TABLE managed_service_credit_reservations ADD COLUMN composed_limits_json TEXT;
