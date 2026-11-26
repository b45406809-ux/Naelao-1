-- MS-48 item 7: usage_events gains a nullable metadata_json column. Billing writes it only for rows whose caller
-- supplied metadata (today: MS-16 extension resource unit rows carry {"priced_in_settlement":true,"price_version":...}),
-- so rows without metadata, and the INSERT statement for them, are unchanged. Additive and nullable: safe to apply before
-- or after the Billing code that reads it. Not applied remotely by the task that added it.
ALTER TABLE usage_events ADD COLUMN metadata_json TEXT;
