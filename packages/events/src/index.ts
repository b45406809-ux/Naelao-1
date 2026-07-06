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
  // §A1.17 Phase O: an agent's HITL gate opened/resolved an approval request. Unlike every
  // other event above, this ALSO drives a platform guarantee outside the builder-configurable
  // event_triggers table — NaelaoAgentDO wakes the Space Assistant directly the moment
  // approval.requested fires, rather than only when a builder happens to have wired a trigger
  // rule to it (see NaelaoAgentDO.notifyApprovalRequested). Still recorded through the ordinary
  // fireMatchingTriggers path too, so a builder CAN additionally hook their own automation.
  | "approval.requested"
  | "approval.resolved"
  // Launchpad Wallet (user-directed feature, workers/agents/src/script-engine/prebuilt/wallet.ts):
  // a business's stored-value balance, funded via Lemon Squeezy checkout, drawn down for
  // Naelao's own metered platform costs. wallet.bypass_detected fires when a business has its
  // own credential for a known third-party payment provider instead of using the wallet — the
  // signal a builder/assistant can wire a no-code trigger to (e.g. surface a soft upsell prompt).
  | "wallet.credited"
  | "wallet.debited"
  | "wallet.low_balance"
  | "wallet.bypass_detected"
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

/** §A1.17 Phase T2: an agent an @mention can resolve to — just enough to match a token against
 *  (id + display name), deliberately not the full agent_definitions row. */
export interface MentionableAgent {
  id: string;
  name: string;
}

/** A name usable in an `@token` — lowercased, spaces/punctuation collapsed to nothing, so
 *  "Support Agent" matches both `@SupportAgent` and `@support-agent`. Deliberately simple (no
 *  NLP): the roster a project allows is always small and admin-curated. */
function mentionKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Scans `text` for `@token` mentions and resolves each to an agent in `roster` by name (not a
 *  substring/NLP match — an @mention names one specific agent or it names nothing). Returns the
 *  matched agent ids, DEDUPED and in first-mention order, so `@Agent1 do X and @Agent1 also do Y`
 *  dispatches to Agent1 exactly once — the mentioned agent's own reasoning loop is responsible
 *  for handling everything it was asked, not the routing layer. An agent not in `roster` (not
 *  allowed for this project) is silently skipped, never an error — a typo'd or since-removed
 *  mention just doesn't resolve, the same way an unknown @mention on any chat platform does. */
export function parseMentions(text: string, roster: MentionableAgent[]): string[] {
  const byKey = new Map<string, string>();
  for (const agent of roster) byKey.set(mentionKey(agent.name), agent.id);

  const matched: string[] = [];
  const seen = new Set<string>();
  const tokenPattern = /@([a-zA-Z0-9][a-zA-Z0-9_-]*)/g;
  let m: RegExpExecArray | null;
  while ((m = tokenPattern.exec(text)) !== null) {
    const agentId = byKey.get(mentionKey(m[1]!));
    if (agentId && !seen.has(agentId)) {
      seen.add(agentId);
      matched.push(agentId);
    }
  }
  return matched;
}

// ── Time-based scheduling (spec §05 "cron-jobs.json — the assistant's schedule of recurring
// tasks") — the no-code equivalent of "every day at 9am, run this script." Complements the
// event-driven triggers above with a TIME-driven one. A lightweight, dependency-free 5-field
// cron matcher (minute hour day-of-month month day-of-week, UTC): '*', literal numbers,
// comma lists, ranges, and '/step' — covering every form used by this build's own templates
// ("0 8 * * *", "0 9 * * *", "0 * * * *") with headroom for anything a builder reasonably
// picks from a no-code cron-expression UI. Deliberately not a full croniter port.
//
// The spec warns against re-parsing cron expressions on every heartbeat tick ("the Worker has
// a 10ms CPU limit per heartbeat invocation... never re-parse on every heartbeat") — that
// warning is about OpenClaw's tight 5-minute loop. Our dispatcher (runScheduledJobs, agents
// worker) runs HOURLY, so a bounded per-minute scan since the job's last run is cheap (at
// most a few thousand iterations) and needs no persistent "precomputed next run" cache.

export interface ParsedCronField {
  wildcard: boolean;
  values: Set<number>;
}

function parseCronField(field: string, min: number, max: number): ParsedCronField {
  if (field === "*") return { wildcard: true, values: new Set() };
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const stepMatch = part.match(/^(\*|\d+)(?:-(\d+))?\/(\d+)$/);
    if (stepMatch) {
      const start = stepMatch[1] === "*" ? min : parseInt(stepMatch[1]!, 10);
      const end = stepMatch[2] ? parseInt(stepMatch[2], 10) : max;
      const step = parseInt(stepMatch[3]!, 10);
      if (step <= 0) throw new Error(`Cron step must be positive: "${part}"`);
      for (let v = start; v <= end; v += step) values.add(v);
      continue;
    }
    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1]!, 10);
      const end = parseInt(rangeMatch[2]!, 10);
      for (let v = start; v <= end; v++) values.add(v);
      continue;
    }
    if (!/^\d+$/.test(part)) throw new Error(`Unparseable cron field segment: "${part}"`);
    const n = parseInt(part, 10);
    if (n < min || n > max) throw new Error(`Cron field value ${n} out of range [${min}, ${max}]: "${part}"`);
    values.add(n);
  }
  return { wildcard: false, values };
}

export interface ParsedCron {
  minute: ParsedCronField;
  hour: ParsedCronField;
  dayOfMonth: ParsedCronField;
  month: ParsedCronField;
  dayOfWeek: ParsedCronField;
}

/** Parse a standard 5-field cron expression ("minute hour day-of-month month day-of-week").
 *  Throws on a malformed expression (wrong field count or unparseable/out-of-range field) so
 *  a builder gets an immediate error at creation time rather than a silently-never-firing job. */
export function parseCronExpression(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`Cron expression must have exactly 5 fields (minute hour day month weekday), got ${fields.length}: "${expr}"`);
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  return {
    minute: parseCronField(minute!, 0, 59),
    hour: parseCronField(hour!, 0, 23),
    dayOfMonth: parseCronField(dayOfMonth!, 1, 31),
    month: parseCronField(month!, 1, 12),
    dayOfWeek: parseCronField(dayOfWeek!, 0, 6),
  };
}

/** Validate a cron expression without needing the parsed result — for a create/update
 *  endpoint to reject a malformed expression up front. Returns the parse error, or null. */
export function validateCronExpression(expr: string): string | null {
  try {
    parseCronExpression(expr);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

function fieldMatches(field: ParsedCronField, value: number): boolean {
  return field.wildcard || field.values.has(value);
}

/** Whether `date` (evaluated in UTC) matches the parsed cron expression, to the minute. */
export function cronMatchesDate(cron: ParsedCron, date: Date): boolean {
  return (
    fieldMatches(cron.minute, date.getUTCMinutes()) &&
    fieldMatches(cron.hour, date.getUTCHours()) &&
    fieldMatches(cron.dayOfMonth, date.getUTCDate()) &&
    fieldMatches(cron.month, date.getUTCMonth() + 1) &&
    fieldMatches(cron.dayOfWeek, date.getUTCDay())
  );
}

/** Default lookback bound for isCronDue's per-minute scan — generous enough for any cron
 *  granularity used by this build's templates (daily) with headroom for a missed dispatch
 *  cycle or a newly-enabled long-dormant job, small enough that the scan is always trivial
 *  (at most ~11,520 iterations of simple arithmetic) even in the worst case. */
export const CRON_DUE_MAX_LOOKBACK_MS = 8 * 24 * 60 * 60 * 1000; // 8 days

/**
 * Whether a job with this cron expression is due to fire between its last run and now.
 * Scans minute-by-minute since max(lastRunAtMs, nowMs - lookback) — bounded so a
 * long-dormant job can't cause an unbounded scan. If the job was due more than once in the
 * gap (e.g. the dispatcher missed a cycle), this still returns true (fires once for the
 * gap; the caller records last_run_at so it isn't re-fired next tick, matching the spec's own
 * "update lastRun ... compute the next nextRun" model without needing a separate precomputed
 * field).
 */
export function isCronDue(
  cronExpression: string,
  lastRunAtMs: number,
  nowMs: number,
  lookbackMs: number = CRON_DUE_MAX_LOOKBACK_MS
): boolean {
  const cron = parseCronExpression(cronExpression);
  const earliestStart = nowMs - lookbackMs;
  const scanStart = Math.max(lastRunAtMs, earliestStart);
  // Scan the minute AFTER scanStart through now (inclusive) — "after" so a job whose
  // last_run_at IS an exact match-minute doesn't refire immediately on the same minute.
  const startMinute = Math.floor(scanStart / 60_000) + 1;
  const endMinute = Math.floor(nowMs / 60_000);
  for (let m = startMinute; m <= endMinute; m++) {
    if (cronMatchesDate(cron, new Date(m * 60_000))) return true;
  }
  return false;
}
