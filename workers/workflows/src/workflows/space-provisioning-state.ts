/** Atomically activates a provisioning Space only while its owning organization is still active. */
export async function activateSpaceForActiveTenant(
  db: D1Database,
  input: { spaceId: string; tenantId: string },
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE spaces
     SET status = 'active', updated_at = datetime('now')
     WHERE id = ? AND tenant_id = ? AND status = 'provisioning'
       AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = spaces.tenant_id AND o.status = 'active')`,
  ).bind(input.spaceId, input.tenantId).run();
  return result.meta.changes === 1;
}
