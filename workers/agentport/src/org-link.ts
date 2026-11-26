// OD-7 / MD-1: link a standalone AgentPort organization to exactly one Naelao `orgs` row.
// The orgs id is derived from the AgentPort tenant id, so a replay is INSERT OR IGNORE and never
// creates a second row. A link is never merged, re-pointed, or made to a row owned by someone else.

export const orgLinkEnabled = (env: { AGENTPORT_ORG_LINK_ENABLED?: string }) => env.AGENTPORT_ORG_LINK_ENABLED === "true";
export const linkedOrgId = (tenantId: string) => `agentport-${tenantId}`;

/** Statements for the registration batch: orgs row first, then the AgentPort org carrying `org_id`. */
export function buildLinkedOrgStatements(db: D1Database, input: { tenantId: string; name: string; ownerDeveloperId: string; at: string }): D1PreparedStatement[] {
  const orgId = linkedOrgId(input.tenantId);
  return [
    db.prepare("INSERT OR IGNORE INTO orgs(id,name,owner_id,plan_tier,status,created_at) VALUES(?,?,?,'free','active',?)").bind(orgId, input.name, input.ownerDeveloperId, input.at),
    db.prepare("INSERT INTO agentport_organizations(id,name,owner_developer_id,status,org_id,created_at,updated_at) VALUES(?,?,?,'active',?,?,?)").bind(input.tenantId, input.name, input.ownerDeveloperId, orgId, input.at, input.at),
  ];
}

export type LinkResult = { ok: true; orgId: string; created: boolean } | { ok: false; error_code: "agentport_org_unavailable" | "org_link_conflict" };

/**
 * Idempotently link an existing AgentPort organization (no backfill job calls this yet).
 * - already linked: returned unchanged, nothing written
 * - target orgs row exists but is owned by someone else: refused, nothing written
 */
export async function ensureAgentPortOrgLink(db: D1Database, tenantId: string, at: string): Promise<LinkResult> {
  const org = await db.prepare("SELECT name,owner_developer_id,org_id FROM agentport_organizations WHERE id=?").bind(tenantId).first<{ name: string; owner_developer_id: string; org_id: string | null }>();
  if (!org) return { ok: false, error_code: "agentport_org_unavailable" };
  if (org.org_id) return { ok: true, orgId: org.org_id, created: false };
  const orgId = linkedOrgId(tenantId);
  const existing = await db.prepare("SELECT owner_id FROM orgs WHERE id=?").bind(orgId).first<{ owner_id: string }>();
  if (existing && existing.owner_id !== org.owner_developer_id) return { ok: false, error_code: "org_link_conflict" };
  const results = await db.batch([
    db.prepare("INSERT OR IGNORE INTO orgs(id,name,owner_id,plan_tier,status,created_at) VALUES(?,?,?,'free','active',?)").bind(orgId, org.name, org.owner_developer_id, at),
    db.prepare("UPDATE agentport_organizations SET org_id=?,updated_at=? WHERE id=? AND org_id IS NULL").bind(orgId, at, tenantId),
  ]);
  const linked = Number((results[1] as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0) > 0;
  if (!linked) {
    const current = await db.prepare("SELECT org_id FROM agentport_organizations WHERE id=?").bind(tenantId).first<{ org_id: string | null }>();
    return current?.org_id ? { ok: true, orgId: current.org_id, created: false } : { ok: false, error_code: "org_link_conflict" };
  }
  return { ok: true, orgId, created: !existing };
}
