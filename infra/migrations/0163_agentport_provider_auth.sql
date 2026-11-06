-- Provider declarations include auth metadata. This is descriptive onboarding data only:
-- AgentPort does not hold provider credentials or execute provider APIs. A separate table keeps
-- this migration safely repeatable in deployment jobs that replay historical SQL files.
CREATE TABLE IF NOT EXISTS agentport_provider_auth (
  tenant_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  auth_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, service_id),
  FOREIGN KEY (service_id) REFERENCES agentport_services(id) ON DELETE CASCADE
);
