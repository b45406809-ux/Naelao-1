type Scope = { tenantId: string; spaceId: string; projectId: string; installationId: string; containerId: string };
type ProfileRow = { max_execution_seconds: number; version: number; updated_by: string; updated_at: string };
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

export async function readSidecarRuntimeExecutionProfile(
  db: D1Database,
  scope: Scope,
  maximumSeconds: number,
) {
  if (!Number.isSafeInteger(maximumSeconds) || maximumSeconds < 1 || maximumSeconds > 60) throw new Error("sidecar_runtime_profile_invalid");
  const row = await db.prepare(`SELECT max_execution_seconds,version,updated_by,updated_at FROM sidecar_runtime_execution_profiles
    WHERE tenant_id=? AND space_id=? AND project_id=? AND installation_id=? AND container_id=?`)
    .bind(scope.tenantId,scope.spaceId,scope.projectId,scope.installationId,scope.containerId).first<ProfileRow>();
  return {
    maxExecutionSeconds: Math.min(row?.max_execution_seconds ?? maximumSeconds, maximumSeconds),
    maximumSeconds,
    version: row?.version ?? 0,
    updatedBy: row?.updated_by ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

export async function saveSidecarRuntimeExecutionProfile(
  db: D1Database,
  scope: Scope,
  input: { maxExecutionSeconds: number; maximumSeconds: number; expectedVersion: number; actorId: string },
  now = new Date(),
) {
  if (![scope.tenantId,scope.spaceId,scope.projectId,scope.installationId,scope.containerId,input.actorId].every(value => ID.test(value))
    || !Number.isSafeInteger(input.maximumSeconds) || input.maximumSeconds < 1 || input.maximumSeconds > 60
    || !Number.isSafeInteger(input.maxExecutionSeconds) || input.maxExecutionSeconds < 1 || input.maxExecutionSeconds > input.maximumSeconds
    || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new Error("sidecar_runtime_profile_invalid");
  }
  const prior = await db.prepare(`SELECT max_execution_seconds,version FROM sidecar_runtime_execution_profiles
    WHERE tenant_id=? AND space_id=? AND project_id=? AND installation_id=? AND container_id=?`)
    .bind(scope.tenantId,scope.spaceId,scope.projectId,scope.installationId,scope.containerId)
    .first<{max_execution_seconds:number;version:number}>();
  const version = prior?.version ?? 0;
  if (version !== input.expectedVersion) throw new Error("sidecar_runtime_profile_version_conflict");
  if (prior?.max_execution_seconds === input.maxExecutionSeconds)
    return { maxExecutionSeconds: input.maxExecutionSeconds, maximumSeconds: input.maximumSeconds, version, changed: false };

  const nextVersion = version + 1;
  const at = now.toISOString();
  const auditId = `srep_${crypto.randomUUID().replaceAll("-", "")}`;
  const results = await db.batch([
    db.prepare(`INSERT INTO sidecar_runtime_execution_profiles(tenant_id,space_id,project_id,installation_id,container_id,max_execution_seconds,version,updated_by,updated_at)
      VALUES(?,?,?,?,?,?,1,?,?) ON CONFLICT(tenant_id,space_id,project_id,installation_id,container_id) DO UPDATE SET
      max_execution_seconds=excluded.max_execution_seconds,version=sidecar_runtime_execution_profiles.version+1,updated_by=excluded.updated_by,updated_at=excluded.updated_at
      WHERE sidecar_runtime_execution_profiles.version=?`)
      .bind(scope.tenantId,scope.spaceId,scope.projectId,scope.installationId,scope.containerId,input.maxExecutionSeconds,input.actorId,at,input.expectedVersion),
    db.prepare(`INSERT INTO sidecar_runtime_execution_profile_audit(id,tenant_id,space_id,project_id,installation_id,container_id,
      previous_max_execution_seconds,new_max_execution_seconds,version,actor_id,created_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,? FROM sidecar_runtime_execution_profiles WHERE tenant_id=? AND space_id=? AND project_id=?
        AND installation_id=? AND container_id=? AND max_execution_seconds=? AND version=? AND updated_by=?`)
      .bind(auditId,scope.tenantId,scope.spaceId,scope.projectId,scope.installationId,scope.containerId,prior?.max_execution_seconds??null,
        input.maxExecutionSeconds,nextVersion,input.actorId,at,scope.tenantId,scope.spaceId,scope.projectId,scope.installationId,scope.containerId,
        input.maxExecutionSeconds,nextVersion,input.actorId),
  ]);
  if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) throw new Error("sidecar_runtime_profile_version_conflict");
  return { maxExecutionSeconds: input.maxExecutionSeconds, maximumSeconds: input.maximumSeconds, version: nextVersion, changed: true };
}
