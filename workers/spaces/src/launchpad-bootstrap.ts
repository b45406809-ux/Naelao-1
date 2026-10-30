import { createSpaceRecord, SpaceCreationError, type CreateSpaceEnv } from "./create-space.js";

export interface LaunchpadBootstrapEnv extends CreateSpaceEnv {
  NAELAO_DASHBOARD_TENANT_ID?: string;
}

type RootRow = { id: string; tenant_id: string; status: string; parent_space_id: string | null; spacetype_id: string };

/** Initialize the single Launchpad product for the configured team tenant. Existing roots are
 * never renamed or adopted implicitly: an operator must resolve a conflicting deployment first. */
export async function ensureLaunchpad(env: LaunchpadBootstrapEnv): Promise<void> {
  const tenantId = env.NAELAO_DASHBOARD_TENANT_ID?.trim();
  if (!tenantId) throw new Error("launchpad_team_tenant_not_configured");
  const existing = await env.PLATFORM_DB.prepare(
    "SELECT id, tenant_id, status, parent_space_id, spacetype_id FROM spaces WHERE product_slug = ?"
  ).bind("launchpad").first<RootRow>();
  if (existing) {
    if (existing.tenant_id !== tenantId || existing.parent_space_id || existing.spacetype_id !== "launchpad") throw new Error("launchpad_identity_conflict");
    if (!["active", "provisioning"].includes(existing.status)) throw new Error("launchpad_not_active");
    return;
  }
  const org = await env.PLATFORM_DB.prepare("SELECT id FROM orgs WHERE id = ? AND status = 'active'").bind(tenantId).first<{ id: string }>();
  if (!org) throw new Error("launchpad_team_tenant_unavailable");
  const previous = await env.PLATFORM_DB.prepare("SELECT id FROM spaces WHERE tenant_id = ? AND parent_space_id IS NULL AND status != 'deleted' LIMIT 1").bind(tenantId).first<{ id: string }>();
  if (previous) throw new Error("launchpad_existing_root_requires_migration");
  if (env.ENVIRONMENT !== "development" && !env.PROVISION_QUEUE) throw new Error("launchpad_provisioning_queue_unavailable");
  try {
    await createSpaceRecord(env, { tenantId, name: "Launchpad", spacetypeId: "launchpad", productSlug: "launchpad" });
  } catch (error) {
    // Concurrent starts can race on the unique slug. Validate the winner instead of duplicating it.
    if (!(error instanceof SpaceCreationError) || ![409, 429].includes(error.status)) throw error;
    const winner = await env.PLATFORM_DB.prepare("SELECT id, tenant_id, status, parent_space_id, spacetype_id FROM spaces WHERE product_slug = ?").bind("launchpad").first<RootRow>();
    if (!winner || winner.tenant_id !== tenantId || winner.parent_space_id || winner.spacetype_id !== "launchpad" || !["active", "provisioning"].includes(winner.status)) throw error;
  }
}
