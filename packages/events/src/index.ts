/**
 * @naelao/events — no-code lifecycle triggers ("from projects to threads to everything in
 * Naelao"), the same admin/assistant-authored, checked-before-anything-expensive pattern as
 * customer-bot `project_rules`, generalized from "the customer said X" to "X happened
 * structurally" (a thread was created, a project was created, ...).
 *
 * Deliberately NOT a generic event bus or expression language — the condition vocabulary is
 * a small, closed set of well-known checks (spec-adjacent "no-code" ethos: an admin picks
 * from structured options, never writes a query). The ACTION is always `run_script`, so
 * anything more elaborate than the built-in conditions belongs in the fired script, not in a
 * new condition type here.
 *
 * Pure, DO-agnostic logic — storage (SpaceDO's `event_triggers` table) and dispatch (calling
 * out to the agents worker to actually run the script) live in the workers that use this.
 */

/** A well-known lifecycle event. The string union covers what this build emits; the type
 *  stays open (not a strict union) so a future emission point doesn't require a package bump
 *  before SpaceDO can start recording it. */
export type NaelaoEventType =
  | "thread.created"
  | "thread.closed"
  | "project.created"
  | (string & {});

export interface EventEnvelope {
  type: NaelaoEventType;
  space_id: string;
  /** Undefined for space-wide events (e.g. project.created has no project_id yet). */
  project_id?: string;
  thread_id?: string;
  occurred_at: number;
  payload?: Record<string, unknown>;
}

/**
 * The condition vocabulary. Each variant is a small, structured, no-code-pickable check —
 * not an expression language. `evaluateCondition` needs data it can't fetch itself (the
 * caller owns the DB), so the caller resolves whatever the condition needs into `ConditionContext`
 * before calling.
 */
export type TriggerCondition =
  | { type: "always" }
  | {
      /** Matches the builder's own example: "if a new thread is created in this project and
       *  the last-active OTHER thread has gone idle, fire against that other thread." */
      type: "last_active_thread_idle";
      idle_minutes: number;
    };

export interface ConditionContext {
  /** For 'last_active_thread_idle': the most recently updated OTHER thread in the same scope
   *  (project, or space if the trigger is space-wide), excluding the thread that fired the
   *  event. The caller is responsible for keeping this query within the trigger's own
   *  project/space — evaluateCondition never crosses that boundary because it never queries
   *  anything itself. */
  lastActiveOtherThread?: { id: string; updated_at_ms: number };
  /** Injectable for deterministic tests; defaults to Date.now(). */
  now?: number;
}

export interface ConditionResult {
  matched: boolean;
  /** The thread the action should run against, when the condition resolved one (e.g. the
   *  idle thread found by last_active_thread_idle). Absent = the action targets the thread
   *  that fired the event (event.thread_id), if any. */
  targetThreadId?: string;
}

export function evaluateCondition(condition: TriggerCondition, ctx: ConditionContext): ConditionResult {
  switch (condition.type) {
    case "always":
      return { matched: true };
    case "last_active_thread_idle": {
      const other = ctx.lastActiveOtherThread;
      if (!other) return { matched: false };
      const now = ctx.now ?? Date.now();
      const idleMs = now - other.updated_at_ms;
      const thresholdMs = condition.idle_minutes * 60_000;
      return idleMs >= thresholdMs ? { matched: true, targetThreadId: other.id } : { matched: false };
    }
  }
}

/** The action a matched trigger performs. Deliberately just `run_script` — anything a
 *  workflow/notification/webhook needs to do is reachable from a script (spec: "channels,
 *  heartbeats, notifications are scripts"), so there's no separate action-type machinery to
 *  keep in sync with the script engine's own capability surface. */
export interface TriggerAction {
  type: "run_script";
  script_name: string;
  params?: Record<string, unknown>;
}

export interface TriggerRule {
  id: string;
  space_id: string;
  /** Undefined/null = space-wide. Otherwise the trigger — and everything it can see or
   *  act on — is scoped to exactly this project; it structurally cannot reach another
   *  project's threads (see matchesEvent). */
  project_id?: string | null;
  event_type: string;
  condition: TriggerCondition;
  action: TriggerAction;
  enabled: boolean;
  priority: number;
}

/**
 * Whether `rule` applies to `event` at all — event type + project scope, NOT the condition
 * (that needs data only the caller can fetch; see evaluateCondition). A space-wide rule
 * (project_id absent) matches events in any project of that space; a project-scoped rule
 * ONLY matches events in that exact project — this is the structural boundary that keeps a
 * trigger from ever firing against a different project's threads.
 */
export function matchesEvent(rule: TriggerRule, event: EventEnvelope): boolean {
  if (!rule.enabled) return false;
  if (rule.space_id !== event.space_id) return false;
  if (rule.event_type !== event.type) return false;
  if (rule.project_id && rule.project_id !== event.project_id) return false;
  return true;
}

/** Selects and sorts the rules that structurally apply to `event`, highest priority first —
 *  the caller still needs to run evaluateCondition on each before firing. */
export function selectMatchingRules(rules: TriggerRule[], event: EventEnvelope): TriggerRule[] {
  return rules.filter((r) => matchesEvent(r, event)).sort((a, b) => b.priority - a.priority);
}

/** Merges an action's static params with parameters derived from the event/condition at fire
 *  time — the fired script always knows what triggered it and, when the condition resolved a
 *  target thread, which thread to act on. */
export function buildFireParams(
  action: TriggerAction,
  event: EventEnvelope,
  conditionResult: ConditionResult
): Record<string, unknown> {
  return {
    ...action.params,
    event_type: event.type,
    thread_id: conditionResult.targetThreadId ?? event.thread_id,
    triggered_by_thread_id: event.thread_id,
  };
}
