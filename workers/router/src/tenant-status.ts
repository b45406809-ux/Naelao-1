const TENANT_STATUS_TTL_MS = 2_000;
const TENANT_STATUS_CACHE_MAX = 4_000;
const tenantStatusCache = new Map<
  string,
  { active: boolean; expiresAt: number }
>();

/** Owner lifecycle lookups remain reachable while an erasure hold suspends the tenant. */
export function isErasureLifecycleAccess(method: string, path: string): boolean {
  return (method === "GET" || method === "DELETE") &&
    /^\/builder\/erasure\/[A-Za-z0-9_-]{1,128}$/.test(path);
}

export async function isTenantActive(
  db: D1Database,
  tenantId: string
): Promise<boolean> {
  const now = Date.now();
  const cached = tenantStatusCache.get(tenantId);
  if (cached && cached.expiresAt > now) return cached.active;
  if (cached) tenantStatusCache.delete(tenantId);

  const row = await db
    .prepare("SELECT status FROM orgs WHERE id = ?")
    .bind(tenantId)
    .first<{ status: string }>();
  const active = row?.status === "active";
  if (tenantStatusCache.size >= TENANT_STATUS_CACHE_MAX) {
    const oldest = tenantStatusCache.keys().next().value;
    if (oldest !== undefined) tenantStatusCache.delete(oldest);
  }
  tenantStatusCache.set(tenantId, {
    active,
    expiresAt: now + TENANT_STATUS_TTL_MS,
  });
  return active;
}

export function clearTenantStatusCacheForTests(): void {
  tenantStatusCache.clear();
}
