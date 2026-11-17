-- Invitations may optionally carry a proposal-only builder role, pinned to the exact
-- certified artifact selected by the current owner. No effective grants are implied.
ALTER TABLE space_member_invitations ADD COLUMN blueprint_id TEXT;
ALTER TABLE space_member_invitations ADD COLUMN artifact_sha256 TEXT;
ALTER TABLE space_member_invitations ADD COLUMN business_role_id TEXT;

CREATE TRIGGER IF NOT EXISTS trg_space_member_invitation_role_insert
BEFORE INSERT ON space_member_invitations
WHEN NOT (
  (NEW.blueprint_id IS NULL AND NEW.artifact_sha256 IS NULL AND NEW.business_role_id IS NULL)
  OR
  (NEW.blueprint_id IS NOT NULL AND NEW.artifact_sha256 IS NOT NULL AND NEW.business_role_id IS NOT NULL
    AND length(NEW.artifact_sha256)=64)
)
BEGIN
  SELECT RAISE(ABORT,'space_member_invitation_role_binding_invalid');
END;

CREATE TRIGGER IF NOT EXISTS trg_space_member_invitation_role_update
BEFORE UPDATE OF blueprint_id,artifact_sha256,business_role_id ON space_member_invitations
WHEN NOT (
  (NEW.blueprint_id IS NULL AND NEW.artifact_sha256 IS NULL AND NEW.business_role_id IS NULL)
  OR
  (NEW.blueprint_id IS NOT NULL AND NEW.artifact_sha256 IS NOT NULL AND NEW.business_role_id IS NOT NULL
    AND length(NEW.artifact_sha256)=64)
)
BEGIN
  SELECT RAISE(ABORT,'space_member_invitation_role_binding_invalid');
END;
