# Prompt 07c — SpaceDO SQL Schema Constants

## File to Generate
`packages/types/src/schema.ts`

## Context
Naelao runs entirely on Cloudflare Workers + Durable Objects. SpaceDO uses SQLite via
`this.ctx.storage.sql.exec<T>(sql, ...params)`. All SQL strings live in this constants file
so SpaceDO can import them, keeping raw SQL out of the DO logic.

## Constraints
- Export only typed string constants and helper functions — no classes
- All column names must be snake_case
- Table names: `spaces`, `members`, `nodes`, `edges`, `schema_version`, `space_credits`,
  `space_settings`, `space_audit_log`
- Every CREATE TABLE must use `IF NOT EXISTS`
- Primary keys are TEXT (UUID v4), never INTEGER AUTOINCREMENT
- All timestamps are `INTEGER` (Unix ms)
- `deleted_at` soft-delete pattern on `spaces`, `members`, `nodes`
- Include a `CREATE INDEX IF NOT EXISTS` for every foreign key column and every column
  used in WHERE clauses shown below

## Table Definitions Required

### schema_version
```
id INTEGER PRIMARY KEY CHECK (id = 1),
version INTEGER NOT NULL DEFAULT 0
```
Seeded with `INSERT OR IGNORE INTO schema_version (id, version) VALUES (1, 0)`.

### spaces
```
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
```

### members
```
member_id TEXT PRIMARY KEY,
space_id TEXT NOT NULL,
user_id TEXT NOT NULL,
role TEXT NOT NULL DEFAULT 'viewer',   -- 'owner' | 'editor' | 'viewer'
invited_by TEXT,
joined_at INTEGER NOT NULL,
deleted_at INTEGER,
UNIQUE(space_id, user_id)
```

### nodes
```
node_id TEXT PRIMARY KEY,
space_id TEXT NOT NULL,
node_type TEXT NOT NULL,
label TEXT,
data TEXT NOT NULL DEFAULT '{}',       -- JSON blob
position_x REAL NOT NULL DEFAULT 0,
position_y REAL NOT NULL DEFAULT 0,
parent_node_id TEXT,
created_at INTEGER NOT NULL,
updated_at INTEGER NOT NULL,
deleted_at INTEGER
```

### edges
```
edge_id TEXT PRIMARY KEY,
space_id TEXT NOT NULL,
source_node_id TEXT NOT NULL,
target_node_id TEXT NOT NULL,
edge_type TEXT NOT NULL DEFAULT 'default',
data TEXT NOT NULL DEFAULT '{}',
created_at INTEGER NOT NULL,
updated_at INTEGER NOT NULL
```

### space_credits
```
space_id TEXT PRIMARY KEY,
balance_credits INTEGER NOT NULL DEFAULT 0,
reserved_credits INTEGER NOT NULL DEFAULT 0,
daily_spent_credits INTEGER NOT NULL DEFAULT 0,
daily_limit_credits INTEGER NOT NULL DEFAULT 1000000,
daily_reset_at INTEGER NOT NULL,
updated_at INTEGER NOT NULL
```

### space_settings
```
space_id TEXT PRIMARY KEY,
settings TEXT NOT NULL DEFAULT '{}',   -- JSON blob
updated_at INTEGER NOT NULL
```

### space_audit_log
```
log_id TEXT PRIMARY KEY,
space_id TEXT NOT NULL,
actor_user_id TEXT NOT NULL,
action TEXT NOT NULL,
target_id TEXT,
metadata TEXT NOT NULL DEFAULT '{}',
created_at INTEGER NOT NULL
```

## Indexes Required
```sql
-- members
CREATE INDEX IF NOT EXISTS idx_members_space_id ON members(space_id);
CREATE INDEX IF NOT EXISTS idx_members_user_id ON members(user_id);
CREATE INDEX IF NOT EXISTS idx_members_space_user ON members(space_id, user_id) WHERE deleted_at IS NULL;

-- nodes
CREATE INDEX IF NOT EXISTS idx_nodes_space_id ON nodes(space_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_node_id) WHERE parent_node_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(space_id, node_type) WHERE deleted_at IS NULL;

-- edges
CREATE INDEX IF NOT EXISTS idx_edges_space_id ON edges(space_id);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_node_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_node_id);

-- audit log
CREATE INDEX IF NOT EXISTS idx_audit_space ON space_audit_log(space_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON space_audit_log(actor_user_id);
```

## Migration Helper
Export a function `runMigrations(sql: SqlStorage): void` that:
1. Creates `schema_version` table and seeds it
2. Creates all other tables
3. Creates all indexes
4. Reads current version: `SELECT version FROM schema_version`
5. Applies versioned migrations with `ALTER TABLE ADD COLUMN` (version 1+)

**Current migrations:**
- v0 → v1: Add `billing_portal_url TEXT` to `spaces` (already in CREATE TABLE above, so
  only needed if upgrading old DOs that lack the column)
- v0 → v2: Add `plan_id TEXT` and `plan_expires_at INTEGER` to `spaces`

Pattern:
```typescript
const vRow = [...sql.exec<{version:number}>('SELECT version FROM schema_version')][0];
let v = vRow?.version ?? 0;
if (v < 1) {
  try { sql.exec('ALTER TABLE spaces ADD COLUMN billing_portal_url TEXT'); } catch {}
  sql.exec('UPDATE schema_version SET version = 1 WHERE id = 1');
  v = 1;
}
if (v < 2) {
  try { sql.exec('ALTER TABLE spaces ADD COLUMN plan_id TEXT'); } catch {}
  try { sql.exec('ALTER TABLE spaces ADD COLUMN plan_expires_at INTEGER'); } catch {}
  sql.exec('UPDATE schema_version SET version = 2 WHERE id = 1');
  v = 2;
}
```
Use `try/catch` around each `ALTER TABLE` so re-running on an already-migrated DO is safe.

## Output
Generate the full TypeScript file exporting:
- `CREATE_SCHEMA_VERSION`, `CREATE_SPACES`, `CREATE_MEMBERS`, `CREATE_NODES`,
  `CREATE_EDGES`, `CREATE_SPACE_CREDITS`, `CREATE_SPACE_SETTINGS`, `CREATE_AUDIT_LOG`
  — each a `const` string of the CREATE TABLE statement
- `CREATE_INDEXES` — array of CREATE INDEX strings
- `SEED_SCHEMA_VERSION` — the INSERT OR IGNORE string
- `runMigrations(sql: SqlStorage): void` — full migration runner

All strings must be template literals (backticks) for readability.
