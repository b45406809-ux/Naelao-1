import { replayWorkspaceErasureLedgerReceipt, type WorkspaceErasureLedgerReceipt } from "./phase6-erasure.js";
import { sha256Hex, validateWorkspaceScope, type WorkspaceScope } from "./workspace-contract.js";

export interface WorkspaceErasureBackupBindings {
  WORKSPACE_ERASURE_BACKUP_R2?: R2Bucket;
  WORKSPACE_ERASURE_BACKUP_EU_R2?: R2Bucket;
}

interface BackupEnvelope {
  schema_version: 1;
  receipt: WorkspaceErasureLedgerReceipt;
  receipt_sha256: string;
}

interface TombstoneRow extends WorkspaceErasureLedgerReceipt {}

export interface ErasureBackupExportResult {
  exported: number;
  pending: number;
  failed: number;
}

export function workspaceErasureBackupKey(receipt: Pick<WorkspaceErasureLedgerReceipt, "tenant_id" | "space_id" | "project_id" | "jurisdiction">): string {
  return `workspace-erasure-backups/v1/${receipt.jurisdiction}/${encodeURIComponent(receipt.tenant_id)}/${encodeURIComponent(receipt.space_id)}/${encodeURIComponent(receipt.project_id)}.json`;
}

function bucketFor(bindings: WorkspaceErasureBackupBindings, jurisdiction: "global" | "eu"): R2Bucket | undefined {
  return jurisdiction === "eu" ? bindings.WORKSPACE_ERASURE_BACKUP_EU_R2 : bindings.WORKSPACE_ERASURE_BACKUP_R2;
}

async function makeEnvelope(receipt: WorkspaceErasureLedgerReceipt): Promise<{ envelope: BackupEnvelope; encoded: string }> {
  const envelope: BackupEnvelope = {
    schema_version: 1,
    receipt,
    receipt_sha256: await sha256Hex(new TextEncoder().encode(JSON.stringify(receipt))),
  };
  return { envelope, encoded: JSON.stringify(envelope) };
}

async function readEnvelope(bucket: R2Bucket, key: string): Promise<BackupEnvelope | null> {
  const object = await bucket.get(key);
  if (!object) return null;
  try {
    const parsed = await object.json<unknown>();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const value = parsed as Partial<BackupEnvelope>;
    if (value.schema_version !== 1 || !value.receipt || typeof value.receipt !== "object" ||
        typeof value.receipt_sha256 !== "string") return null;
    return value as BackupEnvelope;
  } catch { return null; }
}

/**
 * Persist one immutable tombstone receipt in a separately configured R2 bucket before project
 * aliases are physically removed. The D1 marker is written last, so a lost response simply
 * retries the same conditional object write and verifies the existing bytes.
 */
export async function exportWorkspaceErasureReceipt(
  db: Pick<D1Database, "prepare">,
  bindings: WorkspaceErasureBackupBindings,
  scope: WorkspaceScope,
  now = new Date().toISOString(),
): Promise<boolean> {
  if (!validateWorkspaceScope(scope)) throw new Error("workspace_erasure_backup_scope_invalid");
  const row = await db.prepare(`SELECT tenant_id,space_id,project_id,jurisdiction,tombstone_id,requested_at
    FROM workspace_erasure_tombstones WHERE tenant_id=? AND space_id=? AND project_id=?`)
    .bind(scope.tenantId, scope.spaceId, scope.projectId).first<TombstoneRow>();
  if (!row) throw new Error("workspace_erasure_tombstone_missing");
  const receipt: WorkspaceErasureLedgerReceipt = {
    tenant_id: row.tenant_id,
    space_id: row.space_id,
    project_id: row.project_id,
    jurisdiction: row.jurisdiction,
    tombstone_id: row.tombstone_id,
    requested_at: row.requested_at,
  };
  const expectedTombstone = `wser_${await sha256Hex(new TextEncoder().encode(`${scope.tenantId}\0${scope.spaceId}\0${scope.projectId}`))}`;
  if (row.tenant_id !== scope.tenantId || row.space_id !== scope.spaceId || row.project_id !== scope.projectId ||
      row.jurisdiction !== scope.jurisdiction || row.tombstone_id !== expectedTombstone ||
      !Number.isFinite(Date.parse(row.requested_at)) || new Date(row.requested_at).toISOString() !== row.requested_at) {
    throw new Error("workspace_erasure_backup_tombstone_invalid");
  }
  const { envelope, encoded } = await makeEnvelope(receipt);
  const key = workspaceErasureBackupKey(receipt);
  const bucket = bucketFor(bindings, scope.jurisdiction);
  if (!bucket) {
    const recorded = await db.prepare(`SELECT backup_key,receipt_sha256 FROM workspace_erasure_backup_exports WHERE tombstone_id=?`)
      .bind(receipt.tombstone_id).first<{ backup_key: string; receipt_sha256: string }>();
    return recorded?.backup_key === key && recorded.receipt_sha256 === envelope.receipt_sha256;
  }
  try {
    await bucket.put(key, encoded, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "application/json" },
      customMetadata: { sha256: envelope.receipt_sha256, schema: "workspace-erasure-receipt-v1" },
    });
  } catch { /* a timeout may follow a committed PUT; verify the immutable key below */ }
  const current = await readEnvelope(bucket, key);
  if (!current || JSON.stringify(current) !== encoded) throw new Error("workspace_erasure_backup_object_unverified");

  await db.prepare(`INSERT OR IGNORE INTO workspace_erasure_backup_exports
    (tombstone_id,tenant_id,space_id,project_id,jurisdiction,backup_key,receipt_sha256,exported_at)
    VALUES (?,?,?,?,?,?,?,?)`)
    .bind(receipt.tombstone_id, receipt.tenant_id, receipt.space_id, receipt.project_id, receipt.jurisdiction,
      key, envelope.receipt_sha256, now).run();
  const recorded = await db.prepare(`SELECT backup_key,receipt_sha256 FROM workspace_erasure_backup_exports WHERE tombstone_id=?`)
    .bind(receipt.tombstone_id).first<{ backup_key: string; receipt_sha256: string }>();
  if (!recorded || recorded.backup_key !== key || recorded.receipt_sha256 !== envelope.receipt_sha256) {
    throw new Error("workspace_erasure_backup_receipt_conflict");
  }
  return true;
}

/** Bounded scheduled exporter. It performs only immutable receipt writes, never erasure effects. */
export async function exportPendingWorkspaceErasureReceipts(
  db: Pick<D1Database, "prepare">,
  bindings: WorkspaceErasureBackupBindings,
  limit = 25,
  now = new Date().toISOString(),
): Promise<ErasureBackupExportResult> {
  const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  const rows = await db.prepare(`SELECT t.tenant_id,t.space_id,t.project_id,t.jurisdiction,t.tombstone_id,t.requested_at
    FROM workspace_erasure_tombstones t
    LEFT JOIN workspace_erasure_backup_exports e ON e.tombstone_id=t.tombstone_id
    WHERE e.tombstone_id IS NULL
    ORDER BY t.requested_at,t.tenant_id,t.space_id,t.project_id LIMIT ?`)
    .bind(boundedLimit).all<TombstoneRow>();
  const result: ErasureBackupExportResult = { exported: 0, pending: 0, failed: 0 };
  for (const row of rows.results ?? []) {
    const scope: WorkspaceScope = { tenantId: row.tenant_id, spaceId: row.space_id, projectId: row.project_id, jurisdiction: row.jurisdiction };
    if (!bucketFor(bindings, row.jurisdiction)) { result.pending++; continue; }
    try {
      result.exported += Number(await exportWorkspaceErasureReceipt(db, bindings, scope, now));
    } catch { result.failed++; }
  }
  return result;
}

export interface ErasureBackupReplayResult {
  receiptsReplayed: number;
  tombstonesCreated: number;
  hasMore: boolean;
  nextCursor?: string;
}

/** Restore one tenant/jurisdiction page of backed-up tombstones after a primary R2 restore. */
export async function replayWorkspaceErasureBackupPage(
  db: Pick<D1Database, "prepare">,
  primaryLedger: R2Bucket,
  backupBindings: WorkspaceErasureBackupBindings,
  input: { tenantId: string; jurisdiction: "global" | "eu"; cursor?: string; limit?: number },
): Promise<ErasureBackupReplayResult> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(input.tenantId) ||
      (input.cursor !== undefined && (input.cursor.length > 1024 || !input.cursor)) ||
      (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100))) {
    throw new Error("workspace_erasure_backup_replay_request_invalid");
  }
  const bucket = bucketFor(backupBindings, input.jurisdiction);
  if (!bucket) throw new Error("workspace_erasure_backup_unavailable");
  const prefix = `workspace-erasure-backups/v1/${input.jurisdiction}/${encodeURIComponent(input.tenantId)}/`;
  const page = await bucket.list({ prefix, ...(input.cursor ? { cursor: input.cursor } : {}), limit: input.limit ?? 25 });
  let tombstonesCreated = 0;
  for (const object of page.objects) {
    if (!object.key.startsWith(prefix)) throw new Error("workspace_erasure_backup_scope_mismatch");
    const envelope = await readEnvelope(bucket, object.key);
    if (!envelope || envelope.schema_version !== 1 || envelope.receipt.tenant_id !== input.tenantId ||
        envelope.receipt.jurisdiction !== input.jurisdiction || workspaceErasureBackupKey(envelope.receipt) !== object.key) {
      throw new Error("workspace_erasure_backup_receipt_invalid");
    }
    const expected = await makeEnvelope(envelope.receipt);
    if (expected.envelope.receipt_sha256 !== envelope.receipt_sha256) throw new Error("workspace_erasure_backup_receipt_invalid");
    tombstonesCreated += Number(await replayWorkspaceErasureLedgerReceipt(db, primaryLedger, envelope.receipt));
  }
  if (page.truncated && (!page.cursor || page.cursor === input.cursor)) throw new Error("workspace_erasure_backup_cursor_invalid");
  return {
    receiptsReplayed: page.objects.length,
    tombstonesCreated,
    hasMore: page.truncated,
    ...(page.truncated && page.cursor ? { nextCursor: page.cursor } : {}),
  };
}
