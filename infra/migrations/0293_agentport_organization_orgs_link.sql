-- OD-7 / MD-1: a standalone AgentPort organization maps to exactly one Naelao `orgs` row.
-- Nullable: existing AgentPort organizations are NOT backfilled by this migration.
-- Written only when AGENTPORT_ORG_LINK_ENABLED is "true"; never re-pointed once set.
ALTER TABLE agentport_organizations ADD COLUMN org_id TEXT REFERENCES orgs(id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agentport_organizations_org_id
  ON agentport_organizations(org_id) WHERE org_id IS NOT NULL;
