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
  | "project.possible_duplicate"
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

// ── Space collaboration (spec A1.8): "two members' assistants do not build two companies
// because they read/write the same shared space state" — project deduplication + presence.
// Coordination here is a HEADS-UP, never a block: a member can always create their project;
// the system just surfaces "this might already exist" so the space's own assistant/admin can
// notice and reconcile, exactly the "broadcasts 'this already exists'" framing in A1.8.

/** Token-normalize a project name for similarity comparison: lowercase, strip punctuation,
 *  split on whitespace, de-duplicate. Deliberately NOT semantic/embedding-based — this is an
 *  advisory heads-up check run synchronously on every project creation, not a `script.find`
 *  retrieval (which is what embeddings + Vectorize are reserved for). */
function normalizeTokens(name: string): Set<string> {
  return new Set(
    name
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean)
  );
}

/** Jaccard similarity (intersection / union of token sets) — 1.0 identical tokens, 0.0 no
 *  overlap. Two empty-token names (e.g. both blank) are treated as identical (1.0). */
export function nameSimilarity(a: string, b: string): number {
  const ta = normalizeTokens(a);
  const tb = normalizeTokens(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  let intersection = 0;
  for (const t of ta) if (tb.has(t)) intersection++;
  const union = new Set([...ta, ...tb]).size;
  return union === 0 ? 0 : intersection / union;
}

/** Below this similarity, two project names are considered unrelated — chosen so a name that
 *  is a strict superset/subset sharing at least half its tokens ("Support" vs "Support
 *  Escalations") is flagged, favoring recall (a false-positive heads-up costs nothing; a missed
 *  real duplicate is the thing this feature exists to catch). */
export const PROJECT_DUPLICATE_SIMILARITY_THRESHOLD = 0.5;

export interface ExistingProject {
  id: string;
  name: string;
}

/** Existing active projects whose name is a likely duplicate of `name`, most-similar first. */
export function findPossibleDuplicateProjects(
  name: string,
  existing: ExistingProject[],
  threshold: number = PROJECT_DUPLICATE_SIMILARITY_THRESHOLD
): ExistingProject[] {
  return existing
    .map((p) => ({ project: p, score: nameSimilarity(name, p.name) }))
    .filter(({ score }) => score >= threshold)
    .sort((a, b) => b.score - a.score)
    .map(({ project }) => project);
}

/** Default freshness window: a member is considered "active" if they heartbeat within 90s —
 *  long enough to tolerate normal polling/network jitter, short enough that presence reflects
 *  reality within one interaction cycle. */
export const PRESENCE_FRESHNESS_WINDOW_MS = 90_000;

/** Whether a presence heartbeat recorded at `lastSeenAtMs` still counts as "currently active"
 *  at `nowMs` — the freshness window a heartbeat-based (not WebSocket-based) presence system
 *  needs so a closed tab/crashed client ages out instead of appearing present forever. */
export function isPresenceFresh(lastSeenAtMs: number, nowMs: number, windowMs: number = PRESENCE_FRESHNESS_WINDOW_MS): boolean {
  return nowMs - lastSeenAtMs <= windowMs;
}
