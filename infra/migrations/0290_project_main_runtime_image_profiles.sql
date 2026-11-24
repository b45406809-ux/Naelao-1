-- Persist the owner-selected immutable Project image profile separately from its size tier.
-- Profile IDs refer to host-approved deployment metadata; the database never stores image URLs.
ALTER TABLE project_main_runtime_profiles
  ADD COLUMN image_profile_id TEXT NOT NULL DEFAULT 'base';

ALTER TABLE project_main_runtime_profile_audit
  ADD COLUMN previous_image_profile_id TEXT;

ALTER TABLE project_main_runtime_profile_audit
  ADD COLUMN new_image_profile_id TEXT NOT NULL DEFAULT 'base';
