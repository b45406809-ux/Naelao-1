-- MS-35: optional inbox scope for Naelao Email webhooks. Not applied remotely.
-- A webhook with inbox_id NULL receives its tenant's matching events for every inbox (MS-34 behaviour).
-- A webhook with an inbox_id receives only events recorded for that inbox, so a platform that holds one
-- tenant key for many mailboxes (AgentPort) can give each mailbox owner a webhook that never sees another
-- mailbox's events.
ALTER TABLE nemail_webhooks ADD COLUMN inbox_id TEXT REFERENCES nemail_inboxes(id);
