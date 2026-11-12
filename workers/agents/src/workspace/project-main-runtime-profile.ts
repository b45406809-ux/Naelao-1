import { DYNAMIC_PROFILES, isDynamicProfile, type DynamicProfile, assertDynamicPlan } from "../script-engine/dynamic-containers.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
type Scope = { tenantId: string; spaceId: string; projectId: string };
type ProfileRow = { profile: string; version: number; updated_by: string; updated_at: string };

function allowedProfiles(planTier: string): DynamicProfile[] {
  return (Object.keys(DYNAMIC_PROFILES) as DynamicProfile[]).filter((profile) => {
    try { assertDynamicPlan(profile, planTier); return true; } catch { return false; }
  });
}

export async function readProjectMainRuntimeProfile(
  db: D1Database,
  scope: Scope,
  planTier: string,
  configuredDefault: string | undefined,
) {
  const fallback: DynamicProfile = isDynamicProfile(configuredDefault) ? configuredDefault : "standard-1";
  const row = await db.prepare(`SELECT profile,version,updated_by,updated_at FROM project_main_runtime_profiles
    WHERE tenant_id=? AND space_id=? AND project_id=?`)
    .bind(scope.tenantId,scope.spaceId,scope.projectId).first<ProfileRow>();
  return {
    profile: row && isDynamicProfile(row.profile) ? row.profile : fallback,
    source: row ? "project" as const : "deployment_default" as const,
    version: row?.version ?? 0,
    updatedBy: row?.updated_by ?? null,
    updatedAt: row?.updated_at ?? null,
    allowedProfiles: allowedProfiles(planTier),
  };
}

export async function saveProjectMainRuntimeProfile(
  db: D1Database,
  scope: Scope,
  planTier: string,
  input: { profile: string; expectedVersion: number; actorId: string },
  now = new Date(),
) {
  if (!ID.test(scope.tenantId) || !ID.test(scope.spaceId) || !ID.test(scope.projectId)
    || !ID.test(input.actorId) || !isDynamicProfile(input.profile)
    || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new Error("project_main_runtime_profile_invalid");
  }
  try { assertDynamicPlan(input.profile, planTier); }
  catch { throw new Error("project_main_runtime_profile_plan_limit"); }

  const prior = await db.prepare(`SELECT profile,version FROM project_main_runtime_profiles
    WHERE tenant_id=? AND space_id=? AND project_id=?`)
    .bind(scope.tenantId,scope.spaceId,scope.projectId).first<{profile:string;version:number}>();
  const currentVersion = prior?.version ?? 0;
  if (currentVersion !== input.expectedVersion) throw new Error("project_main_runtime_profile_version_conflict");
  if (prior?.profile === input.profile) return { profile: input.profile as DynamicProfile, version: currentVersion, changed: false };

  const version = currentVersion + 1;
  const at = now.toISOString();
  const auditId = `pmrpa_${crypto.randomUUID().replaceAll("-", "")}`;
  const results = await db.batch([
    db.prepare(`INSERT INTO project_main_runtime_profiles(tenant_id,space_id,project_id,profile,version,updated_by,updated_at)
      VALUES(?,?,?,?,1,?,?) ON CONFLICT(tenant_id,space_id,project_id) DO UPDATE SET profile=excluded.profile,
      version=project_main_runtime_profiles.version+1,updated_by=excluded.updated_by,updated_at=excluded.updated_at
      WHERE project_main_runtime_profiles.version=?`)
      .bind(scope.tenantId,scope.spaceId,scope.projectId,input.profile,input.actorId,at,input.expectedVersion),
    db.prepare(`INSERT INTO project_main_runtime_profile_audit(id,tenant_id,space_id,project_id,previous_profile,new_profile,version,actor_id,created_at)
      SELECT ?,?,?,?,?,?,?,?,? FROM project_main_runtime_profiles WHERE tenant_id=? AND space_id=? AND project_id=?
        AND profile=? AND version=? AND updated_by=?`)
      .bind(auditId,scope.tenantId,scope.spaceId,scope.projectId,prior?.profile??null,input.profile,version,input.actorId,at,
        scope.tenantId,scope.spaceId,scope.projectId,input.profile,version,input.actorId),
  ]);
  if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1)
    throw new Error("project_main_runtime_profile_version_conflict");
  return { profile: input.profile as DynamicProfile, version, changed: true };
}
