-- space_credentials: the encrypted credential vault the naelao-credentials worker reads/writes.
-- G-C01/G-AH07 described this table but no migration ever created it — the worker would throw
-- at runtime against a real D1. Created here WITH the credential hierarchy (CLAUDE.md open
-- follow-up) built in from the start rather than retrofitted:
--
--   per-user (default)  — scope='user', user_id=<owner>. A member's own connected credential
--                          (e.g. their personal email/OAuth token) for a given name.
--   per-space (shared)  — scope='space', user_id=NULL. The space-wide default (e.g. a shared
--                          company email) used when the acting user has no personal credential.
--   privileged override — scope='space' with is_override=1. Settable only by owner/admin
--                          (enforced by the worker, not the DB). When set, this ALWAYS wins
--                          over a member's personal credential of the same name — an admin can
--                          force everyone onto one company-managed credential.
--
-- Resolution order (see workers/credentials/src/index.ts resolveCredential()):
--   1. space-scope row with is_override=1        (privileged override — always wins)
--   2. user-scope row for the acting user         (personal, default)
--   3. space-scope row with is_override=0         (shared fallback)
CREATE TABLE IF NOT EXISTS space_credentials (
  id              TEXT PRIMARY KEY,
  space_id        TEXT NOT NULL,
  tenant_id       TEXT NOT NULL,
  name            TEXT NOT NULL,
  scope           TEXT NOT NULL DEFAULT 'space' CHECK (scope IN ('user', 'space')),
  -- NULL for scope='space'; the owning member's user id for scope='user'.
  user_id         TEXT,
  -- Only meaningful (and only settable by a privileged caller) on scope='space' rows.
  is_override     INTEGER NOT NULL DEFAULT 0,
  encrypted_value TEXT NOT NULL,
  iv              TEXT NOT NULL,
  key_version     TEXT NOT NULL DEFAULT 'v1',
  description     TEXT,
  created_by      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- At most one user-scoped credential per (space, name, user).
CREATE UNIQUE INDEX IF NOT EXISTS idx_space_credentials_user
  ON space_credentials(space_id, name, user_id) WHERE scope = 'user';

-- At most one space-scoped credential per (space, name) — the shared default or its override,
-- never both (an override IS the space-level row; is_override just changes how it resolves).
CREATE UNIQUE INDEX IF NOT EXISTS idx_space_credentials_space
  ON space_credentials(space_id, name) WHERE scope = 'space';

CREATE INDEX IF NOT EXISTS idx_space_credentials_tenant ON space_credentials(tenant_id);
CREATE INDEX IF NOT EXISTS idx_space_credentials_user_lookup ON space_credentials(space_id, user_id) WHERE scope = 'user';
