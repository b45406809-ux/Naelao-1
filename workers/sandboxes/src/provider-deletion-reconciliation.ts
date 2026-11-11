import { openConnection } from "./connection-crypto.js";
import { Agent37Provider } from "./providers/agent37.js";
import { OpenSandboxProvider } from "./providers/opensandbox.js";
import type { ProviderAllocation } from "@naelao/sandboxes-core";

export type ProviderDeletionStatus = "pending" | "dispatching" | "deletion_requested" | "indeterminate" | "confirmed_deleted" | "retained";
export type ProviderObservedState = "running" | "sleeping" | "deleted" | "error";

export interface ProviderDeletionOperation {
  id: string;
  tenant_id: string;
  space_id: string | null;
  project_id: string | null;
  computer_id: string;
  allocation_id: string;
  connection_id: string | null;
  provider: string;
  external_id: string | null;
  generation: number;
  status: ProviderDeletionStatus;
  reason_code?: string | null;
  delete_dispatched_at?: string | null;
  owner_id: string | null;
  credential_ciphertext: string | null;
  credential_iv: string | null;
  connection_provider: string | null;
  base_url: string | null;
  connection_region: string | null;
  template_id: string | null;
  template_version: string | null;
  filesystem_id?: string | null;
}

export interface ProviderDeletionAdapter {
  inspect(): Promise<ProviderObservedState>;
  destroy(): Promise<void>;
}

export interface ProviderDeletionStore {
  claimDelete(id: string, now: string): Promise<boolean>;
  save(id: string, status: ProviderDeletionStatus, reasonCode: string | null, observedState: ProviderObservedState, now: string): Promise<void>;
  confirmDeleted(operation: ProviderDeletionOperation, now: string): Promise<void>;
}

export async function queueSandboxComputerDeletion(
  db: D1Database,
  tenantId: string,
  computerId: string,
  now = new Date().toISOString(),
): Promise<{ queued: number; pending: number; unresolved: number }> {
  const computer = await db.prepare(
    "SELECT id,space_id,project_id FROM sandbox_computers WHERE id=? AND tenant_id=? AND deleted_at IS NULL",
  ).bind(computerId, tenantId).first<{ id: string; space_id: string | null; project_id: string | null }>();
  if (!computer) throw new Error("computer_not_found");
  const { results } = await db.prepare(
    "SELECT id AS allocation_id,connection_id,provider,external_id,generation FROM sandbox_allocations WHERE computer_id=? AND status!='destroyed' ORDER BY generation",
  ).bind(computerId).all<{ allocation_id: string; connection_id: string; provider: string; external_id: string | null; generation: number }>();
  let queued = 0;
  let pending = 0;
  let unresolved = 0;
  for (const allocation of results ?? []) {
    const operationKey = `delete:${await sha256Hex(`${tenantId}\0${allocation.allocation_id}\0${allocation.generation}`)}`;
    const id = `spdel_${operationKey.slice("delete:".length)}`;
    const missing = !allocation.external_id;
    const inserted = await db.prepare(
      `INSERT OR IGNORE INTO sandbox_provider_deletion_operations
        (id,tenant_id,space_id,project_id,computer_id,allocation_id,connection_id,provider,external_id,generation,operation_key,status,reason_code,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(id, tenantId, computer.space_id, computer.project_id, computerId, allocation.allocation_id,
      allocation.connection_id, allocation.provider, allocation.external_id, allocation.generation,
      operationKey, missing ? "retained" : "pending", missing ? "allocation_identity_unknown" : null, now, now).run();
    queued += inserted.meta.changes;
    if (missing) unresolved++;
    else pending++;
  }
  await db.prepare("UPDATE sandbox_grants SET revoked_at=COALESCE(revoked_at,?) WHERE tenant_id=? AND computer_id=?").bind(now, tenantId, computerId).run();
  await db.prepare(`UPDATE sandbox_computers SET state=CASE
      WHEN EXISTS (SELECT 1 FROM sandbox_allocations a WHERE a.computer_id=sandbox_computers.id AND a.status!='destroyed' AND a.external_id IS NULL) THEN 'recovery_required'
      WHEN EXISTS (SELECT 1 FROM sandbox_allocations a WHERE a.computer_id=sandbox_computers.id AND a.status!='destroyed') THEN 'deleting'
      ELSE 'deleted' END,
      deleted_at=CASE WHEN NOT EXISTS (SELECT 1 FROM sandbox_allocations a WHERE a.computer_id=sandbox_computers.id AND a.status!='destroyed') THEN COALESCE(deleted_at,?) ELSE deleted_at END,
      updated_at=? WHERE id=? AND tenant_id=?`).bind(now, now, computerId, tenantId).run();
  return { queued, pending, unresolved };
}

/** Record a human-verified provider absence without retaining a ticket URL or operator identity.
 * Replaying the same receipt is safe; replacing its evidence is a conflict. */
export async function recordManualProviderDeletionEvidence(
  db: D1Database,
  input: { tenantId: string; operationId: string; operatorId: string; evidenceRef: string; observedAt: string },
  now = new Date().toISOString(),
): Promise<{ status: "confirmed_deleted"; replay: boolean }> {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(input.operatorId) || input.evidenceRef.length < 8 || input.evidenceRef.length > 512 ||
      /[\u0000-\u001f\u007f]/.test(input.evidenceRef) || !Number.isFinite(Date.parse(input.observedAt)) ||
      new Date(input.observedAt).toISOString() !== input.observedAt || Date.parse(input.observedAt) > Date.now() + 5 * 60_000) {
    throw new Error("sandbox_provider_deletion_evidence_invalid");
  }
  const evidenceRefHash = await sha256Hex(input.evidenceRef);
  const operatorIdHash = await sha256Hex(input.operatorId);
  const readOperation = () => db.prepare(
    `SELECT o.*,computer.filesystem_id FROM sandbox_provider_deletion_operations o
       LEFT JOIN sandbox_computers computer ON computer.id=o.computer_id
      WHERE o.id=? AND o.tenant_id=?`,
  ).bind(input.operationId, input.tenantId).first<ProviderDeletionOperation>();
  let operation = await readOperation();
  if (!operation || !operation.external_id || ["retained"].includes(operation.status)) throw new Error("sandbox_provider_deletion_operation_unavailable");
  const prior = await db.prepare(`SELECT evidence_ref_hash,operator_id_hash,observed_at
    FROM sandbox_provider_deletion_manual_receipts WHERE operation_id=? AND tenant_id=?`)
    .bind(input.operationId, input.tenantId).first<{ evidence_ref_hash: string; operator_id_hash: string; observed_at: string }>();
  let replay = false;
  if (prior) {
    if (prior.evidence_ref_hash !== evidenceRefHash || prior.operator_id_hash !== operatorIdHash || prior.observed_at !== input.observedAt) {
      throw new Error("sandbox_provider_deletion_evidence_conflict");
    }
    replay = true;
  } else {
    if (!["pending", "dispatching", "deletion_requested", "indeterminate", "confirmed_deleted"].includes(operation.status)) {
      throw new Error("sandbox_provider_deletion_operation_unavailable");
    }
    const inserted = await db.prepare(`INSERT OR IGNORE INTO sandbox_provider_deletion_manual_receipts
      (operation_id,tenant_id,evidence_ref_hash,operator_id_hash,observed_at,recorded_at)
      SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM sandbox_provider_deletion_operations
        WHERE id=? AND tenant_id=? AND external_id IS NOT NULL AND status IN ('pending','dispatching','deletion_requested','indeterminate','confirmed_deleted'))`)
      .bind(input.operationId, input.tenantId, evidenceRefHash, operatorIdHash, input.observedAt, now, input.operationId, input.tenantId).run();
    const stored = await db.prepare(`SELECT evidence_ref_hash,operator_id_hash,observed_at
      FROM sandbox_provider_deletion_manual_receipts WHERE operation_id=? AND tenant_id=?`)
      .bind(input.operationId, input.tenantId).first<{ evidence_ref_hash: string; operator_id_hash: string; observed_at: string }>();
    if (!stored) throw new Error("sandbox_provider_deletion_operation_unavailable");
    if (stored.evidence_ref_hash !== evidenceRefHash || stored.operator_id_hash !== operatorIdHash || stored.observed_at !== input.observedAt) {
      throw new Error("sandbox_provider_deletion_evidence_conflict");
    }
    replay = inserted.meta.changes !== 1;
  }
  operation = await readOperation();
  if (!operation) throw new Error("sandbox_provider_deletion_operation_unavailable");
  await d1Store(db).confirmDeleted(operation, input.observedAt);
  return { status: "confirmed_deleted", replay };
}

/** A retry-safe state machine. Once delete dispatch may have occurred, recovery is read-only. */
export async function reconcileProviderDeletionOperation(
  operation: ProviderDeletionOperation,
  adapter: ProviderDeletionAdapter,
  store: ProviderDeletionStore,
  now = new Date().toISOString(),
): Promise<ProviderDeletionStatus> {
  if (operation.status === "confirmed_deleted" || operation.status === "retained") return operation.status;
  let observed: ProviderObservedState;
  try {
    observed = await adapter.inspect();
  } catch {
    const status = operation.status === "pending" ? "indeterminate" : operation.status === "dispatching" ? "indeterminate" : operation.status;
    await store.save(operation.id, status, "provider_inspection_unavailable", "error", now);
    return status;
  }
  if (observed === "deleted") {
    await store.confirmDeleted(operation, now);
    return "confirmed_deleted";
  }
  const safePredispatchRetry = operation.status === "indeterminate" && !operation.delete_dispatched_at &&
    ["provider_connection_unavailable", "provider_inspection_unavailable", "provider_state_unconfirmed"].includes(operation.reason_code ?? "");
  if (operation.status !== "pending" && !safePredispatchRetry) {
    // `dispatching` may be a worker crash after the provider received DELETE. An uncertain
    // outcome never causes a second DELETE; only the read-only inspection above is repeated.
    const status = operation.status === "dispatching" ? "indeterminate" : operation.status;
    await store.save(operation.id, status, status === "indeterminate" ? "provider_delete_outcome_unknown" : null, observed, now);
    return status;
  }
  if (observed !== "running" && observed !== "sleeping") {
    await store.save(operation.id, "indeterminate", "provider_state_unconfirmed", observed, now);
    return "indeterminate";
  }
  if (!await store.claimDelete(operation.id, now)) return "dispatching";
  try {
    await adapter.destroy();
    // HTTP success means the provider accepted the request, not that billing has stopped.
    // A later inspect confirms deletion and only then retires the allocation row.
    await store.save(operation.id, "deletion_requested", null, observed, now);
    return "deletion_requested";
  } catch {
    await store.save(operation.id, "indeterminate", "provider_delete_outcome_unknown", observed, now);
    return "indeterminate";
  }
}

interface ReconciliationEnv {
  PLATFORM_DB: D1Database;
  PLATFORM_SECRET: string;
}

export async function runProviderDeletionReconciliation(
  env: ReconciliationEnv,
  fetcher: typeof fetch = fetch,
  limit = 25,
): Promise<{ scanned: number; confirmed: number; indeterminate: number; pending: number; retained: number }> {
  const boundedLimit = Number.isInteger(limit) ? Math.min(100, Math.max(1, limit)) : 25;
  const { results } = await env.PLATFORM_DB.prepare(
    `SELECT o.*,conn.owner_id,conn.credential_ciphertext,conn.credential_iv,conn.provider AS connection_provider,
            conn.region AS connection_region,computer.template_id,computer.template_version,computer.filesystem_id
       FROM sandbox_provider_deletion_operations o
       LEFT JOIN sandbox_connections conn ON conn.id=o.connection_id
       LEFT JOIN sandbox_computers computer ON computer.id=o.computer_id
      WHERE o.status IN ('pending','dispatching','deletion_requested','indeterminate')
      ORDER BY o.created_at,o.id LIMIT ?`,
  ).bind(boundedLimit).all<ProviderDeletionOperation>();
  const counts = { scanned: 0, confirmed: 0, indeterminate: 0, pending: 0, retained: 0 };
  for (const operation of results ?? []) {
    counts.scanned++;
    const adapter = await adapterForOperation(operation, env.PLATFORM_SECRET, fetcher);
    if (!adapter) {
      const status = operation.external_id ? "indeterminate" : "retained";
      const reason = operation.external_id ? "provider_connection_unavailable" : "allocation_identity_unknown";
      await env.PLATFORM_DB.prepare(
        "UPDATE sandbox_provider_deletion_operations SET status=?,reason_code=?,updated_at=? WHERE id=? AND status IN ('pending','dispatching','deletion_requested','indeterminate')",
      ).bind(status, reason, new Date().toISOString(), operation.id).run();
      if (status === "retained") counts.retained++;
      else counts.indeterminate++;
      continue;
    }
    const store = d1Store(env.PLATFORM_DB);
    const status = await reconcileProviderDeletionOperation(operation, adapter, store);
    if (status === "confirmed_deleted") counts.confirmed++;
    else if (status === "indeterminate") counts.indeterminate++;
    else if (status === "retained") counts.retained++;
    else counts.pending++;
  }
  return counts;
}

/** Inspect provider resources left in intent/unknown/error states without replaying create.
 * Observed resources are left in recovery_required until an operator or a separately accepted
 * runtime lifecycle binds them again. */
export async function runSandboxAllocationReconciliation(
  env: ReconciliationEnv,
  fetcher: typeof fetch = fetch,
  limit = 25,
  now = new Date(),
): Promise<{ scanned: number; observed: number; indeterminate: number }> {
  const boundedLimit = Number.isInteger(limit) ? Math.min(100, Math.max(1, limit)) : 25;
  const { results } = await env.PLATFORM_DB.prepare(
    `SELECT a.id AS allocation_id,a.computer_id,a.connection_id,a.provider,a.external_id,a.generation,
            c.tenant_id,c.space_id,c.project_id,conn.owner_id,conn.credential_ciphertext,conn.credential_iv,
            conn.provider AS connection_provider,conn.region AS connection_region,c.template_id,c.template_version
       FROM sandbox_allocations a JOIN sandbox_computers c ON c.id=a.computer_id
       LEFT JOIN sandbox_connections conn ON conn.id=a.connection_id
      WHERE a.status IN ('intent','unknown','error')
        AND NOT EXISTS (SELECT 1 FROM sandbox_provider_deletion_operations d WHERE d.allocation_id=a.id AND d.status NOT IN ('confirmed_deleted','retained'))
      ORDER BY a.updated_at,a.id LIMIT ?`,
  ).bind(boundedLimit).all<ProviderDeletionOperation>();
  const counts = { scanned: 0, observed: 0, indeterminate: 0 };
  for (const row of results ?? []) {
    counts.scanned++;
    const current = now.toISOString();
    const adapter = await adapterForOperation({ ...row, id: row.allocation_id, status: "indeterminate" }, env.PLATFORM_SECRET, fetcher);
    let observed: ProviderObservedState = "error";
    let reason: string | null = null;
    if (!row.external_id) reason = "allocation_identity_unknown";
    else if (!adapter) reason = "provider_connection_unavailable";
    else {
      try { observed = await adapter.inspect(); }
      catch { reason = "provider_inspection_unavailable"; }
    }
    if (reason) counts.indeterminate++;
    else counts.observed++;
    const receiptId = `salloc_${await sha256Hex(`${row.tenant_id}\0${row.allocation_id}\0${row.generation}`)}`;
    await env.PLATFORM_DB.prepare(
      `INSERT INTO sandbox_allocation_reconciliation_receipts
        (id,tenant_id,computer_id,allocation_id,generation,observed_state,reason_code,observed_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(tenant_id,allocation_id,generation) DO UPDATE SET computer_id=excluded.computer_id,
         observed_state=excluded.observed_state,reason_code=excluded.reason_code,observed_at=excluded.observed_at`,
    ).bind(receiptId, row.tenant_id, row.computer_id, row.allocation_id, row.generation,
      reason ? "unknown" : observed, reason, current).run();
    if (!reason && observed === "deleted") {
      await env.PLATFORM_DB.batch([
        env.PLATFORM_DB.prepare("UPDATE sandbox_allocations SET status='destroyed',updated_at=? WHERE id=? AND generation=? AND status IN ('intent','unknown','error')").bind(current, row.allocation_id, row.generation),
        env.PLATFORM_DB.prepare(`UPDATE sandbox_computers SET state=CASE WHEN deleted_at IS NULL THEN 'recovery_required' ELSE 'deleted' END,
          updated_at=? WHERE id=? AND NOT EXISTS (SELECT 1 FROM sandbox_allocations WHERE computer_id=? AND status IN ('intent','unknown','error'))`)
          .bind(current, row.computer_id, row.computer_id),
      ]);
    } else if (!reason && (observed === "running" || observed === "sleeping")) {
      await env.PLATFORM_DB.batch([
        env.PLATFORM_DB.prepare("UPDATE sandbox_allocations SET status=?,updated_at=? WHERE id=? AND generation=? AND status IN ('intent','unknown','error')")
          .bind(observed === "running" ? "active" : "sleeping", current, row.allocation_id, row.generation),
        env.PLATFORM_DB.prepare("UPDATE sandbox_computers SET state='recovery_required',updated_at=? WHERE id=? AND deleted_at IS NULL")
          .bind(current, row.computer_id),
      ]);
    }
  }
  return counts;
}

async function adapterForOperation(operation: ProviderDeletionOperation, secret: string, fetcher: typeof fetch): Promise<ProviderDeletionAdapter | null> {
  if (!operation.external_id || !operation.connection_id || !operation.owner_id || !operation.credential_ciphertext || !operation.credential_iv) return null;
  if (operation.connection_provider !== operation.provider) return null;
  let credentials: Record<string, unknown>;
  try {
    const parsed = JSON.parse(await openConnection(secret, operation.tenant_id, operation.owner_id, operation.connection_id,
      { ciphertext: operation.credential_ciphertext, iv: operation.credential_iv })) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    credentials = parsed as Record<string, unknown>;
  } catch { return null; }
  const allocation: ProviderAllocation = {
    provider: operation.provider as ProviderAllocation["provider"],
    externalId: operation.external_id,
    generation: operation.generation,
    ...(operation.base_url ? { endpoint: operation.base_url } : {}),
  };
  if (operation.provider === "agent37" && typeof credentials.apiKey === "string" && typeof credentials.instanceKey === "string") {
    const provider = Agent37Provider.forControlPlane({ apiKey: credentials.apiKey, instanceKey: credentials.instanceKey }, fetcher);
    return {
      inspect: async () => (await provider.inspect(allocation)).state,
      destroy: async () => provider.destroy(allocation),
    };
  }
  if (operation.provider === "opensandbox" && typeof credentials.baseUrl === "string" && typeof credentials.apiKey === "string" && typeof credentials.template === "string") {
    try {
      const provider = new OpenSandboxProvider({ baseUrl: credentials.baseUrl, apiKey: credentials.apiKey, template: credentials.template }, fetcher);
      return {
        inspect: async () => (await provider.inspect(allocation)).state,
        destroy: async () => provider.destroy(allocation),
      };
    } catch { return null; }
  }
  return null;
}

function d1Store(db: D1Database): ProviderDeletionStore {
  return {
    async claimDelete(id, now) {
      const result = await db.prepare(
        `UPDATE sandbox_provider_deletion_operations SET status='dispatching',delete_dispatched_at=?,updated_at=?
          WHERE id=? AND (status='pending' OR (status='indeterminate' AND delete_dispatched_at IS NULL
            AND reason_code IN ('provider_connection_unavailable','provider_inspection_unavailable','provider_state_unconfirmed')))` ,
      ).bind(now, now, id).run();
      return result.meta.changes === 1;
    },
    async save(id, status, reasonCode, observedState, now) {
      await db.prepare(
        "UPDATE sandbox_provider_deletion_operations SET status=?,reason_code=?,last_observed_state=?,last_reconciled_at=?,updated_at=? WHERE id=? AND status!='confirmed_deleted'",
      ).bind(status, reasonCode, observedState, now, now, id).run();
    },
    async confirmDeleted(operation, now) {
      const erased = await db.prepare(`SELECT
          EXISTS (SELECT 1 FROM workspace_erasure_tombstones WHERE tenant_id=? AND space_id=? AND project_id=?) AS project_erased,
          EXISTS (SELECT 1 FROM orgs WHERE id=? AND status='erased') AS tenant_erased`)
        .bind(operation.tenant_id, operation.space_id, operation.project_id, operation.tenant_id)
        .first<{ project_erased: number; tenant_erased: number }>();
      const statements = [
        db.prepare("UPDATE sandbox_provider_deletion_operations SET status='confirmed_deleted',reason_code=NULL,last_observed_state='deleted',last_reconciled_at=?,completed_at=?,updated_at=? WHERE id=?").bind(now, now, now, operation.id),
        db.prepare("UPDATE sandbox_allocations SET status='destroyed',updated_at=? WHERE id=? AND computer_id=? AND generation=?").bind(now, operation.allocation_id, operation.computer_id, operation.generation),
        db.prepare("UPDATE sandbox_computers SET state='deleted',deleted_at=COALESCE(deleted_at,?),updated_at=? WHERE id=? AND NOT EXISTS (SELECT 1 FROM sandbox_allocations WHERE computer_id=? AND status!='destroyed')").bind(now, now, operation.computer_id, operation.computer_id),
      ];
      if (erased?.project_erased || erased?.tenant_erased) {
        statements.push(
          db.prepare("DELETE FROM sandbox_allocations WHERE id=? AND status='destroyed'").bind(operation.allocation_id),
          db.prepare(`DELETE FROM sandbox_computers WHERE id=?
            AND NOT EXISTS (SELECT 1 FROM sandbox_allocations WHERE computer_id=? AND status!='destroyed')
            AND NOT EXISTS (SELECT 1 FROM sandbox_provider_deletion_operations WHERE computer_id=? AND status!='confirmed_deleted')`)
            .bind(operation.computer_id, operation.computer_id, operation.computer_id),
          db.prepare("DELETE FROM sandbox_filesystems WHERE id=? AND NOT EXISTS (SELECT 1 FROM sandbox_computers WHERE filesystem_id=sandbox_filesystems.id)")
            .bind(operation.filesystem_id ?? null),
        );
      }
      statements.push(db.prepare("UPDATE sandbox_connections SET credential_ciphertext=NULL,credential_iv=NULL,updated_at=? WHERE id=? AND status='revoked' AND NOT EXISTS (SELECT 1 FROM sandbox_provider_deletion_operations WHERE connection_id=? AND status!='confirmed_deleted')")
        .bind(now, operation.connection_id, operation.connection_id));
      if (erased?.tenant_erased) statements.push(db.prepare("DELETE FROM sandbox_connections WHERE id=? AND status='revoked' AND NOT EXISTS (SELECT 1 FROM sandbox_provider_deletion_operations WHERE connection_id=? AND status!='confirmed_deleted')")
        .bind(operation.connection_id, operation.connection_id));
      await db.batch(statements);
    },
  };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
