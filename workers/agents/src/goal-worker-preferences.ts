/**
 * MS-25 / decision D10: goal-start snapshot of worker preferences (flag WORKER_PREFERENCES_ENABLED,
 * default off). The snapshot is taken once, stored on the goal journal (`GoalDagJournal.preferences`)
 * and read back for capacity, model choice and the credit ceiling. A running goal never re-reads
 * preferences. A fetch failure records `{ unavailable: true, reason: "preferences_unavailable" }`
 * and every consumer then keeps today's behavior.
 */
import { resolveWorkerPreferences, type ResolvedWorkerPreferences, type WorkerPreferenceLimits, type WorkerUserPreferences } from "./shared/worker-preferences.js";
import { WORKER_MODEL_TIER_COST } from "./script-engine/worker-model-tier-policy.js";

export type GoalPreferencesSnapshot =
  | ({ version: 1; unavailable?: false; takenAt: number } & Pick<ResolvedWorkerPreferences, "workerCount" | "allowedModelTiers" | "preferredModelTier" | "fallbackTiers" | "goalCreditCeiling" | "sources">)
  | { version: 1; unavailable: true; reason: "preferences_unavailable"; takenAt: number };

/** Shape returned by Spaces `GET /internal/worker-preferences` (stored rows only). */
export interface StoredWorkerPreferenceRows {
  space_limits: { max_workers: number | null; allowed_model_tiers: string[] | null; goal_credit_ceiling: number | null } | null;
  project_limits: { max_workers: number | null; allowed_model_tiers: string[] | null; goal_credit_ceiling: number | null } | null;
  user_preferences: { worker_count: number | null; preferred_model_tier: string | null; goal_credit_ceiling: number | null } | null;
}

const limitsFrom = (row: StoredWorkerPreferenceRows["space_limits"]): WorkerPreferenceLimits | undefined => {
  if (!row) return undefined;
  return {
    ...(row.max_workers !== null ? { maxWorkers: row.max_workers } : {}),
    ...(row.allowed_model_tiers !== null ? { allowedModelTiers: row.allowed_model_tiers } : {}),
    ...(row.goal_credit_ceiling !== null ? { goalCreditCeiling: row.goal_credit_ceiling } : {}),
  };
};

export function isStoredRows(value: unknown): value is StoredWorkerPreferenceRows {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return ["space_limits", "project_limits", "user_preferences"].every(key => v[key] === null || (typeof v[key] === "object" && !Array.isArray(v[key])));
}

export function resolveGoalPreferencesSnapshot(rows: StoredWorkerPreferenceRows, planMaxWorkers: number, now = Date.now()): GoalPreferencesSnapshot {
  const user: WorkerUserPreferences | undefined = rows.user_preferences ? {
    ...(rows.user_preferences.worker_count !== null ? { workerCount: rows.user_preferences.worker_count } : {}),
    ...(rows.user_preferences.preferred_model_tier !== null ? { preferredModelTier: rows.user_preferences.preferred_model_tier } : {}),
    ...(rows.user_preferences.goal_credit_ceiling !== null ? { goalCreditCeiling: rows.user_preferences.goal_credit_ceiling } : {}),
  } : undefined;
  const space = limitsFrom(rows.space_limits);
  const project = limitsFrom(rows.project_limits);
  const resolved = resolveWorkerPreferences({
    planLimits: { maxWorkers: planMaxWorkers },
    ...(space ? { spaceLimits: space } : {}),
    ...(project ? { projectSettings: project } : {}),
    ...(user ? { userPreferences: user } : {}),
    modelTierCost: WORKER_MODEL_TIER_COST,
  });
  const { workerCount, allowedModelTiers, preferredModelTier, fallbackTiers, goalCreditCeiling, sources } = resolved;
  return { version: 1, takenAt: now, workerCount, allowedModelTiers, preferredModelTier, fallbackTiers, goalCreditCeiling, sources };
}

export const unavailableGoalPreferences = (now = Date.now()): GoalPreferencesSnapshot =>
  ({ version: 1, unavailable: true, reason: "preferences_unavailable", takenAt: now });

/** A snapshot that can be applied (a usable one, not the unavailable marker). */
export const usableGoalPreferences = (snapshot: GoalPreferencesSnapshot | undefined): snapshot is Extract<GoalPreferencesSnapshot, { unavailable?: false }> =>
  snapshot !== undefined && snapshot.unavailable !== true && Number.isSafeInteger(snapshot.workerCount) && snapshot.workerCount >= 1;

/**
 * Fetch the stored rows for one goal start. Any failure (no binding, network, non-2xx, malformed body)
 * resolves to `undefined` so the caller records `preferences_unavailable`.
 */
export async function fetchStoredWorkerPreferences(input: {
  spaces: { fetch(request: Request): Promise<Response> } | undefined;
  headers: Record<string, string>;
  spaceId: string; projectId?: string | undefined; userId: string;
  readJson: (response: Response) => Promise<unknown>;
}): Promise<StoredWorkerPreferenceRows | undefined> {
  if (!input.spaces) return undefined;
  try {
    const query = new URLSearchParams({ space_id: input.spaceId, user_id: input.userId, ...(input.projectId ? { project_id: input.projectId } : {}) });
    const response = await input.spaces.fetch(new Request(`http://spaces-worker/internal/worker-preferences?${query}`, { headers: input.headers }));
    if (!response.ok) return undefined;
    const body = await input.readJson(response);
    return isStoredRows(body) ? body : undefined;
  } catch { return undefined; }
}
