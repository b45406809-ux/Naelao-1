-- Channel pairings: which external conversation/workspace belongs to which business.
--
-- The existing channel_links table answers "does this space have Slack?" — one row per
-- (space, channel), keyed by the space. Platform-app pairing needs the question asked the other
-- way round: a message arrives at Naelao's OWN bot carrying a Telegram chat id or a Slack team id,
-- and we have to find the business it belongs to. There is no space in the URL to look it up with.
--
-- Kept separate from channel_links rather than bolted onto it because the two really are different
-- facts. channel_links says a channel is configured and which project it drives; this says a
-- specific outside conversation is bound to a specific business. A space can have several
-- pairings on one channel (two Discord servers, several Telegram chats) and they all point at the
-- same link row.
CREATE TABLE IF NOT EXISTS channel_pairings (
  channel TEXT NOT NULL,
  -- The channel's own id for the thing that was paired: a Telegram chat id, a Slack team id, a
  -- Discord guild id, a WhatsApp sender id.
  external_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  -- Bind to a customer-bot project instead of the Space Assistant, mirroring channel_links.
  project_id TEXT,
  -- Who completed the pairing, so a binding is attributable after the fact.
  paired_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (channel, external_id)
);

-- Listing a business's pairings, and unbinding them all when a business is deleted.
CREATE INDEX IF NOT EXISTS idx_channel_pairings_space ON channel_pairings(space_id, channel);
