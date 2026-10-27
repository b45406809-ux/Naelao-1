CREATE TABLE IF NOT EXISTS space_blackboard_sharing_policies (
 tenant_id TEXT NOT NULL, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE, project_id TEXT NOT NULL,
 authorized_user_id TEXT NOT NULL, peers_json TEXT NOT NULL, daily_limit INTEGER NOT NULL CHECK(daily_limit BETWEEN 0 AND 50), updated_at TEXT NOT NULL,
 PRIMARY KEY(tenant_id,space_id,project_id)
);
CREATE TABLE IF NOT EXISTS space_blackboard_policy_uses (
 tenant_id TEXT NOT NULL, space_id TEXT NOT NULL, project_id TEXT NOT NULL, action_key TEXT NOT NULL,
 payload_hash TEXT NOT NULL, user_id TEXT NOT NULL, used_day TEXT NOT NULL,
 PRIMARY KEY(tenant_id,space_id,project_id,action_key)
);
CREATE INDEX IF NOT EXISTS space_blackboard_policy_day ON space_blackboard_policy_uses(tenant_id,space_id,project_id,used_day);
