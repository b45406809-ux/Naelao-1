// MS-36 (V-spec §6.4, MR-COM-9, MR-LIFE-2): generic managed-service subscription renewal sweep.
// Only runs behind MANAGED_SUBSCRIPTIONS_ENABLED. The engine knows nothing about providers: a subscription type supplies a
// handler whose `renew` reserves and charges before any upstream commitment is renewed (MR-COM-9 step 1). The engine owns the
// state machine active -> renewing -> active | grace -> suspended, the owner notices, and the MR-LIFE-2 release clock.
import type { AgentsEnv } from "../index.js";

const DAY_MS = 86_400_000;
export const DEFAULT_SUBSCRIPTION_GRACE_DAYS = 7;
/** MR-LIFE-2: an identity resource may leave `suspended` only 30+ days after suspension and 7+ days after the second notice. */
export const RELEASE_MIN_SUSPENDED_DAYS = 30;
export const RELEASE_WARNING_LEAD_DAYS = 7;
const SWEEP_LIMIT = 50;

export type SubscriptionRenewalState = "active" | "renewing" | "grace" | "suspended" | "cancelled";
export type SubscriptionNoticeKind = "renewal_failed_grace" | "suspended" | "release_warning";
export type ManagedSubscription = {
  id: string; tenant_id: string; resource_id: string; subscription_type: string; offering_id: string; price_version: string;
  interval: "month"; current_period_start: number; current_period_end: number; renewal_state: SubscriptionRenewalState;
  grace_days: number; cancel_at_period_end: number; upstream_commitment_json: string | null; last_renewal_operation_id: string | null;
  notify_user_id: string | null; grace_started_at: number | null; suspended_at: number | null; release_warning_at: number | null;
  created_at: number; updated_at: number;
};
export type RenewalResult =
  | { status: "renewed"; periodEnd: number; operationId?: string; billed?: boolean }
  | { status: "failed"; code: string; operationId?: string }
  | { status: "noop"; periodEnd?: number }
  | { status: "cancelled" };
export interface SubscriptionTypeHandler {
  renew(env: AgentsEnv, subscription: ManagedSubscription, now: Date): Promise<RenewalResult>;
  /** Called once when the subscription is suspended (e.g. to move the resource registry row to `suspended`). */
  onSuspended?(env: AgentsEnv, subscription: ManagedSubscription, now: Date): Promise<void>;
  /** MS-47: called after an owner reactivation has charged and made the subscription active again (e.g. to resume the resource). */
  onReactivated?(env: AgentsEnv, subscription: ManagedSubscription, now: Date): Promise<void>;
}
export type SubscriptionSweepResult = {
  checked: number; renewed: number; billed: number; held: number; suspended: number; cancelled: number; notices: number; releasable: string[];
};

export function managedSubscriptionsEnabled(env: Pick<AgentsEnv, "MANAGED_SUBSCRIPTIONS_ENABLED">) {
  return env.MANAGED_SUBSCRIPTIONS_ENABLED === "true";
}

/** Reads `grace_days` from an offering's charge components (an object or an array of components); falls back to the default. */
export async function resolveOfferingGraceDays(db: AgentsEnv["PLATFORM_DB"], offeringId: string) {
  try {
    const row = await db.prepare("SELECT charge_components_json FROM managed_service_offerings WHERE id=?").bind(offeringId).first<{ charge_components_json: string }>();
    if (!row) return DEFAULT_SUBSCRIPTION_GRACE_DAYS;
    const parsed = JSON.parse(row.charge_components_json) as unknown;
    const candidates = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of candidates) {
      const value = item && typeof item === "object" ? (item as Record<string, unknown>).grace_days : undefined;
      if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 90) return value;
    }
  } catch { /* unknown offering table or malformed JSON: default */ }
  return DEFAULT_SUBSCRIPTION_GRACE_DAYS;
}

export async function enrollManagedSubscription(db: AgentsEnv["PLATFORM_DB"], input: {
  tenantId: string; resourceId: string; subscriptionType: string; offeringId: string; priceVersion: string;
  periodStart: number; periodEnd: number; graceDays: number; notifyUserId?: string | null; upstreamCommitment?: unknown; now: number;
}) {
  const result = await db.prepare(`INSERT OR IGNORE INTO managed_service_subscriptions(
    id,tenant_id,resource_id,subscription_type,offering_id,price_version,interval,current_period_start,current_period_end,
    renewal_state,grace_days,cancel_at_period_end,upstream_commitment_json,notify_user_id,created_at,updated_at)
    VALUES(?,?,?,?,?,?,'month',?,?,'active',?,0,?,?,?,?)`)
    .bind(`sub_${input.resourceId}`, input.tenantId, input.resourceId, input.subscriptionType, input.offeringId, input.priceVersion,
      input.periodStart, input.periodEnd, input.graceDays, input.upstreamCommitment === undefined ? null : JSON.stringify(input.upstreamCommitment),
      input.notifyUserId ?? null, input.now, input.now).run();
  return result.meta.changes > 0;
}

async function recordNotice(env: AgentsEnv, sub: ManagedSubscription, kind: SubscriptionNoticeKind, nowMs: number) {
  const noticeId = `msn_${sub.id}_${kind}_${sub.current_period_start}`;
  const inserted = await env.PLATFORM_DB.prepare(`INSERT OR IGNORE INTO managed_service_subscription_notices(
    id,subscription_id,tenant_id,kind,period_start,notify_user_id,created_at) VALUES(?,?,?,?,?,?,?)`)
    .bind(noticeId, sub.id, sub.tenant_id, kind, sub.current_period_start, sub.notify_user_id, nowMs).run();
  if (!inserted.meta.changes) return 0;
  if (sub.notify_user_id) {
    const copy: Record<SubscriptionNoticeKind, [string, string]> = {
      renewal_failed_grace: ["Renewal payment failed", `We could not renew a managed subscription. It stays active for ${sub.grace_days} day(s) while we retry.`],
      suspended: ["Subscription suspended", `A managed subscription was suspended after the grace period. The resource is kept for at least ${RELEASE_MIN_SUSPENDED_DAYS} days.`],
      release_warning: ["Resource will be released", `A suspended managed resource will be released in ${RELEASE_WARNING_LEAD_DAYS} days unless you renew.`],
    };
    // Best effort: the in-app notification table may be absent where only this ledger exists. The notice row is the record.
    await env.PLATFORM_DB.prepare("INSERT OR IGNORE INTO notifications(id,tenant_id,user_id,type,title,body) VALUES(?,?,?,'billing',?,?)")
      .bind(`ntf_${noticeId}`, sub.tenant_id, sub.notify_user_id, copy[kind][0], copy[kind][1]).run().catch(() => undefined);
  }
  return 1;
}

/** MR-LIFE-2 gate: true only 30+ days after suspension AND 7+ days after the pre-release notice. */
export function isSubscriptionReleaseAllowed(sub: Pick<ManagedSubscription, "renewal_state" | "suspended_at" | "release_warning_at">, nowMs: number) {
  if (sub.renewal_state !== "suspended" || sub.suspended_at === null || sub.release_warning_at === null) return false;
  return nowMs >= sub.suspended_at + RELEASE_MIN_SUSPENDED_DAYS * DAY_MS && nowMs >= sub.release_warning_at + RELEASE_WARNING_LEAD_DAYS * DAY_MS;
}

export async function listReleasableSubscriptions(db: AgentsEnv["PLATFORM_DB"], now: Date, limit = 50) {
  const rows = await db.prepare("SELECT * FROM managed_service_subscriptions WHERE renewal_state='suspended' AND suspended_at IS NOT NULL AND release_warning_at IS NOT NULL ORDER BY suspended_at LIMIT ?")
    .bind(limit).all<ManagedSubscription>();
  return rows.results.filter(sub => isSubscriptionReleaseAllowed(sub, now.getTime()));
}

export async function sweepManagedSubscriptions(env: AgentsEnv, handlers: Record<string, SubscriptionTypeHandler>, now = new Date()): Promise<SubscriptionSweepResult> {
  const nowMs = now.getTime();
  const out: SubscriptionSweepResult = { checked: 0, renewed: 0, billed: 0, held: 0, suspended: 0, cancelled: 0, notices: 0, releasable: [] };
  const db = env.PLATFORM_DB;
  const due = await db.prepare("SELECT * FROM managed_service_subscriptions WHERE renewal_state IN ('active','renewing','grace') AND current_period_end<=? ORDER BY current_period_end LIMIT ?")
    .bind(nowMs, SWEEP_LIMIT).all<ManagedSubscription>();
  out.checked = due.results.length;
  await Promise.all(due.results.map(async sub => {
    const restoreState: SubscriptionRenewalState = sub.grace_started_at === null ? "active" : "grace";
    if (sub.cancel_at_period_end === 1) {
      const changed = await db.prepare("UPDATE managed_service_subscriptions SET renewal_state='cancelled',updated_at=? WHERE id=? AND updated_at=?").bind(nowMs, sub.id, sub.updated_at).run();
      if (changed.meta.changes) out.cancelled++;
      return;
    }
    const handler = handlers[sub.subscription_type];
    if (!handler) return;
    // Claim by compare-and-set on updated_at; a row stuck in `renewing` after a crash is picked up again (renewal is idempotent per period).
    const claim = await db.prepare("UPDATE managed_service_subscriptions SET renewal_state='renewing',updated_at=? WHERE id=? AND updated_at=? AND renewal_state IN ('active','renewing','grace')")
      .bind(nowMs, sub.id, sub.updated_at).run();
    if (!claim.meta.changes) return;
    const claimed: ManagedSubscription = { ...sub, renewal_state: "renewing", updated_at: nowMs };
    let result: RenewalResult;
    try { result = await handler.renew(env, claimed, now); }
    catch (error) {
      const code = error instanceof Error && /^[a-z][a-z0-9_:-]{1,100}$/.test(error.message) ? error.message : "managed_subscription_renewal_failed";
      result = { status: "failed", code };
    }
    if (result.status === "renewed") {
      await db.prepare(`UPDATE managed_service_subscriptions SET renewal_state='active',current_period_start=current_period_end,current_period_end=?,
        grace_started_at=NULL,suspended_at=NULL,release_warning_at=NULL,last_renewal_operation_id=COALESCE(?,last_renewal_operation_id),updated_at=?
        WHERE id=? AND renewal_state='renewing'`).bind(result.periodEnd, result.operationId ?? null, nowMs, sub.id).run();
      out.renewed++; if (result.billed !== false) out.billed++;
      return;
    }
    if (result.status === "noop") {
      await db.prepare("UPDATE managed_service_subscriptions SET renewal_state=?,current_period_end=COALESCE(?,current_period_end),updated_at=? WHERE id=? AND renewal_state='renewing'")
        .bind(restoreState, result.periodEnd ?? null, nowMs, sub.id).run();
      return;
    }
    if (result.status === "cancelled") {
      await db.prepare("UPDATE managed_service_subscriptions SET renewal_state='cancelled',updated_at=? WHERE id=? AND renewal_state='renewing'").bind(nowMs, sub.id).run();
      out.cancelled++;
      return;
    }
    // Failure (MR-COM-9 steps 2-3): grace for grace_days from the first failure, notify, then suspend.
    out.held++;
    const graceStart = sub.grace_started_at ?? nowMs;
    const op = result.operationId ?? null;
    if (nowMs >= graceStart + sub.grace_days * DAY_MS) {
      const changed = await db.prepare(`UPDATE managed_service_subscriptions SET renewal_state='suspended',grace_started_at=?,suspended_at=?,
        last_renewal_operation_id=COALESCE(?,last_renewal_operation_id),updated_at=? WHERE id=? AND renewal_state='renewing'`)
        .bind(graceStart, nowMs, op, nowMs, sub.id).run();
      if (changed.meta.changes) {
        out.suspended++;
        out.notices += await recordNotice(env, claimed, "suspended", nowMs);
        await handler.onSuspended?.(env, claimed, now).catch(() => undefined);
      }
      return;
    }
    await db.prepare("UPDATE managed_service_subscriptions SET renewal_state='grace',grace_started_at=?,last_renewal_operation_id=COALESCE(?,last_renewal_operation_id),updated_at=? WHERE id=? AND renewal_state='renewing'")
      .bind(graceStart, op, nowMs, sub.id).run();
    if (sub.grace_started_at === null) out.notices += await recordNotice(env, claimed, "renewal_failed_grace", nowMs);
  }));

  // MR-LIFE-2: second notice 7 days before the earliest release, then report which suspended resources may now be released.
  const warnAt = nowMs - (RELEASE_MIN_SUSPENDED_DAYS - RELEASE_WARNING_LEAD_DAYS) * DAY_MS;
  const toWarn = await db.prepare("SELECT * FROM managed_service_subscriptions WHERE renewal_state='suspended' AND suspended_at IS NOT NULL AND suspended_at<=? AND release_warning_at IS NULL ORDER BY suspended_at LIMIT ?")
    .bind(warnAt, SWEEP_LIMIT).all<ManagedSubscription>();
  for (const sub of toWarn.results) {
    const changed = await db.prepare("UPDATE managed_service_subscriptions SET release_warning_at=?,updated_at=? WHERE id=? AND renewal_state='suspended' AND release_warning_at IS NULL")
      .bind(nowMs, nowMs, sub.id).run();
    if (changed.meta.changes) out.notices += await recordNotice(env, sub, "release_warning", nowMs);
  }
  out.releasable = (await listReleasableSubscriptions(db, now)).map(sub => sub.id);
  return out;
}


export type ReactivationResult =
  | { status: "reactivated"; periodEnd: number; resumed: boolean }
  | { status: "failed"; code: string }
  | { status: "not_suspended" }
  | { status: "busy" }
  | { status: "cancelled" };

/**
 * MS-47 item 3: the owner's way out of `suspended`. The overdue renewal is charged first, through the same handler and the same
 * idempotent charge rows the sweep uses (so a retry never bills a period twice); only after it succeeds does the subscription become
 * active and the handler's `onReactivated` restore the resource. A failed charge leaves the subscription suspended, with its
 * original `suspended_at` (the release clock is not reset).
 */
export async function reactivateManagedSubscription(
  env: AgentsEnv, handler: SubscriptionTypeHandler, input: { subscriptionId: string; tenantId: string }, now = new Date(),
): Promise<ReactivationResult> {
  const db = env.PLATFORM_DB;
  const nowMs = now.getTime();
  const sub = await db.prepare("SELECT * FROM managed_service_subscriptions WHERE id=? AND tenant_id=? AND renewal_state='suspended'")
    .bind(input.subscriptionId, input.tenantId).first<ManagedSubscription>();
  if (!sub) return { status: "not_suspended" };
  const claim = await db.prepare("UPDATE managed_service_subscriptions SET renewal_state='renewing',updated_at=? WHERE id=? AND updated_at=? AND renewal_state='suspended'")
    .bind(nowMs, sub.id, sub.updated_at).run();
  if (!claim.meta.changes) return { status: "busy" };
  const claimed: ManagedSubscription = { ...sub, renewal_state: "renewing", updated_at: nowMs };
  const restore = () => db.prepare("UPDATE managed_service_subscriptions SET renewal_state='suspended',updated_at=? WHERE id=? AND renewal_state='renewing'").bind(nowMs, sub.id).run();
  let result: RenewalResult;
  try { result = await handler.renew(env, claimed, now); }
  catch (error) {
    result = { status: "failed", code: error instanceof Error && /^[a-z][a-z0-9_:-]{1,100}$/.test(error.message) ? error.message : "managed_subscription_renewal_failed" };
  }
  if (result.status === "failed") { await restore(); return { status: "failed", code: result.code }; }
  if (result.status === "noop") { await restore(); return { status: "busy" }; }
  if (result.status === "cancelled") {
    await db.prepare("UPDATE managed_service_subscriptions SET renewal_state='cancelled',updated_at=? WHERE id=? AND renewal_state='renewing'").bind(nowMs, sub.id).run();
    return { status: "cancelled" };
  }
  await db.prepare(`UPDATE managed_service_subscriptions SET renewal_state='active',current_period_start=current_period_end,current_period_end=?,
    grace_started_at=NULL,suspended_at=NULL,release_warning_at=NULL,last_renewal_operation_id=COALESCE(?,last_renewal_operation_id),updated_at=?
    WHERE id=? AND renewal_state='renewing'`).bind(result.periodEnd, result.operationId ?? null, nowMs, sub.id).run();
  let resumed = true;
  try { await handler.onReactivated?.(env, { ...claimed, renewal_state: "active" }, now); } catch { resumed = false; }
  return { status: "reactivated", periodEnd: result.periodEnd, resumed };
}
