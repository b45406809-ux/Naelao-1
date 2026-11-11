import { validateWorkspaceScope, type WorkspaceScope } from "./workspace-contract.js";

export interface WorkspaceErasureLedgerReceipt {
  tenant_id: string;
  space_id: string;
  project_id: string;
  jurisdiction: "global" | "eu";
  tombstone_id: string;
  requested_at: string;
}

export interface WorkspaceErasureTombstone {
  tenant_id: string;
  space_id: string;
  project_id: string;
  tombstone_id: string;
  jurisdiction: "global" | "eu";
  status: "pending" | "cleaning" | "complete";
  cleanup_phase: "legacy" | "bridge" | "complete";
  cleanup_cursor: string | null;
  bridge_cleanup_cursor: string | null;
  cleanup_page: number;
}

export interface QueuedProviderDeletions {
  queued: number;
  pending: number;
  unresolved: number;
}

export async function beginProjectWorkspaceErasure(
  db: Pick<D1Database, "prepare">,
  bucket: R2Bucket,
  scope: WorkspaceScope,
  now = new Date().toISOString(),
): Promise<{ tombstone: WorkspaceErasureTombstone; providerDeletions: QueuedProviderDeletions }> {
  const tombstoneId = `wser_${await sha256Hex(`${scope.tenantId}\0${scope.spaceId}\0${scope.projectId}`)}`;
  await writeWorkspaceErasureLedger(bucket, scope, tombstoneId, now);
  await db.prepare(
    `INSERT OR IGNORE INTO workspace_erasure_tombstones
       (tenant_id,space_id,project_id,tombstone_id,jurisdiction,status,requested_at,updated_at)
     VALUES (?,?,?,?,?,'pending',?,?)`,
  ).bind(scope.tenantId, scope.spaceId, scope.projectId, tombstoneId, scope.jurisdiction, now, now).run();
  const tombstone = await db.prepare(
    "SELECT tenant_id,space_id,project_id,tombstone_id,jurisdiction,status,cleanup_phase,cleanup_cursor,bridge_cleanup_cursor,cleanup_page FROM workspace_erasure_tombstones WHERE tenant_id=? AND space_id=? AND project_id=?",
  ).bind(scope.tenantId, scope.spaceId, scope.projectId).first<WorkspaceErasureTombstone>();
  if (!tombstone || tombstone.tombstone_id !== tombstoneId || tombstone.jurisdiction !== scope.jurisdiction) {
    throw new Error("workspace_erasure_tombstone_conflict");
  }

  const providerDeletions = await queueProjectSandboxDeletions(db, scope, now);
  return { tombstone, providerDeletions };
}

export function workspaceErasureLedgerKey(scope: Pick<WorkspaceScope, "tenantId" | "spaceId" | "projectId">): string {
  return `workspace-erasure-ledger/${scope.tenantId}/${scope.spaceId}/${scope.projectId}.json`;
}

async function writeWorkspaceErasureLedger(bucket: R2Bucket, scope: WorkspaceScope, tombstoneId: string, requestedAt: string): Promise<void> {
  const receipt = { tenant_id: scope.tenantId, space_id: scope.spaceId, project_id: scope.projectId,
    jurisdiction: scope.jurisdiction, tombstone_id: tombstoneId, requested_at: requestedAt };
  await writeWorkspaceErasureLedgerReceipt(bucket, receipt);
}

async function writeWorkspaceErasureLedgerReceipt(bucket: R2Bucket, receipt: WorkspaceErasureLedgerReceipt): Promise<void> {
  const scope = { tenantId: receipt.tenant_id, spaceId: receipt.space_id, projectId: receipt.project_id, jurisdiction: receipt.jurisdiction };
  const key = workspaceErasureLedgerKey(scope);
  try {
    const written = await bucket.put(key, JSON.stringify(receipt), { onlyIf: { etagDoesNotMatch: "*" }, httpMetadata: { contentType: "application/json" } });
    if (written !== null) return;
  } catch { /* a conditional-write race is checked against the existing immutable receipt */ }
  const object = await bucket.get(key);
  if (!object) throw new Error("workspace_erasure_ledger_write_failed");
  // requested_at can differ across retries; scope identity and tombstone ID are the stable
  // values. Accept only the same immutable erasure operation.
  const existing = await object.json<Record<string, unknown>>();
  if (existing.tenant_id !== scope.tenantId || existing.space_id !== scope.spaceId || existing.project_id !== scope.projectId ||
      existing.jurisdiction !== scope.jurisdiction || existing.tombstone_id !== receipt.tombstone_id || typeof existing.requested_at !== "string") {
    throw new Error("workspace_erasure_ledger_conflict");
  }
}

/** Replay an independently retained ledger receipt after a backup restore rolled the workspace
 * bucket back before the erasure. The operator must supply the old receipt from that backup. */
export async function replayWorkspaceErasureLedgerReceipt(
  db: Pick<D1Database, "prepare">,
  bucket: R2Bucket,
  receipt: WorkspaceErasureLedgerReceipt,
  now = new Date().toISOString(),
): Promise<boolean> {
  const scope = { tenantId: receipt.tenant_id, spaceId: receipt.space_id, projectId: receipt.project_id, jurisdiction: receipt.jurisdiction };
  const expectedId = `wser_${await sha256Hex(`${scope.tenantId}\0${scope.spaceId}\0${scope.projectId}`)}`;
  if (!validateWorkspaceScope(scope) || receipt.tombstone_id !== expectedId || !Number.isFinite(Date.parse(receipt.requested_at)) ||
      new Date(receipt.requested_at).toISOString() !== receipt.requested_at) throw new Error("workspace_erasure_ledger_invalid");
  await writeWorkspaceErasureLedgerReceipt(bucket, receipt);
  const existed = await db.prepare("SELECT tombstone_id FROM workspace_erasure_tombstones WHERE tenant_id=? AND space_id=? AND project_id=?")
    .bind(scope.tenantId, scope.spaceId, scope.projectId).first<{ tombstone_id: string }>();
  await db.prepare(`INSERT OR IGNORE INTO workspace_erasure_tombstones
    (tenant_id,space_id,project_id,tombstone_id,jurisdiction,status,cleanup_phase,requested_at,updated_at)
    VALUES (?,?,?,?,?,'pending','legacy',?,?)`)
    .bind(scope.tenantId, scope.spaceId, scope.projectId, expectedId, scope.jurisdiction, receipt.requested_at, now).run();
  const current = await db.prepare("SELECT tombstone_id,jurisdiction FROM workspace_erasure_tombstones WHERE tenant_id=? AND space_id=? AND project_id=?")
    .bind(scope.tenantId, scope.spaceId, scope.projectId).first<{ tombstone_id: string; jurisdiction: string }>();
  if (!current || current.tombstone_id !== expectedId || current.jurisdiction !== scope.jurisdiction) throw new Error("workspace_erasure_tombstone_conflict");
  return !existed;
}

/** Rebuild a missing D1 tombstone from the immutable R2 erasure ledger after a D1 PITR restore. */
export async function restoreWorkspaceErasureTombstone(
  db: Pick<D1Database, "prepare">,
  bucket: R2Bucket | undefined,
  scope: Pick<WorkspaceScope, "tenantId" | "spaceId" | "projectId" | "jurisdiction">,
  now = new Date().toISOString(),
): Promise<boolean> {
  if (!bucket) return false;
  const object = await bucket.get(workspaceErasureLedgerKey(scope));
  if (!object) return false;
  const receipt = await object.json<Record<string, unknown>>();
  const expectedId = `wser_${await sha256Hex(`${scope.tenantId}\0${scope.spaceId}\0${scope.projectId}`)}`;
  if (receipt.tenant_id !== scope.tenantId || receipt.space_id !== scope.spaceId || receipt.project_id !== scope.projectId ||
      receipt.jurisdiction !== scope.jurisdiction || receipt.tombstone_id !== expectedId || typeof receipt.requested_at !== "string") {
    throw new Error("workspace_erasure_ledger_invalid");
  }
  await db.prepare(`INSERT OR IGNORE INTO workspace_erasure_tombstones
    (tenant_id,space_id,project_id,tombstone_id,jurisdiction,status,cleanup_phase,requested_at,updated_at)
    VALUES (?,?,?,?,?,'pending','legacy',?,?)`)
    .bind(scope.tenantId, scope.spaceId, scope.projectId, expectedId, scope.jurisdiction, receipt.requested_at, now).run();
  const row = await db.prepare("SELECT tombstone_id,jurisdiction FROM workspace_erasure_tombstones WHERE tenant_id=? AND space_id=? AND project_id=?")
    .bind(scope.tenantId, scope.spaceId, scope.projectId).first<{ tombstone_id: string; jurisdiction: string }>();
  if (!row || row.tombstone_id !== expectedId || row.jurisdiction !== scope.jurisdiction) throw new Error("workspace_erasure_tombstone_conflict");
  return true;
}

export async function queueProjectSandboxDeletions(
  db: Pick<D1Database, "prepare">,
  scope: Pick<WorkspaceScope, "tenantId" | "spaceId" | "projectId">,
  now = new Date().toISOString(),
): Promise<QueuedProviderDeletions> {
  const allocations = await db.prepare(
    `SELECT a.id AS allocation_id,a.connection_id,a.provider,a.external_id,a.generation,
            c.id AS computer_id,c.tenant_id,c.space_id,c.project_id
       FROM sandbox_allocations a
       JOIN sandbox_computers c ON c.id=a.computer_id
      WHERE c.tenant_id=? AND c.space_id=? AND c.project_id=? AND a.status!='destroyed'
      ORDER BY c.id,a.generation`,
  ).bind(scope.tenantId, scope.spaceId, scope.projectId).all<{
    allocation_id: string;
    connection_id: string;
    provider: string;
    external_id: string | null;
    generation: number;
    computer_id: string;
  }>();

  let queued = 0;
  let unresolved = 0;
  for (const allocation of allocations.results ?? []) {
    const operationKey = `delete:${await sha256Hex(`${scope.tenantId}\0${allocation.allocation_id}\0${allocation.generation}`)}`;
    const id = `spdel_${operationKey.slice("delete:".length)}`;
    const unresolvedIdentity = !allocation.external_id;
    const insert = await db.prepare(
      `INSERT OR IGNORE INTO sandbox_provider_deletion_operations
        (id,tenant_id,space_id,project_id,computer_id,allocation_id,connection_id,provider,external_id,generation,
         operation_key,status,reason_code,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?)`,
    ).bind(id, scope.tenantId, scope.spaceId, scope.projectId, allocation.computer_id, allocation.allocation_id,
      allocation.connection_id, allocation.provider, allocation.external_id, allocation.generation, operationKey,
      unresolvedIdentity ? "retained" : "pending", unresolvedIdentity ? "allocation_identity_unknown" : null, now, now).run();
    queued += insert.meta.changes;
    if (unresolvedIdentity) unresolved++;
  }

  await db.prepare(
    `UPDATE sandbox_grants SET revoked_at=COALESCE(revoked_at,?)
      WHERE tenant_id=? AND (computer_id IN
        (SELECT id FROM sandbox_computers WHERE tenant_id=? AND space_id=? AND project_id=?)
        OR filesystem_id IN
        (SELECT id FROM sandbox_filesystems WHERE tenant_id=? AND space_id=? AND project_id=?))`,
  ).bind(now, scope.tenantId, scope.tenantId, scope.spaceId, scope.projectId, scope.tenantId, scope.spaceId, scope.projectId).run();
  await db.prepare(
    `UPDATE sandbox_computers SET state=CASE
       WHEN EXISTS (SELECT 1 FROM sandbox_allocations a WHERE a.computer_id=sandbox_computers.id AND a.status!='destroyed' AND a.external_id IS NULL) THEN 'recovery_required'
       WHEN EXISTS (SELECT 1 FROM sandbox_allocations a WHERE a.computer_id=sandbox_computers.id AND a.status!='destroyed') THEN 'deleting'
       ELSE 'deleted' END,
       deleted_at=CASE WHEN NOT EXISTS (SELECT 1 FROM sandbox_allocations a WHERE a.computer_id=sandbox_computers.id AND a.status!='destroyed') THEN COALESCE(deleted_at,?) ELSE deleted_at END,
       updated_at=?
      WHERE tenant_id=? AND space_id=? AND project_id=? AND deleted_at IS NULL`,
  ).bind(now, now, scope.tenantId, scope.spaceId, scope.projectId).run();
  await db.prepare(
    `UPDATE sandbox_filesystems SET status='retired',updated_at=?
      WHERE tenant_id=? AND space_id=? AND project_id=? AND status!='retired'`,
  ).bind(now, scope.tenantId, scope.spaceId, scope.projectId).run();

  return {
    queued,
    pending: (allocations.results ?? []).filter(row => Boolean(row.external_id)).length,
    unresolved,
  };
}

export async function advanceWorkspaceErasureCursor(
  db: Pick<D1Database, "prepare">,
  scope: WorkspaceScope,
  input: { phase: "legacy" | "bridge" | "complete"; cursor: string | null; bridgeCursor: string | null; page: number },
  complete: boolean,
  now = new Date().toISOString(),
): Promise<void> {
  const result = await db.prepare(
    `UPDATE workspace_erasure_tombstones
        SET cleanup_phase=?,cleanup_cursor=?,bridge_cleanup_cursor=?,cleanup_page=?,status=?,updated_at=?,completed_at=?
      WHERE tenant_id=? AND space_id=? AND project_id=?`,
  ).bind(input.phase, input.cursor, input.bridgeCursor, input.page, complete ? "complete" : "cleaning", now, complete ? now : null,
    scope.tenantId, scope.spaceId, scope.projectId).run();
  if (!result.meta.changes) throw new Error("workspace_erasure_tombstone_missing");
}

export async function restartCompletedWorkspaceErasure(
  db: Pick<D1Database, "prepare">,
  scope: Pick<WorkspaceScope, "tenantId" | "spaceId" | "projectId">,
  now = new Date().toISOString(),
): Promise<void> {
  await db.prepare(`UPDATE workspace_erasure_tombstones
    SET status='pending',cleanup_phase='legacy',cleanup_cursor=NULL,bridge_cleanup_cursor=NULL,
        cleanup_page=0,completed_at=NULL,updated_at=?
    WHERE tenant_id=? AND space_id=? AND project_id=? AND status='complete'`)
    .bind(now, scope.tenantId, scope.spaceId, scope.projectId).run();
}

/** Remove project-owned sandbox metadata after its R2 bridge page has been deleted. Provider
 * allocations and connection credentials survive only while an outbox entry is unresolved. */
export async function finalizeProjectSandboxDataErasure(
  db: D1Database,
  scope: WorkspaceScope,
  now = new Date().toISOString(),
): Promise<void> {
  await db.batch([
    db.prepare(`UPDATE sandbox_usage_events SET computer_id=NULL,execution_id=NULL,connection_id=NULL
      WHERE tenant_id=? AND computer_id IN (SELECT id FROM sandbox_computers WHERE tenant_id=? AND space_id=? AND project_id=?)`)
      .bind(scope.tenantId, scope.tenantId, scope.spaceId, scope.projectId),
    db.prepare(`DELETE FROM sandbox_workspace_publication_blobs WHERE publication_id IN
      (SELECT p.id FROM sandbox_publications p JOIN sandbox_filesystems f ON f.id=p.filesystem_id WHERE f.tenant_id=? AND f.space_id=? AND f.project_id=?)`)
      .bind(scope.tenantId, scope.spaceId, scope.projectId),
    db.prepare(`DELETE FROM sandbox_publications WHERE filesystem_id IN
      (SELECT id FROM sandbox_filesystems WHERE tenant_id=? AND space_id=? AND project_id=?)`).bind(scope.tenantId, scope.spaceId, scope.projectId),
    db.prepare(`DELETE FROM sandbox_workspace_snapshot_entries WHERE snapshot_id IN
      (SELECT id FROM sandbox_workspace_snapshots WHERE tenant_id=? AND filesystem_id IN
        (SELECT id FROM sandbox_filesystems WHERE tenant_id=? AND space_id=? AND project_id=?))`)
      .bind(scope.tenantId, scope.tenantId, scope.spaceId, scope.projectId),
    db.prepare(`DELETE FROM sandbox_workspace_blobs WHERE tenant_id=? AND filesystem_id IN
      (SELECT id FROM sandbox_filesystems WHERE tenant_id=? AND space_id=? AND project_id=?)`)
      .bind(scope.tenantId, scope.tenantId, scope.spaceId, scope.projectId),
    db.prepare(`DELETE FROM sandbox_workspace_snapshots WHERE tenant_id=? AND filesystem_id IN
      (SELECT id FROM sandbox_filesystems WHERE tenant_id=? AND space_id=? AND project_id=?)`)
      .bind(scope.tenantId, scope.tenantId, scope.spaceId, scope.projectId),
    db.prepare(`DELETE FROM sandbox_grants WHERE tenant_id=? AND (computer_id IN
      (SELECT id FROM sandbox_computers WHERE tenant_id=? AND space_id=? AND project_id=?) OR filesystem_id IN
      (SELECT id FROM sandbox_filesystems WHERE tenant_id=? AND space_id=? AND project_id=?))`)
      .bind(scope.tenantId, scope.tenantId, scope.spaceId, scope.projectId, scope.tenantId, scope.spaceId, scope.projectId),
    db.prepare(`DELETE FROM sandbox_executions WHERE tenant_id=? AND computer_id IN
      (SELECT id FROM sandbox_computers WHERE tenant_id=? AND space_id=? AND project_id=?)`)
      .bind(scope.tenantId, scope.tenantId, scope.spaceId, scope.projectId),
    db.prepare(`DELETE FROM sandbox_operations WHERE tenant_id=? AND computer_id IN
      (SELECT id FROM sandbox_computers WHERE tenant_id=? AND space_id=? AND project_id=?)`)
      .bind(scope.tenantId, scope.tenantId, scope.spaceId, scope.projectId),
    db.prepare(`DELETE FROM sandbox_allocations WHERE computer_id IN
      (SELECT id FROM sandbox_computers WHERE tenant_id=? AND space_id=? AND project_id=?)
      AND (status='destroyed' OR id IN (SELECT allocation_id FROM sandbox_provider_deletion_operations WHERE status IN ('confirmed_deleted','retained')))`)
      .bind(scope.tenantId, scope.spaceId, scope.projectId),
    db.prepare(`DELETE FROM sandbox_computers WHERE tenant_id=? AND space_id=? AND project_id=? AND id NOT IN
      (SELECT computer_id FROM sandbox_provider_deletion_operations WHERE status NOT IN ('confirmed_deleted','retained'))`)
      .bind(scope.tenantId, scope.spaceId, scope.projectId),
    db.prepare(`DELETE FROM sandbox_filesystems WHERE tenant_id=? AND space_id=? AND project_id=? AND NOT EXISTS
      (SELECT 1 FROM sandbox_computers c WHERE c.filesystem_id=sandbox_filesystems.id)`)
      .bind(scope.tenantId, scope.spaceId, scope.projectId),
    db.prepare(`UPDATE sandbox_filesystems SET status='retired',updated_at=? WHERE tenant_id=? AND space_id=? AND project_id=?`)
      .bind(now, scope.tenantId, scope.spaceId, scope.projectId),
  ]);
  await db.prepare("UPDATE workspace_erasure_tombstones SET updated_at=? WHERE tenant_id=? AND space_id=? AND project_id=?")
    .bind(now, scope.tenantId, scope.spaceId, scope.projectId).run();
}

export async function workspaceErasureTombstone(
  db: Pick<D1Database, "prepare">,
  scope: Pick<WorkspaceScope, "tenantId" | "spaceId" | "projectId">,
): Promise<WorkspaceErasureTombstone | null> {
  return db.prepare(
    "SELECT tenant_id,space_id,project_id,tombstone_id,jurisdiction,status,cleanup_phase,cleanup_cursor,bridge_cleanup_cursor,cleanup_page FROM workspace_erasure_tombstones WHERE tenant_id=? AND space_id=? AND project_id=?",
  ).bind(scope.tenantId, scope.spaceId, scope.projectId).first<WorkspaceErasureTombstone>();
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
