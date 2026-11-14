-- Pin public Telnyx DTMF calls to the published phone-extension settings used at admission.
-- Existing calls stay explicitly unpinned because their settings revision cannot be inferred.
ALTER TABLE assistant_telnyx_extension_calls ADD COLUMN settings_revision INTEGER
  CHECK(settings_revision IS NULL OR settings_revision >= 0);
ALTER TABLE assistant_telnyx_extension_calls ADD COLUMN settings_pinned INTEGER NOT NULL DEFAULT 0
  CHECK(settings_pinned IN (0,1));
