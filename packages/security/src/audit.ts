export interface AuditEntry {
  eventType: string;
  actorId: string;
  actorRole?: string;
  resourceType: string;
  resourceId: string;
  action: string;
  metadata?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
}

const MAX_AUDIT_METADATA_BYTES = 64 * 1024;
const MAX_AUDIT_PAGE_SIZE = 500;
const MAX_AUDIT_OFFSET = 1_000_000;

export async function writeAudit(
  db: D1Database,
  entry: AuditEntry
): Promise<void> {
  const metadataJson = JSON.stringify(entry.metadata ?? {});
  if (typeof metadataJson !== "string") {
    throw new TypeError("audit_metadata_not_serializable");
  }
  if (
    new TextEncoder().encode(metadataJson).byteLength > MAX_AUDIT_METADATA_BYTES
  ) {
    throw new RangeError("audit_metadata_too_large");
  }
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO audit_log
         (id, event_type, actor_id, actor_role, resource_type, resource_id, action, metadata_json, ip, user_agent, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, datetime('now'))`
    )
    .bind(
      id,
      entry.eventType,
      entry.actorId,
      entry.actorRole ?? null,
      entry.resourceType,
      entry.resourceId,
      entry.action,
      metadataJson,
      entry.ip ?? null,
      entry.userAgent ?? null
    )
    .run();
}

export async function readAuditLog(
  db: D1Database,
  resourceType: string,
  resourceId: string,
  limit = 50,
  offset = 0
): Promise<AuditEntry[]> {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_AUDIT_PAGE_SIZE
  ) {
    throw new RangeError("audit_page_size_invalid");
  }
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > MAX_AUDIT_OFFSET
  ) {
    throw new RangeError("audit_offset_invalid");
  }
  const rows = await db
    .prepare(
      `SELECT event_type, actor_id, actor_role, resource_type, resource_id,
              action, metadata_json, ip, user_agent
       FROM audit_log
       WHERE resource_type = ?1 AND resource_id = ?2
       ORDER BY created_at DESC
       LIMIT ?3 OFFSET ?4`
    )
    .bind(resourceType, resourceId, limit, offset)
    .all<{
      event_type: string;
      actor_id: string;
      actor_role: string | null;
      resource_type: string;
      resource_id: string;
      action: string;
      metadata_json: string;
      ip: string | null;
      user_agent: string | null;
    }>();

  return (rows.results ?? []).map((r) => ({
    eventType: r.event_type,
    actorId: r.actor_id,
    ...(r.actor_role !== null ? { actorRole: r.actor_role } : {}),
    resourceType: r.resource_type,
    resourceId: r.resource_id,
    action: r.action,
    metadata: JSON.parse(r.metadata_json) as Record<string, unknown>,
    ...(r.ip !== null ? { ip: r.ip } : {}),
    ...(r.user_agent !== null ? { userAgent: r.user_agent } : {}),
  }));
}
