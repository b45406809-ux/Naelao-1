-- Customer-bot projects: a channel can be bound to a specific project (e.g. a "WhatsApp
-- Support Bot" project) instead of just the space's default agent. NULL = legacy behavior
-- (space-level, the default agent handles it — backward compatible with 0038).
ALTER TABLE channel_links ADD COLUMN project_id TEXT;
CREATE INDEX IF NOT EXISTS idx_channel_links_project ON channel_links(project_id) WHERE project_id IS NOT NULL;
