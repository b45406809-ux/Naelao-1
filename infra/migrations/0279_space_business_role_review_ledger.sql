-- Owner-reviewed builder role selection is durable audit intent only. It never mints grants.
CREATE TABLE IF NOT EXISTS space_business_role_reviews (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  end_user_id TEXT NOT NULL,
  membership_created_at TEXT NOT NULL,
  membership_role TEXT NOT NULL,
  blueprint_id TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL CHECK(length(artifact_sha256)=64),
  business_role_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposal_only' CHECK(status IN ('proposal_only','revoked')),
  grants_applied INTEGER NOT NULL DEFAULT 0 CHECK(grants_applied=0),
  reviewed_by TEXT NOT NULL,
  reviewed_at TEXT NOT NULL,
  revoked_by TEXT,
  revoked_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_space_business_role_review_active
  ON space_business_role_reviews(tenant_id,space_id,end_user_id,blueprint_id,artifact_sha256,business_role_id)
  WHERE status='proposal_only';
CREATE INDEX IF NOT EXISTS idx_space_business_role_review_member
  ON space_business_role_reviews(tenant_id,space_id,end_user_id,status,reviewed_at);

CREATE TRIGGER IF NOT EXISTS trg_space_business_role_review_space_deleted
AFTER UPDATE OF status ON spaces
WHEN NEW.status='deleted' AND OLD.status!='deleted'
BEGIN
  UPDATE space_business_role_reviews SET status='revoked',revoked_at=datetime('now')
   WHERE space_id=NEW.id AND tenant_id=NEW.tenant_id AND status='proposal_only';
END;

CREATE TRIGGER IF NOT EXISTS trg_space_business_role_review_member_changed
AFTER UPDATE OF role,suspended_at ON space_members
WHEN NEW.role!=OLD.role OR NEW.suspended_at IS NOT OLD.suspended_at
BEGIN
  UPDATE space_business_role_reviews SET status='revoked',revoked_at=datetime('now')
   WHERE space_id=OLD.space_id AND tenant_id=OLD.tenant_id AND end_user_id=OLD.end_user_id AND status='proposal_only';
END;

CREATE TRIGGER IF NOT EXISTS trg_space_business_role_review_member_removed
AFTER DELETE ON space_members
BEGIN
  UPDATE space_business_role_reviews SET status='revoked',revoked_at=datetime('now')
   WHERE space_id=OLD.space_id AND tenant_id=OLD.tenant_id AND end_user_id=OLD.end_user_id AND status='proposal_only';
END;
