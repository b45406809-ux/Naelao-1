-- Website accounts belong to a user and an exact assistant workspace, never the whole tenant.
CREATE TABLE website_connections (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 owner_user_id TEXT NOT NULL, project_id TEXT, name TEXT NOT NULL, start_url TEXT NOT NULL,
 origins_json TEXT NOT NULL, agent_ids_json TEXT NOT NULL DEFAULT '[]',
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX website_connections_owner ON website_connections(tenant_id,space_id,owner_user_id,status);
