/**
 * MS-18 / decision D8: per-goal credit ceiling (flag GOAL_CREDIT_CEILING_ENABLED, default off).
 *
 * Accounting lives in the NaelaoAgentDO SQLite next to `goal_dag_journals`:
 *  - `goal_dag_journals` gains `credit_ceiling`, `credits_settled`, `credits_held`, `budget_state`,
 *    `budget_reason`, `parent_run_id` (nullable; only written when the flag is on).
 *  - `goal_credit_reservations` holds one row per reservation ID. Settled/held totals are always
 *    recomputed from these rows, so settlement is idempotent per reservation ID.
 *
 * ESTIMATE SOURCE: a task's estimated reservation is its declared `budget_tokens` priced as output
 * tokens with `tokensToCredits` from @naelao/billing-core. Output tokens carry the highest per-token
 * rate, so this is the conservative upper bound on what the worker may spend, and it is the same
 * token budget the worker is already capped by (sub_agents.budget_tokens). The worker's real
 * per-call inference reservation (reserveRunInferenceCost) is a different, finer-grained Project
 * spend hold and is deliberately left untouched. Actual settlement scales the estimate by
 * tokens_used / budget_tokens (at least 1 credit once any token was used).
 *
 * DO SQLite rules: `?` placeholders only, no PRAGMA, no BEGIN/COMMIT.
 */
import { tokensToCredits } from "@naelao/billing-core";

export const DEFAULT_GOAL_CREDIT_CEILING = 200;
export const MAX_GOAL_CREDIT_CEILING = 10_000_000;
export const AWAITING_BUDGET_APPROVAL = "awaiting_budget_approval";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface SqlLike { exec<T = any>(query: string, ...params: any[]): { toArray(): any[]; rowsWritten?: number } }

export function ensureGoalCreditSchema(sql: SqlLike): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS goal_credit_reservations (
    reservation_id TEXT PRIMARY KEY, journal_key TEXT NOT NULL, task_id TEXT NOT NULL,
    estimated_credits INTEGER NOT NULL, settled_credits INTEGER,
    status TEXT NOT NULL CHECK (status IN ('held','settled')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`);
  sql.exec("CREATE INDEX IF NOT EXISTS idx_goal_credit_reservations_journal ON goal_credit_reservations(journal_key,status)");
  // MS-26: one durable resume record per budget-held goal (keyed by the goal's parent run).
  sql.exec(`CREATE TABLE IF NOT EXISTS goal_budget_resumes (
    parent_run_id TEXT PRIMARY KEY, journal_key TEXT NOT NULL, objective TEXT NOT NULL, tasks_json TEXT NOT NULL,
    context_json TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('held','resuming','resumed')),
    resumed_run_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`);
  for (const ddl of [
    "ALTER TABLE goal_dag_journals ADD COLUMN parent_run_id TEXT",
    "ALTER TABLE goal_dag_journals ADD COLUMN credit_ceiling INTEGER",
    "ALTER TABLE goal_dag_journals ADD COLUMN credits_settled INTEGER",
    "ALTER TABLE goal_dag_journals ADD COLUMN credits_held INTEGER",
    "ALTER TABLE goal_dag_journals ADD COLUMN budget_state TEXT",
    "ALTER TABLE goal_dag_journals ADD COLUMN budget_reason TEXT",
  ]) {
    try { sql.exec(ddl); } catch { /* already migrated */ }
  }
}

export function estimateGoalTaskCredits(budgetTokens: number, model: string): number {
  if (!Number.isSafeInteger(budgetTokens) || budgetTokens < 1) throw new Error("goal_task_budget_invalid");
  return tokensToCredits(0, budgetTokens, model);
}

export interface GoalCreditState { ceiling: number; settled: number; held: number; state: string | null; reason: string | null }

function totals(sql: SqlLike, journalKey: string): { settled: number; held: number } {
  const row = sql.exec<{ settled: number | null; held: number | null }>(
    `SELECT COALESCE(SUM(CASE WHEN status='settled' THEN settled_credits END),0) AS settled,
            COALESCE(SUM(CASE WHEN status='held' THEN estimated_credits END),0) AS held
     FROM goal_credit_reservations WHERE journal_key=?`, journalKey).toArray()[0];
  return { settled: Number(row?.settled ?? 0), held: Number(row?.held ?? 0) };
}

function mirror(sql: SqlLike, journalKey: string, now: number): { settled: number; held: number } {
  const t = totals(sql, journalKey);
  sql.exec("UPDATE goal_dag_journals SET credits_settled=?,credits_held=?,updated_at=? WHERE journal_key=?", t.settled, t.held, now, journalKey);
  return t;
}

export function readGoalCreditState(sql: SqlLike, journalKey: string): GoalCreditState | null {
  const row = sql.exec<{ credit_ceiling: number | null; budget_state: string | null; budget_reason: string | null }>(
    "SELECT credit_ceiling,budget_state,budget_reason FROM goal_dag_journals WHERE journal_key=?", journalKey).toArray()[0];
  if (!row) return null;
  const t = totals(sql, journalKey);
  return { ceiling: row.credit_ceiling ?? DEFAULT_GOAL_CREDIT_CEILING, settled: t.settled, held: t.held, state: row.budget_state, reason: row.budget_reason };
}

/**
 * Admit one task dispatch. A repeat call for the same reservation ID never double-counts: an
 * existing reservation is already inside settled/held and is admitted as-is.
 */
export function admitGoalTaskDispatch(sql: SqlLike, input: {
  journalKey: string; parentRunId: string; taskId: string; reservationId: string; estimatedCredits: number;
  defaultCeiling?: number; now?: number;
}): { ok: true } | { ok: false; reason: string } {
  const now = input.now ?? Date.now();
  sql.exec("UPDATE goal_dag_journals SET parent_run_id=COALESCE(parent_run_id,?),credit_ceiling=COALESCE(credit_ceiling,?) WHERE journal_key=?",
    input.parentRunId, input.defaultCeiling ?? DEFAULT_GOAL_CREDIT_CEILING, input.journalKey);
  if (sql.exec("SELECT 1 AS x FROM goal_credit_reservations WHERE reservation_id=?", input.reservationId).toArray().length) return { ok: true };
  const state = readGoalCreditState(sql, input.journalKey);
  if (!state) return { ok: false, reason: "goal_credit_journal_unavailable" };
  const projected = state.settled + state.held + input.estimatedCredits;
  if (projected > state.ceiling) {
    const reason = `goal_credit_ceiling_would_be_exceeded:settled=${state.settled},held=${state.held},estimate=${input.estimatedCredits},ceiling=${state.ceiling},task=${input.taskId}`.slice(0, 240);
    sql.exec("UPDATE goal_dag_journals SET budget_state=?,budget_reason=?,updated_at=? WHERE journal_key=?", AWAITING_BUDGET_APPROVAL, reason, now, input.journalKey);
    return { ok: false, reason };
  }
  sql.exec("INSERT OR IGNORE INTO goal_credit_reservations(reservation_id,journal_key,task_id,estimated_credits,status,created_at,updated_at) VALUES(?,?,?,?,'held',?,?)",
    input.reservationId, input.journalKey, input.taskId, input.estimatedCredits, now, now);
  sql.exec("UPDATE goal_dag_journals SET budget_state=NULL,budget_reason=NULL WHERE journal_key=? AND budget_state=?", input.journalKey, AWAITING_BUDGET_APPROVAL);
  mirror(sql, input.journalKey, now);
  return { ok: true };
}

/** Settle a held reservation exactly once. Returns false for an unknown or already settled ID. */
export function settleGoalCreditReservation(sql: SqlLike, input: {
  journalKey: string; reservationId: string; tokensUsed: number; budgetTokens: number; now?: number;
}): boolean {
  const now = input.now ?? Date.now();
  const row = sql.exec<{ estimated_credits: number; status: string }>(
    "SELECT estimated_credits,status FROM goal_credit_reservations WHERE reservation_id=? AND journal_key=?", input.reservationId, input.journalKey).toArray()[0];
  if (!row || row.status !== "held") return false;
  const used = Math.max(0, Math.min(input.tokensUsed, input.budgetTokens));
  const actual = used === 0 ? 0 : Math.max(1, Math.min(row.estimated_credits, Math.ceil(row.estimated_credits * used / input.budgetTokens)));
  sql.exec("UPDATE goal_credit_reservations SET status='settled',settled_credits=?,updated_at=? WHERE reservation_id=? AND status='held'", actual, now, input.reservationId);
  mirror(sql, input.journalKey, now);
  return true;
}

/** Raise (never lower) the ceiling of the goal owned by `parentRunId`; clears the waiting state. */
export function raiseGoalCreditCeiling(sql: SqlLike, input: { parentRunId: string; ceiling: number; now?: number }):
  { ok: true; raised: number } | { ok: false; reason: "invalid_ceiling" | "not_found" | "not_raised" } {
  if (!Number.isSafeInteger(input.ceiling) || input.ceiling < 1 || input.ceiling > MAX_GOAL_CREDIT_CEILING) return { ok: false, reason: "invalid_ceiling" };
  const rows = sql.exec<{ journal_key: string; credit_ceiling: number | null }>(
    "SELECT journal_key,credit_ceiling FROM goal_dag_journals WHERE parent_run_id=? AND credit_ceiling IS NOT NULL", input.parentRunId).toArray();
  if (!rows.length) return { ok: false, reason: "not_found" };
  const targets = rows.filter(row => input.ceiling > (row.credit_ceiling ?? DEFAULT_GOAL_CREDIT_CEILING));
  if (!targets.length) return { ok: false, reason: "not_raised" };
  const now = input.now ?? Date.now();
  for (const row of targets) {
    sql.exec("UPDATE goal_dag_journals SET credit_ceiling=?,budget_state=NULL,budget_reason=NULL,updated_at=? WHERE journal_key=?", input.ceiling, now, row.journal_key);
  }
  return { ok: true, raised: targets.length };
}

export interface GoalBudgetResumeRecord {
  parentRunId: string; journalKey: string; objective: string; tasks: unknown[]; context: Record<string, unknown>; resumedRunId: string;
}

/** Record (or re-record after a repeat hold) that a goal waits for a ceiling raise. Always `held`. */
export function recordGoalBudgetHold(sql: SqlLike, input: {
  parentRunId: string; journalKey: string; objective: string; tasks: unknown[]; context: Record<string, unknown>; now?: number;
}): void {
  const now = input.now ?? Date.now();
  sql.exec(`INSERT INTO goal_budget_resumes(parent_run_id,journal_key,objective,tasks_json,context_json,status,created_at,updated_at)
    VALUES(?,?,?,?,?,'held',?,?)
    ON CONFLICT(parent_run_id) DO UPDATE SET journal_key=excluded.journal_key,objective=excluded.objective,tasks_json=excluded.tasks_json,
      context_json=excluded.context_json,status='held',updated_at=excluded.updated_at`,
  input.parentRunId, input.journalKey, input.objective, JSON.stringify(input.tasks), JSON.stringify(input.context), now, now);
}

export const GOAL_BUDGET_RESUME_STALE_MS = 15 * 60 * 1000;

/**
 * Claim the resume of a held goal. Returns null when the goal is not held, or another resume already
 * owns it. The read and the conditional write below run synchronously with no await between them, so
 * inside a Durable Object they are atomic: of two concurrent raises exactly one claims. A `resuming`
 * claim older than GOAL_BUDGET_RESUME_STALE_MS (an evicted DO) may be reclaimed; the journal outbox
 * keeps the re-entry idempotent.
 */
export function claimGoalBudgetResume(sql: SqlLike, parentRunId: string, newRunId: string, now = Date.now()): GoalBudgetResumeRecord | null {
  const row = sql.exec<{ parent_run_id: string; journal_key: string; objective: string; tasks_json: string; context_json: string; status: string }>(
    `SELECT parent_run_id,journal_key,objective,tasks_json,context_json,status FROM goal_budget_resumes
     WHERE parent_run_id=? AND (status='held' OR (status='resuming' AND updated_at<?))`,
    parentRunId, now - GOAL_BUDGET_RESUME_STALE_MS).toArray()[0];
  if (!row) return null;
  sql.exec("UPDATE goal_budget_resumes SET status='resuming',resumed_run_id=?,updated_at=? WHERE parent_run_id=? AND status=?", newRunId, now, parentRunId, row.status);
  try {
    return { parentRunId: row.parent_run_id, journalKey: row.journal_key, objective: row.objective, tasks: JSON.parse(row.tasks_json) as unknown[],
      context: JSON.parse(row.context_json) as Record<string, unknown>, resumedRunId: newRunId };
  } catch { return null; }
}

/** Mark the resume finished. No-op when the goal was held again meanwhile (status already `held`). */
export function finishGoalBudgetResume(sql: SqlLike, parentRunId: string, outcome: "resumed" | "held", now = Date.now()): void {
  sql.exec("UPDATE goal_budget_resumes SET status=?,updated_at=? WHERE parent_run_id=? AND status='resuming'", outcome, now, parentRunId);
}
