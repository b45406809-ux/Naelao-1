import type { ModalLifecycleHooks, ModalSandboxRecord } from "./modal-lifecycle.js";

export type ModalSandboxBillingHooks = Pick<ModalLifecycleHooks, "reserve" | "settle" | "release">;
type ModalSandboxScope = Pick<ModalSandboxRecord, "tenantId" | "spaceId" | "projectId">;
type JournalRow = { request_sha256: string; record_json: string };

function validScope(scope: ModalSandboxScope): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(scope.tenantId)
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(scope.spaceId)
    && (scope.projectId === undefined || /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(scope.projectId));
}

function storedRecord(row: JournalRow, scope: ModalSandboxScope, idempotencyKey: string): ModalSandboxRecord {
  let record: ModalSandboxRecord;
  try { record = JSON.parse(row.record_json) as ModalSandboxRecord; }
  catch { throw new Error("modal_operation_journal_corrupt"); }
  if (!record || record.requestHash !== row.request_sha256 || record.tenantId !== scope.tenantId
    || record.spaceId !== scope.spaceId || record.projectId !== scope.projectId || record.idempotencyKey !== idempotencyKey
    || !/^[a-f0-9]{64}$/.test(record.requestHash) || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(record.region)
    || !Number.isSafeInteger(record.revision) || record.revision < 0
    || !Number.isFinite(record.createdAt) || !Number.isFinite(record.updatedAt)) {
    throw new Error("modal_operation_journal_corrupt");
  }
  return record;
}

/** D1-backed idempotency journal. The pending intent commits before any credit or provider call. */
export function createModalSandboxD1Hooks(
  db: Pick<D1Database, "prepare" | "batch">,
  billing: ModalSandboxBillingHooks,
): ModalLifecycleHooks {
  return {
    ...billing,
    async load(scope, idempotencyKey) {
      if (!validScope(scope) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(idempotencyKey))
        throw new Error("modal_operation_journal_scope_invalid");
      const row = await db.prepare(`SELECT request_sha256,record_json FROM modal_sandbox_operations
        WHERE tenant_id=? AND space_id=? AND project_id IS ? AND idempotency_key=?`)
        .bind(scope.tenantId, scope.spaceId, scope.projectId ?? null, idempotencyKey).first<JournalRow>();
      return row ? { requestHash: row.request_sha256, record: storedRecord(row, scope, idempotencyKey) } : null;
    },
    async claim(record) {
      if (!validScope(record) || typeof record.projectId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(record.projectId)
        || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(record.actorId)
        || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(record.idempotencyKey)
        || !/^[a-f0-9]{64}$/.test(record.requestHash) || record.state !== "pending" || record.revision !== 0) {
        throw new Error("modal_operation_journal_record_invalid");
      }
      const at = new Date(record.createdAt).toISOString();
      const request = JSON.stringify({ image: record.image, cpu: record.cpu, memoryMb: record.memoryMb, region: record.region,
        timeoutSeconds: record.timeoutSeconds, gpu: record.gpu, maximumCredits: record.reservedCredits });
      if (request.length > 8192) throw new Error("modal_operation_journal_record_invalid");
      const result = await db.prepare(`INSERT OR IGNORE INTO modal_sandbox_operations(
          operation_id,tenant_id,space_id,project_id,actor_id,region,idempotency_key,request_sha256,request_json,record_json,provider_id,
          state,revision,reserved_credits,actual_credits,overrun_credits,error_code,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,NULL,'pending',0,?,NULL,NULL,NULL,?,?)`)
          .bind(record.id, record.tenantId, record.spaceId, record.projectId ?? null, record.actorId, record.region, record.idempotencyKey,
            record.requestHash, request, JSON.stringify(record), record.reservedCredits, at, at).run();
      if (result.meta.changes === 1) return true;
      const prior = await this.load({ tenantId: record.tenantId, spaceId: record.spaceId, projectId: record.projectId }, record.idempotencyKey);
      if (!prior || prior.requestHash !== record.requestHash) throw new Error("modal_sandbox_idempotency_conflict");
      return false;
    },
    async record(record) {
      if (!validScope(record) || !/^[a-f0-9]{64}$/.test(record.requestHash)) throw new Error("modal_operation_journal_record_invalid");
      const at = new Date(record.updatedAt).toISOString();
      const json = JSON.stringify(record);
      if (json.length > 8192) throw new Error("modal_operation_journal_record_invalid");
      const eventId = `mse_${crypto.randomUUID().replaceAll("-", "")}`;
      if (!Number.isSafeInteger(record.revision) || record.revision < 1) throw new Error("modal_operation_journal_record_invalid");
      const result = await db.batch([
        db.prepare(`UPDATE modal_sandbox_operations SET provider_id=?,state=?,revision=?,actual_credits=?,overrun_credits=?,error_code=?,record_json=?,updated_at=?
          WHERE operation_id=? AND tenant_id=? AND space_id=? AND project_id=? AND request_sha256=? AND revision=?`)
          .bind(record.providerId ?? null, record.state, record.revision, record.actualCredits ?? null, record.overrunCredits ?? null,
            record.errorCode ?? null, json, at, record.id, record.tenantId, record.spaceId, record.projectId, record.requestHash, record.revision - 1),
        db.prepare(`INSERT INTO modal_sandbox_operation_events(event_id,operation_id,tenant_id,space_id,project_id,actor_id,region,state,revision,error_code,created_at)
          SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM modal_sandbox_operations
            WHERE operation_id=? AND request_sha256=? AND revision=? AND updated_at=? AND state=?)`)
          .bind(eventId, record.id, record.tenantId, record.spaceId, record.projectId ?? null, record.actorId, record.region,
            record.state, record.revision, record.errorCode ?? null, at, record.id, record.requestHash, record.revision, at, record.state),
        db.prepare(`DELETE FROM modal_sandbox_operation_events WHERE operation_id=? AND event_id NOT IN
          (SELECT event_id FROM modal_sandbox_operation_events WHERE operation_id=? ORDER BY created_at DESC,event_id DESC LIMIT 100)`)
          .bind(record.id, record.id),
      ]);
      if (result[0]?.meta.changes !== 1 || result[1]?.meta.changes !== 1) throw new Error("modal_operation_journal_write_failed");
    },
  };
}
