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
  // Business Wallet (Whop autonomous sub-merchant model, workers/agents/src/script-engine/
  // prebuilt/business-wallet.ts + workers/billing/src/whop-wallet.ts): a DIFFERENT wallet from
  // the Naelao-cost ledger above — this is the business's OWN bank account, funded by real
  // revenue. Fired by the billing worker via POST /internal/spaces/:spaceId/events/fire so a
  // builder/assistant can wire no-code triggers to revenue milestones, payout requests, and
  // completions (e.g. "notify the owner on every payout_completed").
  | "business_wallet.revenue_received"
  | "business_wallet.payout_requested"
  | "business_wallet.payout_completed"
  // A file in a project's workspace was written or removed by an agent. This is what makes a
  // handoff between projects possible without inventing a second mechanism: one project's agent
  // records what it found (a lead, a spec, a finished build) as an ordinary file, that write
  // fires this, and a no-code rule picks it up and wakes the agent that owns the next stage.
  //
  // The file IS the handoff. Passing the work as an event payload instead would mean the
  // receiving agent's only record of the job is a message it has to remember; a file is state
  // both sides can re-read, and survives the run that produced it.
  //
  // Payload: { path, operation: "write" | "delete", agent_id }.
  | "workspace.file_changed"
  // Phase 3 item 27/28 — a cron/scheduled-job's own CONFIG changed, not just what it produced
  // when it fired. .disabled already existed (agents worker's recordScheduledJobFailure,
  // auto-disable after too many consecutive failures); .created/.updated/.enabled/.paused/
  // .deleted are the CRUD counterpart, fired from the spaces worker's own /scheduled-jobs
  // routes the moment a business's own admin creates/edits/toggles/removes one — so a no-code
  // trigger can react to a schedule change exactly like it already reacts to thread.created.
  // Payload: { scheduled_job_id, ...op-specific extras (e.g. name/cron_expression on .created) }.
  | "scheduled_job.created"
  | "scheduled_job.updated"
  | "scheduled_job.enabled"
  | "scheduled_job.paused"
  | "scheduled_job.deleted"
  | "scheduled_job.disabled"
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

// ── §A1 Harness Excellence Phase HX2: implicit signals (Raindrop-style "detect frustration/
// forgetting from language, not just from error codes") ─────────────────────────────────────
// Deliberately regex/keyword-based, not an LLM classifier (the plan's own explicit scoping:
// "heuristics first; LLM tier later behind eval budget") — cheap enough to run on every
// incoming goal with zero added LLM cost. "Regeneration" (repeated identical goal / rapid
// retry) is intentionally NOT detected here — it's already computed as an EXPLICIT signal from
// real run-history timestamps (agent_activity_log), and duplicating it as a text heuristic
// here would just be a noisier version of a number the platform already has exactly.

export interface ImplicitSignal {
  signal_type: "user_frustration" | "agent_forgot";
  detail: string;
}

const FRUSTRATION_PATTERNS: RegExp[] = [
  /\bthat'?s (wrong|not right|not what i (asked|meant|wanted))\b/i,
  /\bstill (wrong|broken|not working|doesn'?t work)\b/i,
  /\bnot what i (asked|meant|wanted)\b/i,
  /\b(try again|do it (again|properly|right)|this is (wrong|useless|frustrating))\b/i,
  /\b(ugh|come on|seriously)\b.{0,20}\b(wrong|broken|not working)\b/i,
];

const AGENT_FORGOT_PATTERNS: RegExp[] = [
  /\bi (already|just) (told|said|asked|mentioned)\b/i,
  /\b(as i said|like i said|we (already )?discussed this) (before|earlier|already)?\b/i,
  /\byou (forgot|keep forgetting)\b/i,
  /\bwhy (are you|do you) asking (that|this) again\b/i,
];

/** Scans a single message's text (typically an agent run's `goal`) for cheap, regex-detectable
 *  signs of user frustration or the agent appearing to have forgotten prior context. Returns
 *  every distinct signal type that matched (never more than one row per type per call) — a
 *  message can carry both, e.g. "that's wrong, I already told you the deadline." Pure function,
 *  no I/O: the caller decides whether/where to persist a match (agent_signal_events). */
export function detectImplicitSignals(text: string): ImplicitSignal[] {
  const signals: ImplicitSignal[] = [];
  if (!text) return signals;

  for (const pattern of FRUSTRATION_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      signals.push({ signal_type: "user_frustration", detail: match[0].slice(0, 200) });
      break;
    }
  }
  for (const pattern of AGENT_FORGOT_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      signals.push({ signal_type: "agent_forgot", detail: match[0].slice(0, 200) });
      break;
    }
  }
  return signals;
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
  // A non-finite lastRunAt must not silently disable the job.
  //
  // Math.max(NaN, x) is NaN, which makes startMinute NaN, which makes the scan loop below never
  // execute, which returns false — forever, and indistinguishably from "not due yet". That is
  // exactly what happened in production: a caller passed NaN for every never-run job, so no
  // newly-seeded cron on the platform could ever fire. Falling back to the lookback window means
  // a bad timestamp costs at most one extra evaluation, instead of costing the schedule entirely.
  const anchor = Number.isFinite(lastRunAtMs) ? lastRunAtMs : earliestStart;
  const scanStart = Math.max(anchor, earliestStart);
  // Scan the minute AFTER scanStart through now (inclusive) — "after" so a job whose
  // last_run_at IS an exact match-minute doesn't refire immediately on the same minute.
  const startMinute = Math.floor(scanStart / 60_000) + 1;
  const endMinute = Math.floor(nowMs / 60_000);
  for (let m = startMinute; m <= endMinute; m++) {
    if (cronMatchesDate(cron, new Date(m * 60_000))) return true;
  }
  return false;
}

/** Bound for computeNextRun's forward scan — mirrors CRON_DUE_MAX_LOOKBACK_MS's own bound but
 *  looking forward instead of back. A cron combination that can never match (e.g. "day 31" of a
 *  month field restricted to 30-day months) must not hang the scan forever. */
export const CRON_NEXT_RUN_MAX_LOOKAHEAD_MS = 366 * 24 * 60 * 60 * 1000; // a bit over a year

/**
 * Phase 3 item 27/28 — the next UTC minute (epoch ms) at or after `fromMs` that a job with this
 * cron expression would fire, for a Crons editing UI's "next run" display. Mirrors isCronDue's
 * own minute-scan approach and its "strictly AFTER fromMs" rule (so passing the job's own
 * last_run_at, or "now", never reports a match on that exact minute as still upcoming) — the two
 * functions are deliberately kept in sync rather than sharing one generic scanner, since isCronDue
 * scans backward from a bounded window and this scans forward from one; forcing them through a
 * single abstraction would obscure both directions for no real benefit.
 *
 * Returns null if no match is found within the lookahead bound — a genuinely unsatisfiable
 * expression (Feb 30) rather than a bug in the scan itself.
 */
export function computeNextRun(
  cronExpression: string,
  fromMs: number,
  lookaheadMs: number = CRON_NEXT_RUN_MAX_LOOKAHEAD_MS
): number | null {
  const cron = parseCronExpression(cronExpression);
  const startMinute = Math.floor(fromMs / 60_000) + 1;
  const endMinute = Math.floor((fromMs + lookaheadMs) / 60_000);
  for (let m = startMinute; m <= endMinute; m++) {
    if (cronMatchesDate(cron, new Date(m * 60_000))) return m * 60_000;
  }
  return null;
}

// ── Business Feature Projects registry (F-34/F-41) ──────────────────────────────
export * from "./business-feature-kinds.js";

// ── Failure classification — what stopped a run, and can anything be done about it ──
export * from "./failure-classification.js";
