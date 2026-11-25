import { execute, queryAll, queryOne } from "@naelao/db";

type Sql = Parameters<typeof queryOne>[0];

/**
 * MS-24 (decision D10): storage and validation for worker preference limits, per-user
 * preferences and their audit trail.
 *
 * The bound constants below are intentionally duplicated from
 * `workers/agents/src/shared/worker-preferences.ts` (MS-23): the spaces worker cannot import from
 * workers/agents and no existing shared package hosts these worker constants. Keep both in sync.
 * The goal credit ceiling uses the existing 1..10,000,000 credit bound used by extension budgets.
 */
export const WORKER_COUNT_MIN = 1; // MS-23 ADMIN_WORKER_COUNT_MIN
export const WORKER_COUNT_MAX = 10; // MS-23 ADMIN_WORKER_COUNT_MAX
export const GOAL_CREDIT_CEILING_MIN = 1;
export const GOAL_CREDIT_CEILING_MAX = 10_000_000;
export const MODEL_TIERS_MAX = 10;
export const MODEL_TIER_MAX_LENGTH = 64;
export const AUDIT_LIST_DEFAULT = 50;
export const AUDIT_LIST_MAX = 200;

export interface WorkerPreferenceLimitValues {
  max_workers: number | null;
  allowed_model_tiers: string[] | null;
  goal_credit_ceiling: number | null;
}
export interface WorkerUserPreferenceValues {
  worker_count: number | null;
  preferred_model_tier: string | null;
  goal_credit_ceiling: number | null;
}
export type ValidationResult<T> = { ok: true; value: T } | { ok: false };

const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;

function optionalCeiling(v: unknown): ValidationResult<number | null> {
  if (v === undefined || v === null) return { ok: true, value: null };
  return isInt(v, GOAL_CREDIT_CEILING_MIN, GOAL_CREDIT_CEILING_MAX) ? { ok: true, value: v } : { ok: false };
}

function tierName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed.length > 0 && trimmed.length <= MODEL_TIER_MAX_LENGTH ? trimmed : null;
}

/** Body keys are replaced as a whole: an absent or null field clears that setting. Unknown keys are rejected. */
export function validateLimitsBody(body: unknown): ValidationResult<WorkerPreferenceLimitValues> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false };
  const b = body as Record<string, unknown>;
  if (Object.keys(b).some(k => !["max_workers", "allowed_model_tiers", "goal_credit_ceiling"].includes(k))) return { ok: false };
  let maxWorkers: number | null = null;
  if (b.max_workers !== undefined && b.max_workers !== null) {
    if (!isInt(b.max_workers, WORKER_COUNT_MIN, WORKER_COUNT_MAX)) return { ok: false };
    maxWorkers = b.max_workers;
  }
  let tiers: string[] | null = null;
  if (b.allowed_model_tiers !== undefined && b.allowed_model_tiers !== null) {
    if (!Array.isArray(b.allowed_model_tiers) || b.allowed_model_tiers.length === 0 || b.allowed_model_tiers.length > MODEL_TIERS_MAX) return { ok: false };
    const names = b.allowed_model_tiers.map(tierName);
    if (names.some(n => n === null)) return { ok: false };
    tiers = [...new Set(names as string[])];
  }
  const ceiling = optionalCeiling(b.goal_credit_ceiling);
  if (!ceiling.ok) return { ok: false };
  return { ok: true, value: { max_workers: maxWorkers, allowed_model_tiers: tiers, goal_credit_ceiling: ceiling.value } };
}

export function validateUserPreferencesBody(body: unknown): ValidationResult<WorkerUserPreferenceValues> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false };
  const b = body as Record<string, unknown>;
  if (Object.keys(b).some(k => !["worker_count", "preferred_model_tier", "goal_credit_ceiling"].includes(k))) return { ok: false };
  let workerCount: number | null = null;
  if (b.worker_count !== undefined && b.worker_count !== null) {
    if (!isInt(b.worker_count, WORKER_COUNT_MIN, WORKER_COUNT_MAX)) return { ok: false };
    workerCount = b.worker_count;
  }
  let tier: string | null = null;
  if (b.preferred_model_tier !== undefined && b.preferred_model_tier !== null) {
    tier = tierName(b.preferred_model_tier);
    if (tier === null) return { ok: false };
  }
  const ceiling = optionalCeiling(b.goal_credit_ceiling);
  if (!ceiling.ok) return { ok: false };
  return { ok: true, value: { worker_count: workerCount, preferred_model_tier: tier, goal_credit_ceiling: ceiling.value } };
}

const allNull = (v: object) => Object.values(v).every(x => x === null);

/** `project_id` is '' for the Space-level row (a NOT NULL sentinel, so the primary key is unambiguous). */
export function getLimits(sql: Sql, projectId: string): (WorkerPreferenceLimitValues & { updated_by: string; updated_at: string }) | null {
  const row = queryOne<{ max_workers: number | null; allowed_model_tiers_json: string | null; goal_credit_ceiling: number | null; updated_by: string; updated_at: string }>(
    sql, "SELECT max_workers,allowed_model_tiers_json,goal_credit_ceiling,updated_by,updated_at FROM worker_preference_limits WHERE project_id=?", projectId);
  if (!row) return null;
  return { max_workers: row.max_workers, allowed_model_tiers: row.allowed_model_tiers_json ? JSON.parse(row.allowed_model_tiers_json) as string[] : null,
    goal_credit_ceiling: row.goal_credit_ceiling, updated_by: row.updated_by, updated_at: row.updated_at };
}

export function getUserPreferences(sql: Sql, userId: string): (WorkerUserPreferenceValues & { updated_at: string }) | null {
  return queryOne<WorkerUserPreferenceValues & { updated_at: string }>(
    sql, "SELECT worker_count,preferred_model_tier,goal_credit_ceiling,updated_at FROM worker_user_preferences WHERE user_id=?", userId) ?? null;
}

function writeAudit(sql: Sql, scope: string, actorId: string, before: unknown, after: unknown, now: string): void {
  execute(sql, "INSERT INTO worker_preference_audit(id,scope,actor_id,before_json,after_json,created_at) VALUES(?,?,?,?,?,?)",
    crypto.randomUUID(), scope, actorId, before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after), now);
}

/** Must run inside one DO transaction. Returns whether anything changed (a no-op writes no audit row). */
export function putLimits(sql: Sql, projectId: string, next: WorkerPreferenceLimitValues, actorId: string, now: string): { changed: boolean } {
  const prev = getLimits(sql, projectId);
  const before = prev ? { max_workers: prev.max_workers, allowed_model_tiers: prev.allowed_model_tiers, goal_credit_ceiling: prev.goal_credit_ceiling } : null;
  const after = allNull(next) ? null : next;
  if (JSON.stringify(before) === JSON.stringify(after)) return { changed: false };
  if (after === null) execute(sql, "DELETE FROM worker_preference_limits WHERE project_id=?", projectId);
  else execute(sql, `INSERT INTO worker_preference_limits(project_id,max_workers,allowed_model_tiers_json,goal_credit_ceiling,updated_by,updated_at) VALUES(?,?,?,?,?,?)
    ON CONFLICT(project_id) DO UPDATE SET max_workers=excluded.max_workers,allowed_model_tiers_json=excluded.allowed_model_tiers_json,
      goal_credit_ceiling=excluded.goal_credit_ceiling,updated_by=excluded.updated_by,updated_at=excluded.updated_at`,
    projectId, next.max_workers, next.allowed_model_tiers ? JSON.stringify(next.allowed_model_tiers) : null, next.goal_credit_ceiling, actorId, now);
  writeAudit(sql, projectId ? `project_limits:${projectId}` : "space_limits", actorId, before, after, now);
  return { changed: true };
}

export function putUserPreferences(sql: Sql, userId: string, next: WorkerUserPreferenceValues, now: string): { changed: boolean } {
  const prev = getUserPreferences(sql, userId);
  const before = prev ? { worker_count: prev.worker_count, preferred_model_tier: prev.preferred_model_tier, goal_credit_ceiling: prev.goal_credit_ceiling } : null;
  const after = allNull(next) ? null : next;
  if (JSON.stringify(before) === JSON.stringify(after)) return { changed: false };
  if (after === null) execute(sql, "DELETE FROM worker_user_preferences WHERE user_id=?", userId);
  else execute(sql, `INSERT INTO worker_user_preferences(user_id,worker_count,preferred_model_tier,goal_credit_ceiling,updated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET worker_count=excluded.worker_count,preferred_model_tier=excluded.preferred_model_tier,
      goal_credit_ceiling=excluded.goal_credit_ceiling,updated_at=excluded.updated_at`,
    userId, next.worker_count, next.preferred_model_tier, next.goal_credit_ceiling, now);
  writeAudit(sql, `user_preferences:${userId}`, userId, before, after, now);
  return { changed: true };
}

export function listAudit(sql: Sql, limit: number) {
  return queryAll<{ id: string; scope: string; actor_id: string; before_json: string | null; after_json: string | null; created_at: string }>(
    sql, "SELECT id,scope,actor_id,before_json,after_json,created_at FROM worker_preference_audit ORDER BY created_at DESC, rowid DESC LIMIT ?", limit)
    .map(r => ({ id: r.id, scope: r.scope, actor_id: r.actor_id, created_at: r.created_at,
      before: r.before_json ? JSON.parse(r.before_json) as unknown : null, after: r.after_json ? JSON.parse(r.after_json) as unknown : null }));
}
