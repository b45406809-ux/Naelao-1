CREATE TABLE IF NOT EXISTS desk_drop_tickets (
  token_hash TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  project_id TEXT,
  destination TEXT NOT NULL DEFAULT 'dashboard' CHECK(destination IN ('dashboard','approvals')),
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_desk_drop_expiry ON desk_drop_tickets(expires_at);
CREATE TABLE IF NOT EXISTS desk_drop_challenges (
  id TEXT PRIMARY KEY,
  proof_hash TEXT NOT NULL UNIQUE,
  product_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
