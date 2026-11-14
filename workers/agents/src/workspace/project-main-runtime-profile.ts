import { DYNAMIC_PROFILES, isDynamicProfile, type DynamicProfile, assertDynamicPlan } from "../script-engine/dynamic-containers.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
type Scope = { tenantId: string; spaceId: string; projectId: string };
type ProfileRow = { profile: string; version: number; updated_by: string; updated_at: string };
type MainRuntimeRegistryRow = { state: string; allocation_generation: number; last_seen_at: string };
type RestartRecipeSetRow = { recipes_json: string; version: number; updated_by: string; updated_at: string };

export type ProjectMainRestartRecipe = {
  id: string;
  label: string;
  workingDirectory: string;
  argv: string[];
  manualVerification: string;
};

export type ProjectMainRestartRecipeSet = {
  recipes: ProjectMainRestartRecipe[];
  version: number;
  updatedBy: string | null;
  updatedAt: string | null;
  executionSupported: false;
};

const RESTART_RECIPE_SECRET_MATERIAL = /(?:--?(?:password|passwd|secret|token|api[-_]?key|authorization|bearer)\b|(?:password|passwd|secret|token|api[-_]?key|authorization|bearer)\s*=|\bBearer\s+[A-Za-z0-9._~+/-]{12,})/i;
const RESTART_RECIPE_SHELL_META = /[\u0000-\u001f\u007f`$;|&<>]/;

/** Strict metadata contract; the future adapter must execute argv with shell:false. */
export function validateProjectMainRestartRecipes(input: unknown): ProjectMainRestartRecipe[] {
  if (!Array.isArray(input) || input.length > 10) throw new Error("project_main_restart_recipes_invalid");
  const ids = new Set<string>();
  const recipes = input.map((value): ProjectMainRestartRecipe => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("project_main_restart_recipes_invalid");
    const row = value as Record<string, unknown>;
    if (Object.keys(row).some(key => !["id", "label", "workingDirectory", "argv", "manualVerification"].includes(key))) {
      throw new Error("project_main_restart_recipes_invalid");
    }
    if (typeof row.id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(row.id) || ids.has(row.id)) {
      throw new Error("project_main_restart_recipes_invalid");
    }
    ids.add(row.id);
    if (typeof row.label !== "string" || !row.label.trim() || row.label.trim().length > 80
      || /[\u0000-\u001f\u007f]/.test(row.label) || RESTART_RECIPE_SECRET_MATERIAL.test(row.label)) {
      throw new Error("project_main_restart_recipes_invalid");
    }
    if (typeof row.workingDirectory !== "string" || row.workingDirectory.length > 160
      || row.workingDirectory.startsWith("/") || row.workingDirectory.includes("\\")
      || !/^[A-Za-z0-9._/-]+$/.test(row.workingDirectory)
      || (row.workingDirectory !== "." && row.workingDirectory.split("/").some(part => !part || part === "." || part === ".."))) {
      throw new Error("project_main_restart_recipes_invalid");
    }
    if (!Array.isArray(row.argv) || row.argv.length < 1 || row.argv.length > 16
      || row.argv.some(token => typeof token !== "string" || !token.trim() || token.length > 256
        || RESTART_RECIPE_SHELL_META.test(token) || RESTART_RECIPE_SECRET_MATERIAL.test(token))) {
      throw new Error("project_main_restart_recipes_invalid");
    }
    const argv = (row.argv as string[]).map(token => token.trim());
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(argv[0]!)
      || ["sh", "bash", "zsh", "fish", "dash", "cmd", "powershell", "pwsh"].includes(argv[0]!.toLowerCase())) {
      throw new Error("project_main_restart_recipes_invalid");
    }
    if (typeof row.manualVerification !== "string" || !row.manualVerification.trim()
      || row.manualVerification.trim().length > 240 || /[\u0000-\u001f\u007f]/.test(row.manualVerification)
      || RESTART_RECIPE_SECRET_MATERIAL.test(row.manualVerification)) {
      throw new Error("project_main_restart_recipes_invalid");
    }
    return { id: row.id, label: row.label.trim(), workingDirectory: row.workingDirectory,
      argv, manualVerification: row.manualVerification.trim() };
  });
  if (JSON.stringify(recipes).length > 12_000) throw new Error("project_main_restart_recipes_invalid");
  return recipes;
}

function restartRecipeHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, "0")).join("");
}

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

/** Read owner-configured recovery metadata. This does not imply that an adapter can execute it. */
export async function readProjectMainRestartRecipes(db: D1Database, scope: Scope): Promise<ProjectMainRestartRecipeSet> {
  if (!ID.test(scope.tenantId) || !ID.test(scope.spaceId) || !ID.test(scope.projectId)) {
    throw new Error("project_main_restart_recipes_invalid");
  }
  const row = await db.prepare(`SELECT recipes_json,version,updated_by,updated_at FROM project_main_restart_recipe_sets
    WHERE tenant_id=? AND space_id=? AND project_id=?`)
    .bind(scope.tenantId,scope.spaceId,scope.projectId).first<RestartRecipeSetRow>();
  if (!row) return { recipes: [], version: 0, updatedBy: null, updatedAt: null, executionSupported: false };
  let parsed: unknown;
  try { parsed = JSON.parse(row.recipes_json); }
  catch { throw new Error("project_main_restart_recipes_corrupt"); }
  let recipes: ProjectMainRestartRecipe[];
  try { recipes = validateProjectMainRestartRecipes(parsed); }
  catch { throw new Error("project_main_restart_recipes_corrupt"); }
  if (!Number.isSafeInteger(row.version) || row.version < 1 || !ID.test(row.updated_by) || !Number.isFinite(Date.parse(row.updated_at)))
    throw new Error("project_main_restart_recipes_corrupt");
  return { recipes, version: row.version,
    updatedBy: row.updated_by, updatedAt: row.updated_at, executionSupported: false };
}

/** Persist an owner-reviewed recipe set with optimistic concurrency and an actor-attributed hash receipt. */
export async function saveProjectMainRestartRecipes(
  db: D1Database,
  scope: Scope,
  input: { recipes: unknown; expectedVersion: number; actorId: string },
  now = new Date(),
) {
  if (!ID.test(scope.tenantId) || !ID.test(scope.spaceId) || !ID.test(scope.projectId)
    || !ID.test(input.actorId) || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new Error("project_main_restart_recipes_invalid");
  }
  const recipes = validateProjectMainRestartRecipes(input.recipes);
  const recipesJson = JSON.stringify(recipes);
  const prior = await db.prepare(`SELECT recipes_json,version,updated_by,updated_at FROM project_main_restart_recipe_sets
    WHERE tenant_id=? AND space_id=? AND project_id=?`)
    .bind(scope.tenantId,scope.spaceId,scope.projectId).first<{recipes_json:string;version:number;updated_by:string;updated_at:string}>();
  const currentVersion = prior?.version ?? 0;
  if (prior && (!Number.isSafeInteger(currentVersion) || currentVersion < 1 || !ID.test(prior.updated_by)
    || !Number.isFinite(Date.parse(prior.updated_at)))) throw new Error("project_main_restart_recipes_corrupt");
  if (currentVersion !== input.expectedVersion) throw new Error("project_main_restart_recipes_version_conflict");
  let priorRecipes: ProjectMainRestartRecipe[] = [];
  if (prior) {
    try { priorRecipes = validateProjectMainRestartRecipes(JSON.parse(prior.recipes_json)); }
    catch { throw new Error("project_main_restart_recipes_corrupt"); }
  }
  if (JSON.stringify(priorRecipes) === recipesJson) {
    return { recipes, version: currentVersion, updatedBy: prior?.updated_by ?? null, updatedAt: prior?.updated_at ?? null,
      changed: false as const, executionSupported: false as const };
  }

  const version = currentVersion + 1;
  const at = now.toISOString();
  const auditId = `pmrr_${crypto.randomUUID().replaceAll("-", "")}`;
  const recipesDigest = restartRecipeHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(recipesJson)));
  const results = await db.batch([
    db.prepare(`INSERT INTO project_main_restart_recipe_sets(tenant_id,space_id,project_id,recipes_json,version,updated_by,updated_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(tenant_id,space_id,project_id) DO UPDATE SET recipes_json=excluded.recipes_json,
      version=project_main_restart_recipe_sets.version+1,updated_by=excluded.updated_by,updated_at=excluded.updated_at
      WHERE project_main_restart_recipe_sets.version=?`)
      .bind(scope.tenantId,scope.spaceId,scope.projectId,recipesJson,version,input.actorId,at,input.expectedVersion),
    db.prepare(`INSERT INTO project_main_restart_recipe_audit(id,tenant_id,space_id,project_id,previous_version,new_version,
        recipe_count,recipes_sha256,actor_id,created_at)
      SELECT ?,?,?,?,?,?,?,?,?,? FROM project_main_restart_recipe_sets
      WHERE changes()=1 AND tenant_id=? AND space_id=? AND project_id=? AND version=? AND updated_by=?`)
      .bind(auditId,scope.tenantId,scope.spaceId,scope.projectId,currentVersion,version,recipes.length,recipesDigest,input.actorId,at,
        scope.tenantId,scope.spaceId,scope.projectId,version,input.actorId),
  ]);
  if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1)
    throw new Error("project_main_restart_recipes_version_conflict");
  return { recipes, version, updatedBy: input.actorId, updatedAt: at, changed: true as const, executionSupported: false as const };
}
