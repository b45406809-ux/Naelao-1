import { DYNAMIC_PROFILES, isDynamicProfile, type DynamicProfile, assertDynamicPlan } from "../script-engine/dynamic-containers.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
type Scope = { tenantId: string; spaceId: string; projectId: string };
type ProfileRow = { profile: string; version: number; updated_by: string; updated_at: string };
type MainRuntimeRegistryRow = { state: string; allocation_generation: number; last_seen_at: string };

export type ProjectMainRuntimeStatus = {
  state: "registered" | "active" | "sleeping" | "recovery_required" | "erased" | "unknown";
  allocationGeneration: number;
  lastSeenAt: string | null;
  source: "control_plane_registry";
  liveHealthVerified: false;
  budgetReservation: {
    status: "held" | "expired" | "released" | "settled" | "missing";
    expiresAt: string | null;
  } | null;
} | null;

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

/** Return only the persisted host-side state; this is not a provider health probe. */
export async function readProjectMainRuntimeStatus(db: D1Database, scope: Scope): Promise<ProjectMainRuntimeStatus> {
  const row = await db.prepare(`SELECT r.state,r.allocation_generation,r.last_seen_at,
      b.status AS budget_reservation_status,b.expires_at AS budget_reservation_expires_at,
      r.budget_reservation_id
    FROM project_main_runtime_registry r
    LEFT JOIN workflow_budget_reservations b ON b.id=r.budget_reservation_id AND b.org_id=r.tenant_id AND b.space_id=r.space_id
    WHERE r.tenant_id=? AND r.space_id=? AND r.project_id=?`)
    .bind(scope.tenantId,scope.spaceId,scope.projectId).first<MainRuntimeRegistryRow & {
      budget_reservation_id: string | null;
      budget_reservation_status: string | null;
      budget_reservation_expires_at: string | null;
    }>();
  if (!row) return null;
  const knownStates = ["registered", "active", "sleeping", "recovery_required", "erased"] as const;
  return {
    state: (knownStates as readonly string[]).includes(row.state)
      ? row.state as Exclude<ProjectMainRuntimeStatus, null>["state"]
      : "unknown",
    allocationGeneration: Number.isSafeInteger(row.allocation_generation) && row.allocation_generation >= 0
      ? row.allocation_generation : 0,
    lastSeenAt: typeof row.last_seen_at === "string" ? row.last_seen_at : null,
    source: "control_plane_registry",
    liveHealthVerified: false,
    budgetReservation: row.budget_reservation_id ? {
      status: row.budget_reservation_status === "held" && row.budget_reservation_expires_at
        && Date.parse(row.budget_reservation_expires_at) <= Date.now() ? "expired"
        : (["held", "released", "settled"].includes(row.budget_reservation_status ?? "")
          ? row.budget_reservation_status as "held" | "released" | "settled" : "missing"),
      expiresAt: typeof row.budget_reservation_expires_at === "string" ? row.budget_reservation_expires_at : null,
    } : null,
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
