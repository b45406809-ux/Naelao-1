// MS-39 / V-spec MR-COM-10, MR-COM-11: composed spending-limit admission for
// POST /internal/managed-services/credits/reserve (behind MANAGED_LIMITS_COMPOSED_ENABLED).
//
// The effective limit of a reservation is the minimum of every applicable limit. Limits owned by Billing are enforced in
// the same single conditional INSERT that creates the reservation (plan allowance and mandate period already were; this
// module adds the externally owned scopes). Limits that live in other workers or Durable Objects (per-install cap in
// Spaces, per-goal ceiling in Agents, Project spend cap in Spaces, AgentPort grant `maxSpend`) cannot be read from
// Billing. The CALLER passes each in as `headroom_credits`: the cap minus everything already reserved or settled for
// that scope OUTSIDE Billing's managed-service reservations. Billing then subtracts its own active reservations that
// carry the same {kind, scope_key} inside the INSERT, so two parallel Billing reserves cannot jointly exceed the
// headroom. No cross-worker two-phase protocol exists or is attempted: the caller's headroom is a snapshot, and a caller
// that also reserves in its own scope must serialise those writes itself (the DO that owns the scope already does).

export const EXTERNAL_LIMIT_KINDS = ["per_install", "per_goal", "project_spend", "grant_max_spend"] as const;
export type ExternalLimitKind = (typeof EXTERNAL_LIMIT_KINDS)[number];
export type LimitKind =
  | "plan_allowance" | "mandate_per_operation" | "mandate_period" | "entitlement_per_operation" | ExternalLimitKind;

export interface ExternalLimit { kind: ExternalLimitKind; scope_key: string; headroom_credits: number }

export interface BindingLimit { limit_kind: LimitKind; remaining_credits: number }

const SCOPE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/;

export function parseExternalLimits(raw: unknown): { ok: true; limits: ExternalLimit[] } | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true, limits: [] };
  if (!Array.isArray(raw) || raw.length > EXTERNAL_LIMIT_KINDS.length) return { ok: false };
  const seen = new Set<string>();
  const limits: ExternalLimit[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return { ok: false };
    const { kind, scope_key, headroom_credits } = item as Record<string, unknown>;
    if (typeof kind !== "string" || !(EXTERNAL_LIMIT_KINDS as readonly string[]).includes(kind) || seen.has(kind)) return { ok: false };
    if (typeof scope_key !== "string" || !SCOPE_KEY.test(scope_key)) return { ok: false };
    if (typeof headroom_credits !== "number" || !Number.isSafeInteger(headroom_credits) || headroom_credits < 0 || headroom_credits > 10_000_000) return { ok: false };
    seen.add(kind);
    limits.push({ kind: kind as ExternalLimitKind, scope_key, headroom_credits });
  }
  return { ok: true, limits };
}

/** The smallest remaining headroom among applicable limits (first wins a tie, in the given order). Pure. */
export function effectiveLimit(candidates: Array<{ kind: LimitKind; remaining: number | null }>): { kind: LimitKind; remaining: number } | null {
  let best: { kind: LimitKind; remaining: number } | null = null;
  for (const c of candidates) {
    if (c.remaining === null) continue;
    if (!best || c.remaining < best.remaining) best = { kind: c.kind, remaining: c.remaining };
  }
  return best;
}

const ACTIVE = `(r.status IN ('settled','uncertain') OR (r.status='held' AND (r.expires_at IS NULL OR julianday(r.expires_at)>julianday('now'))))`;
const SPENT = `CASE WHEN r.status='settled' THEN COALESCE(r.settled_credits,r.credits) ELSE r.credits END`;

function scopeSpendSql(excludeOperation: boolean): string {
  return `(SELECT COALESCE(SUM(${SPENT}),0) FROM managed_service_credit_reservations r, json_each(r.composed_limits_json) j
    WHERE r.org_id=? AND r.composed_limits_json IS NOT NULL ${excludeOperation ? "AND r.operation_id<>?" : ""}
      AND json_extract(j.value,'$.kind')=? AND json_extract(j.value,'$.scope_key')=? AND ${ACTIVE})`;
}

/** SQL predicates (each starting with AND) and bindings, appended to the reservation INSERT / renewal UPDATE WHERE clause. */
export function externalLimitAdmission(limits: ExternalLimit[], orgId: string, credits: number, excludeOperationId?: string): { sql: string; binds: unknown[] } {
  let sql = ""; const binds: unknown[] = [];
  for (const l of limits) {
    sql += ` AND ${scopeSpendSql(excludeOperationId !== undefined)} + ? <= ?`;
    binds.push(orgId, ...(excludeOperationId !== undefined ? [excludeOperationId] : []), l.kind, l.scope_key, credits, l.headroom_credits);
  }
  return { sql, binds };
}

export interface BindingDiagnosisInput {
  db: D1Database;
  orgId: string;
  credits: number;
  excludeOperationId?: string;
  mandate: { id: string; agentport_agent_id: string | null; max_credits_per_period: number | null; period_days: number };
  planLimit: number;
  external: ExternalLimit[];
}

/**
 * After the admission INSERT changed nothing, find which limit bound: the applicable limit with the smallest remaining
 * headroom that cannot fit `credits`. Read-only; the INSERT already decided the refusal atomically.
 */
export async function diagnoseBindingLimit(i: BindingDiagnosisInput): Promise<BindingLimit | null> {
  const candidates: Array<{ kind: LimitKind; remaining: number | null }> = [];
  const ex = i.excludeOperationId;
  const plan = await i.db.prepare(`SELECT
      (SELECT COALESCE(SUM(quantity),0) FROM usage_events WHERE org_id=? AND event_type='infra_credits' AND recorded_at>=datetime('now','start of month') AND (schema_version<2 OR payer_kind IN ('plan_quota','platform','unknown'))) +
      (SELECT COALESCE(SUM(credits),0) FROM workflow_budget_reservations WHERE org_id=? AND status='held' AND julianday(expires_at)>julianday('now')) +
      (SELECT COALESCE(SUM(credits),0) FROM managed_service_credit_reservations WHERE org_id=? ${ex !== undefined ? "AND operation_id<>?" : ""} AND (status='uncertain' OR (status='held' AND (expires_at IS NULL OR julianday(expires_at)>julianday('now'))))) AS used`)
    .bind(i.orgId, i.orgId, i.orgId, ...(ex !== undefined ? [ex] : [])).first<{ used: number }>();
  candidates.push({ kind: "plan_allowance", remaining: i.planLimit - (plan?.used ?? 0) });
  if (i.mandate.max_credits_per_period !== null) {
    const spend = await i.db.prepare(`SELECT COALESCE(SUM(${SPENT}),0) AS credits FROM managed_service_credit_reservations r
      WHERE r.org_id=? AND r.agentport_agent_id IS ? AND r.payer_mandate_id=? ${ex !== undefined ? "AND r.operation_id<>?" : ""}
        AND r.created_at>=datetime('now','-' || ? || ' days') AND ${ACTIVE}`)
      .bind(i.orgId, i.mandate.agentport_agent_id, i.mandate.id, ...(ex !== undefined ? [ex] : []), i.mandate.period_days).first<{ credits: number }>();
    candidates.push({ kind: "mandate_period", remaining: i.mandate.max_credits_per_period - (spend?.credits ?? 0) });
  }
  for (const l of i.external) {
    const row = await i.db.prepare(`SELECT ${scopeSpendSql(ex !== undefined)} AS credits`)
      .bind(i.orgId, ...(ex !== undefined ? [ex] : []), l.kind, l.scope_key).first<{ credits: number }>();
    candidates.push({ kind: l.kind, remaining: l.headroom_credits - (row?.credits ?? 0) });
  }
  const binding = effectiveLimit(candidates.filter((c) => c.remaining !== null && c.remaining < i.credits));
  return binding ? { limit_kind: binding.kind, remaining_credits: Math.max(0, binding.remaining) } : null;
}

/** Maximum chunk for incremental reservation of long-running usage (MR-COM-11). */
export const CHUNK_MAX_SECONDS = 300;
export const CHUNK_MAX_CREDITS = 100;

export interface ChunkedReservationInput {
  /** Total credits the caller would like to reserve in all (0 = unbounded, until refused or `stop` returns true). */
  maxTotalCredits: number;
  /** Credits per second of usage, used to size a chunk: min(CHUNK_MAX_SECONDS * rate, CHUNK_MAX_CREDITS). */
  creditsPerSecond: number;
  /** Reserve one chunk. Returns true when admitted, false when refused (budget_exceeded or any refusal). Must be idempotent per chunkIndex. */
  reserveChunk: (chunk: { index: number; credits: number; seconds: number }) => Promise<boolean>;
  /** Called after each admitted chunk; return true when the usage is finished. */
  usageFinished?: (admitted: { index: number; credits: number; seconds: number }) => Promise<boolean> | boolean;
}

export interface ChunkedReservationResult {
  chunks: Array<{ index: number; credits: number; seconds: number }>;
  reservedCredits: number;
  /** "refused": the next chunk could not be reserved, so the session must terminate; "finished"/"cap_reached" otherwise. */
  stoppedBy: "refused" | "finished" | "cap_reached";
}

/** Size of one chunk: at most 5 minutes and at most 100 credits, whichever is smaller, and at least 1 credit. */
export function chunkSize(creditsPerSecond: number, remainingCredits: number | null): { credits: number; seconds: number } {
  if (!(creditsPerSecond > 0) || !Number.isFinite(creditsPerSecond)) throw new Error("credits_per_second_invalid");
  let seconds = CHUNK_MAX_SECONDS;
  let credits = Math.ceil(seconds * creditsPerSecond);
  if (credits > CHUNK_MAX_CREDITS) { credits = CHUNK_MAX_CREDITS; seconds = Math.min(CHUNK_MAX_SECONDS, Math.floor(credits / creditsPerSecond)); }
  if (remainingCredits !== null && credits > remainingCredits) { credits = remainingCredits; seconds = Math.min(seconds, Math.floor(credits / creditsPerSecond)); }
  return { credits: Math.max(1, credits), seconds: Math.max(1, seconds) };
}

/**
 * Reserve long-running usage chunk by chunk. The loop ends at the first refused chunk (the caller terminates the
 * session), when the caller reports the usage finished, or at maxTotalCredits. Each chunk goes through the same atomic
 * admission as any reservation, so every limit in the composition applies to every chunk.
 */
export async function reserveIncrementally(input: ChunkedReservationInput, maxChunks = 1000): Promise<ChunkedReservationResult> {
  const chunks: ChunkedReservationResult["chunks"] = [];
  let reserved = 0;
  for (let index = 0; index < maxChunks; index++) {
    const remaining = input.maxTotalCredits > 0 ? input.maxTotalCredits - reserved : null;
    if (remaining !== null && remaining < 1) return { chunks, reservedCredits: reserved, stoppedBy: "cap_reached" };
    const size = chunkSize(input.creditsPerSecond, remaining);
    const chunk = { index, ...size };
    if (!(await input.reserveChunk(chunk))) return { chunks, reservedCredits: reserved, stoppedBy: "refused" };
    chunks.push(chunk); reserved += chunk.credits;
    if (input.usageFinished && (await input.usageFinished(chunk))) return { chunks, reservedCredits: reserved, stoppedBy: "finished" };
  }
  return { chunks, reservedCredits: reserved, stoppedBy: "cap_reached" };
}
