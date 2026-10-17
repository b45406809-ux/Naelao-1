-- Optional project-bound public channel extension. The script digest pins the handler source
-- selected by an owner/admin until they explicitly rebind after a source update.
ALTER TABLE channel_links ADD COLUMN extension_instance_id TEXT;
ALTER TABLE channel_links ADD COLUMN extension_script_sha256 TEXT;
