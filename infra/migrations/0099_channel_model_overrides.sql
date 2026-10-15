-- Owner/admin-selected model override for each connected customer channel.
ALTER TABLE channel_links ADD COLUMN model_override TEXT;
