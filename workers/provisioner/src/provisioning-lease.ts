export const PROVISION_LEASE_TTL_SECONDS = 30 * 60;

export class ProvisionLeaseBusyError extends Error {
  constructor() {
    super("space_provision_lease_busy");
    this.name = "ProvisionLeaseBusyError";
  }
}

/** A single conditional SQLite upsert elects one queue attempt per Space. An abandoned lease
 * expires so Cloudflare Queue's delayed retry can recover after a hard Worker termination. */
export async function claimProvisionLease(
  db: D1Database,
  spaceId: string,
  tenantId: string,
  leaseToken: string,
  nowMs = Date.now(),
): Promise<boolean> {
  const now = Math.floor(nowMs / 1000);
  const result = await db.prepare(
    `INSERT INTO space_provisioning_leases (space_id, tenant_id, lease_token, lease_expires_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(space_id) DO UPDATE SET
       tenant_id = excluded.tenant_id,
       lease_token = excluded.lease_token,
       lease_expires_at = excluded.lease_expires_at,
       updated_at = excluded.updated_at
     WHERE space_provisioning_leases.tenant_id = excluded.tenant_id
       AND space_provisioning_leases.lease_expires_at <= ?
     RETURNING lease_token`,
  ).bind(spaceId, tenantId, leaseToken, now + PROVISION_LEASE_TTL_SECONDS, now, now)
    .first<{ lease_token: string }>();
  return result?.lease_token === leaseToken;
}

export async function releaseProvisionLease(
  db: D1Database,
  spaceId: string,
  tenantId: string,
  leaseToken: string,
): Promise<void> {
  await db.prepare(
    "DELETE FROM space_provisioning_leases WHERE space_id = ? AND tenant_id = ? AND lease_token = ?"
  ).bind(spaceId, tenantId, leaseToken).run();
}
