const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export interface RuntimeSnapshotRetentionRecord {
  tenantId: string;
  spaceId: string;
  projectId: string;
  runtimeObjectSha256: string;
  snapshotHandleSha256: string;
  imageSha256: string;
  allocationGeneration: number;
  sizeBytes: number;
  createdAt: number;
  expiresAt: number;
}

export interface RuntimeSnapshotRetentionSummary {
  state: "retained" | "reference_dropped" | "erasure_notified" | "ttl_elapsed_unverified";
  createdAt: string;
  expiresAt: string;
  erasureNotifiedAt: string | null;
  providerPurgeSupported: false;
}

function valid(record: RuntimeSnapshotRetentionRecord): boolean {
  return ID.test(record.tenantId) && ID.test(record.spaceId) && ID.test(record.projectId)
    && SHA256.test(record.runtimeObjectSha256) && SHA256.test(record.snapshotHandleSha256)
    && SHA256.test(record.imageSha256)
    && Number.isSafeInteger(record.allocationGeneration) && record.allocationGeneration >= 0
    && Number.isSafeInteger(record.sizeBytes) && record.sizeBytes >= 0
    && Number.isFinite(record.createdAt) && Number.isFinite(record.expiresAt) && record.expiresAt > record.createdAt;
}

/** Store only hashes of provider and Durable Object identifiers. The raw snapshot handle stays
 * in the owning Durable Object and can never be recovered from this erasure-retention ledger. */
export async function recordRuntimeSnapshotRetention(db: D1Database, record: RuntimeSnapshotRetentionRecord, now = new Date()): Promise<void> {
  if (!valid(record)) throw new Error("runtime_snapshot_retention_record_invalid");
  const id = `wrs_${record.runtimeObjectSha256}_${record.snapshotHandleSha256}`;
  const at = now.toISOString();
  const inserted = await db.prepare(`INSERT OR IGNORE INTO workspace_runtime_snapshot_retention(
    id,tenant_id,space_id,project_id,runtime_object_sha256,snapshot_handle_sha256,image_sha256,allocation_generation,
    size_bytes,created_at,expires_at,state,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,? ,?,'retained',?)`)
    .bind(id,record.tenantId,record.spaceId,record.projectId,record.runtimeObjectSha256,record.snapshotHandleSha256,
      record.imageSha256,record.allocationGeneration,record.sizeBytes,new Date(record.createdAt).toISOString(),
      new Date(record.expiresAt).toISOString(),at).run();
  if (inserted.meta.changes === 1) return;
  const prior = await db.prepare(`SELECT image_sha256,allocation_generation,size_bytes,created_at,expires_at
    FROM workspace_runtime_snapshot_retention WHERE tenant_id=? AND space_id=? AND project_id=?
      AND runtime_object_sha256=? AND snapshot_handle_sha256=?`)
    .bind(record.tenantId,record.spaceId,record.projectId,record.runtimeObjectSha256,record.snapshotHandleSha256)
    .first<{image_sha256:string;allocation_generation:number;size_bytes:number;created_at:string;expires_at:string}>();
  if (!prior || prior.image_sha256 !== record.imageSha256 || prior.allocation_generation !== record.allocationGeneration
    || prior.size_bytes !== record.sizeBytes || prior.created_at !== new Date(record.createdAt).toISOString()
    || prior.expires_at !== new Date(record.expiresAt).toISOString()) {
    throw new Error("runtime_snapshot_retention_identity_conflict");
  }
}

/** Dropping a local pointer or notifying erasure does not delete the provider snapshot. */
export async function updateRuntimeSnapshotRetention(
  db: D1Database,
  input: Pick<RuntimeSnapshotRetentionRecord,"tenantId"|"spaceId"|"projectId"|"runtimeObjectSha256">,
  state: "reference_dropped" | "erasure_notified",
  now = new Date(),
): Promise<number> {
  if (!ID.test(input.tenantId) || !ID.test(input.spaceId) || !ID.test(input.projectId) || !SHA256.test(input.runtimeObjectSha256)) {
    throw new Error("runtime_snapshot_retention_scope_invalid");
  }
  const at = now.toISOString();
  const result = await db.prepare(`UPDATE workspace_runtime_snapshot_retention SET
    state=CASE WHEN expires_at<=? THEN 'ttl_elapsed_unverified' ELSE ? END,
    erasure_notified_at=CASE WHEN ?='erasure_notified' THEN COALESCE(erasure_notified_at,?) ELSE erasure_notified_at END,
    updated_at=? WHERE tenant_id=? AND space_id=? AND project_id=? AND runtime_object_sha256=?
      AND state<>'ttl_elapsed_unverified'`)
    .bind(at,state,state,at,at,input.tenantId,input.spaceId,input.projectId,input.runtimeObjectSha256).run();
  return result.meta.changes ?? 0;
}

/** A passed provider TTL is deliberately not treated as proof that the physical snapshot is gone. */
export async function sweepRuntimeSnapshotRetention(db: D1Database, now = new Date()): Promise<number> {
  const at = now.toISOString();
  const result = await db.prepare(`UPDATE workspace_runtime_snapshot_retention
    SET state='ttl_elapsed_unverified',updated_at=? WHERE expires_at<=? AND state<>'ttl_elapsed_unverified'`)
    .bind(at,at).run();
  return result.meta.changes ?? 0;
}

export async function readLatestRuntimeSnapshotRetention(
  db: D1Database,
  scope: Pick<RuntimeSnapshotRetentionRecord,"tenantId"|"spaceId"|"projectId">,
): Promise<RuntimeSnapshotRetentionSummary | null> {
  if (!ID.test(scope.tenantId) || !ID.test(scope.spaceId) || !ID.test(scope.projectId)) {
    throw new Error("runtime_snapshot_retention_scope_invalid");
  }
  const row = await db.prepare(`SELECT state,created_at,expires_at,erasure_notified_at,provider_purge_supported
    FROM workspace_runtime_snapshot_retention WHERE tenant_id=? AND space_id=? AND project_id=?
    ORDER BY created_at DESC,id DESC LIMIT 1`)
    .bind(scope.tenantId,scope.spaceId,scope.projectId)
    .first<{state:RuntimeSnapshotRetentionSummary["state"];created_at:string;expires_at:string;erasure_notified_at:string|null;provider_purge_supported:number}>();
  if (!row) return null;
  if (!new Set(["retained","reference_dropped","erasure_notified","ttl_elapsed_unverified"]).has(row.state)
    || !Number.isFinite(Date.parse(row.created_at)) || !Number.isFinite(Date.parse(row.expires_at))
    || row.provider_purge_supported !== 0) throw new Error("runtime_snapshot_retention_record_invalid");
  return { state: row.state, createdAt: row.created_at, expiresAt: row.expires_at,
    erasureNotifiedAt: row.erasure_notified_at, providerPurgeSupported: false };
}
