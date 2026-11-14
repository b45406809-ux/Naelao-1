-- Pin Twilio extension calls to the published configuration admitted at call start.
-- Historical calls remain explicitly unpinned and must not resolve to current settings.
ALTER TABLE assistant_phone_events ADD COLUMN settings_revision INTEGER
  CHECK(settings_revision IS NULL OR settings_revision >= 0);
ALTER TABLE assistant_phone_events ADD COLUMN settings_pinned INTEGER NOT NULL DEFAULT 0
  CHECK(settings_pinned IN (0,1));
