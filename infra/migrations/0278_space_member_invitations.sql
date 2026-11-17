-- Owner-reviewed, email-bound product-member invitations. Delivery is intentionally external
-- to this ledger: the API reveals a token once for copy-only use and never sends it.
CREATE TABLE IF NOT EXISTS space_member_invitations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  inviter_user_id TEXT NOT NULL,
  recipient_email_hash TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('viewer','member','admin')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','revoked','expired')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  redeemed_by TEXT,
  redeemed_at TEXT,
  revoked_by TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_space_member_invitations_scope
  ON space_member_invitations(tenant_id,space_id,status,created_at);
CREATE INDEX IF NOT EXISTS idx_space_member_invitations_recipient
  ON space_member_invitations(product_id,recipient_email_hash,status,expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_space_member_invitations_pending_recipient
  ON space_member_invitations(tenant_id,space_id,recipient_email_hash) WHERE status='pending';

CREATE TRIGGER IF NOT EXISTS trg_space_member_invitations_space_deleted
AFTER UPDATE OF status ON spaces
WHEN NEW.status='deleted' AND OLD.status!='deleted'
BEGIN
  UPDATE space_member_invitations SET status='revoked',revoked_at=datetime('now')
   WHERE space_id=NEW.id AND tenant_id=NEW.tenant_id AND status='pending';
END;
