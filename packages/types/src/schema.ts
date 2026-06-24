// SpaceDO SQL Schema Constants — all raw SQL lives here

export const CREATE_SCHEMA_VERSION = `
CREATE TABLE IF NOT EXISTS schema_version (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL DEFAULT 0
)`;

export const SEED_SCHEMA_VERSION = `INSERT OR IGNORE INTO schema_version (id, version) VALUES (1, 0)`;

export const CREATE_SPACES = `
CREATE TABLE IF NOT EXISTS spaces (
  space_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  owner_user_id TEXT NOT NULL,
  space_type TEXT NOT NULL DEFAULT 'standard',
  billing_portal_url TEXT,
  plan_id TEXT,
  plan_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
)`;

export const CREATE_MEMBERS = `
CREATE TABLE IF NOT EXISTS members (
  member_id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  invited_by TEXT,
  joined_at INTEGER NOT NULL,
  deleted_at INTEGER,
  UNIQUE(space_id, user_id)
)`;

export const CREATE_NODES = `
CREATE TABLE IF NOT EXISTS nodes (
  node_id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  node_type TEXT NOT NULL,
  label TEXT,
  data TEXT NOT NULL DEFAULT '{}',
  position_x REAL NOT NULL DEFAULT 0,
  position_y REAL NOT NULL DEFAULT 0,
  parent_node_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
)`;

export const CREATE_EDGES = `
CREATE TABLE IF NOT EXISTS edges (
  edge_id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  source_node_id TEXT NOT NULL,
  target_node_id TEXT NOT NULL,
  edge_type TEXT NOT NULL DEFAULT 'default',
  data TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`;

export const CREATE_SPACE_CREDITS = `
CREATE TABLE IF NOT EXISTS space_credits (
  space_id TEXT PRIMARY KEY,
  balance_credits INTEGER NOT NULL DEFAULT 0,
  reserved_credits INTEGER NOT NULL DEFAULT 0,
  daily_spent_credits INTEGER NOT NULL DEFAULT 0,
  daily_limit_credits INTEGER NOT NULL DEFAULT 1000000,
  daily_reset_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`;

export const CREATE_SPACE_SETTINGS = `
CREATE TABLE IF NOT EXISTS space_settings (
  space_id TEXT PRIMARY KEY,
  settings TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
)`;

export const CREATE_AUDIT_LOG = `
CREATE TABLE IF NOT EXISTS space_audit_log (
  log_id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_id TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
)`;

export const CREATE_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_members_space_id ON members(space_id)`,
  `CREATE INDEX IF NOT EXISTS idx_members_user_id ON members(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_members_space_user ON members(space_id, user_id) WHERE deleted_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_nodes_space_id ON nodes(space_id) WHERE deleted_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_node_id) WHERE parent_node_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(space_id, node_type) WHERE deleted_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_edges_space_id ON edges(space_id)`,
  `CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_node_id)`,
  `CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_node_id)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_space ON space_audit_log(space_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_actor ON space_audit_log(actor_user_id)`,
];

export function runMigrations(sql: SqlStorage): void {
  sql.exec(CREATE_SCHEMA_VERSION);
  sql.exec(SEED_SCHEMA_VERSION);
  sql.exec(CREATE_SPACES);
  sql.exec(CREATE_MEMBERS);
  sql.exec(CREATE_NODES);
  sql.exec(CREATE_EDGES);
  sql.exec(CREATE_SPACE_CREDITS);
  sql.exec(CREATE_SPACE_SETTINGS);
  sql.exec(CREATE_AUDIT_LOG);
  for (const idx of CREATE_INDEXES) {
    sql.exec(idx);
  }

  const vRow = [...sql.exec<{ version: number }>('SELECT version FROM schema_version')][0];
  let v = vRow?.version ?? 0;

  if (v < 1) {
    try { sql.exec('ALTER TABLE spaces ADD COLUMN billing_portal_url TEXT'); } catch { /* column exists */ }
    sql.exec('UPDATE schema_version SET version = 1 WHERE id = 1');
    v = 1;
  }

  if (v < 2) {
    try { sql.exec('ALTER TABLE spaces ADD COLUMN plan_id TEXT'); } catch { /* column exists */ }
    try { sql.exec('ALTER TABLE spaces ADD COLUMN plan_expires_at INTEGER'); } catch { /* column exists */ }
    sql.exec('UPDATE schema_version SET version = 2 WHERE id = 1');
    v = 2;
  }
}
