-- Phase 4 (money): lets a builder opt their org OUT of the hard monthly/daily/weekly usage gate
-- (enforceRunGates' "quota_exceeded"/"infra_quota_exceeded" 402s) in favor of a soft overage —
-- the run is still allowed, still metered into usage_events exactly as before, just no longer
-- BLOCKED once the plan's ceiling is crossed. This is deliberately NOT a metered-billing feature —
-- there is no live billing-provider integration here that turns overage into an invoice line item
-- (that would need real metered-usage APIs against Whop/Lemon Squeezy this pass does not build).
-- It is an honest "don't cut me off mid-work" toggle: usage past the ceiling is tracked (so a
-- human can see it and follow up manually) but never silently pretended to auto-bill.
ALTER TABLE orgs ADD COLUMN allow_quota_overage INTEGER NOT NULL DEFAULT 0;
