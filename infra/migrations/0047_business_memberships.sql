-- Three-Tier Platform Model, Phase C (docs/spec-appendix A1.17): the membership index that
-- backs the Product Shell's space switcher and requireBusinessMembership's real per-business role
-- (Phase B shipped that gate treating every product_end_user as a flat "member" since no
-- businesses existed yet — this table is what makes the role real).
--
-- business_memberships is a ROUTING/INDEX table, like builder_api_key_index (migration 0045) —
-- NOT a second source of truth. SpaceDO's own `space_members` table stays authoritative for
-- actual in-space authorization; this index exists because answering "which businesses does this
-- end user belong to" (the space switcher) would otherwise require opening every SpaceDO in the
-- product to check membership, which doesn't scale. Dual-write on every join/invite-accept;
-- if this index and space_members ever disagree, space_members wins for anything security-critical
-- (a stale index row can widen a switcher listing but requireBusinessMembership's callers always
-- re-derive role from THIS table only for the coarse floor check — fine-grained per-space
-- authorization inside a business still goes through that business's own SpaceDO).
CREATE TABLE IF NOT EXISTS business_memberships (
  business_space_id TEXT NOT NULL,
  product_space_id  TEXT NOT NULL,
  end_user_id       TEXT NOT NULL,
  role              TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin', 'owner')),
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  invited_by        TEXT,
  joined_at         TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (business_space_id, end_user_id)
);
CREATE INDEX IF NOT EXISTS idx_business_memberships_end_user ON business_memberships(product_space_id, end_user_id);
CREATE INDEX IF NOT EXISTS idx_business_memberships_business ON business_memberships(business_space_id);

-- business_invites: a single-use, expiring, hashed invite token (the token itself is never
-- stored — only its hash, same precedent as PBKDF2 password storage elsewhere in this codebase).
-- accepted_at/accepted_by are set exactly once; an already-accepted or expired token can never be
-- redeemed again.
CREATE TABLE IF NOT EXISTS business_invites (
  id                TEXT PRIMARY KEY,
  business_space_id TEXT NOT NULL,
  product_space_id  TEXT NOT NULL,
  email             TEXT NOT NULL,
  role              TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin', 'owner')),
  token_hash        TEXT NOT NULL,
  invited_by        TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at        TEXT NOT NULL,
  accepted_at       TEXT,
  accepted_by       TEXT
);
CREATE INDEX IF NOT EXISTS idx_business_invites_token ON business_invites(token_hash);
CREATE INDEX IF NOT EXISTS idx_business_invites_business ON business_invites(business_space_id);
