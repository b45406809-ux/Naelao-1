-- Tier 2/3 follow-up: a proactive daily digest email for builders (agent activity summary — runs,
-- escalations, failures over the last 24h) — opt-in via productConfig.notificationsConfig.
-- dailyDigestEnabled. Tracks per-product-root send state directly on the space row (one recurring
-- digest per space, unlike scheduled_jobs' N builder-configured jobs, so a dedicated table would
-- be overkill) — the enqueueAgentTicks roster (workers/agents) uses this to fire at most once
-- per rolling 24h window.
ALTER TABLE spaces ADD COLUMN last_digest_sent_at TEXT;
