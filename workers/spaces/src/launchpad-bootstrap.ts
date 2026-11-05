import type { CreateSpaceEnv } from "./create-space.js";

export interface LaunchpadBootstrapEnv extends CreateSpaceEnv {
  NAELAO_DASHBOARD_TENANT_ID?: string;
}

type ProductRow = { id: string; tenant_id: string; status: string; spacetype_id: string };

/** Initialize the single Launchpad product for the configured team tenant. Existing roots are
 * never renamed or adopted implicitly: an operator must resolve a conflicting deployment first. */
export async function ensureLaunchpad(env: LaunchpadBootstrapEnv): Promise<void> {
  const tenantId = env.NAELAO_DASHBOARD_TENANT_ID?.trim();
  if (!tenantId) throw new Error("launchpad_team_tenant_not_configured");
  const registered = await env.PLATFORM_DB.prepare(
    "SELECT id, tenant_id, status, spacetype_id FROM products WHERE product_slug = ?"
  ).bind("launchpad").first<ProductRow>();
  if (registered && (registered.tenant_id !== tenantId || registered.spacetype_id !== "launchpad")) throw new Error("launchpad_identity_conflict");
  if (registered) {
    if (!["active", "provisioning"].includes(registered.status)) throw new Error("launchpad_not_active");
    return;
  }
  const unresolvedLegacy = await env.PLATFORM_DB.prepare(
    "SELECT space_id FROM product_link_migration_issues WHERE recorded_product_slug = ? LIMIT 1"
  ).bind("launchpad").first<{ space_id: string }>();
  if (unresolvedLegacy) throw new Error("launchpad_legacy_product_requires_migration");
  const org = await env.PLATFORM_DB.prepare("SELECT id FROM orgs WHERE id = ? AND status = 'active'").bind(tenantId).first<{ id: string }>();
  if (!org) throw new Error("launchpad_team_tenant_unavailable");
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await env.PLATFORM_DB.prepare(
    `INSERT INTO products (id, tenant_id, spacetype_id, name, product_slug, status, config_json, created_at, updated_at)
     VALUES (?, ?, 'launchpad', 'Launchpad', 'launchpad', 'active', '{}', ?, ?)
     ON CONFLICT(product_slug) DO NOTHING`
  ).bind(id, tenantId, now, now).run();
  const winner = await env.PLATFORM_DB.prepare("SELECT id, tenant_id, status, spacetype_id FROM products WHERE product_slug = ?")
    .bind("launchpad").first<ProductRow>();
  if (!winner || winner.tenant_id !== tenantId || winner.spacetype_id !== "launchpad") throw new Error("launchpad_identity_conflict");
  if (winner.status !== "active") throw new Error("launchpad_not_active");
}
