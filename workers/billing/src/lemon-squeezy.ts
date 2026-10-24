/**
 * Lemon Squeezy webhook handler (spec Appendix H / CLAUDE.md #9).
 *
 * On payment.success / subscription.created: wake the Space Assistant agent
 * via POST /agents/{agentId}/script/run so it can fulfil the order, send
 * welcome emails, provision entitlements, etc.
 *
 * Event dispatch logic:
 *   payment.success (order_created / subscription_payment_success / order_refunded→refund.issued)
 *     → fire "order_completed" goal on the space's default agent
 *   subscription.created / subscription.updated
 *     → fire "subscription_changed" goal
 *   subscription.cancelled / subscription.paused
 *     → fire "subscription_cancelled" goal
 *   payment.failed
 *     → fire "payment_failed" goal (dunning workflow)
 */

import { LemonSqueezyProvider } from "@naelao/billing-core";
import type { NormalizedBillingEvent } from "@naelao/billing-core";
import { readBoundedRequestText } from "@naelao/http";
import { invalidateQuotaCache } from "./quota.js";
import { settleTemplateSubscriptionPayment } from "./settlement.js";
import { settleMarketplaceLicenseEvent } from "./marketplace-licenses.js";

function requiredMetadataString(metadata: Record<string, unknown>, key: string, context: string): string {
  const value = metadata[key];
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 256) {
    throw new Error(`${context} webhook is missing valid ${key} metadata`);
  }
  return value.trim();
}

export interface LemonSqueezyEnv {
  LEMON_SQUEEZY_WEBHOOK_SECRET?: string;
  LEMON_SQUEEZY_API_KEY?: string;
  LEMON_SQUEEZY_STORE_ID?: string;
  PLATFORM_DB: D1Database;
  PLATFORM_SECRET: string;
  /** Optional — platform-plan upserts invalidate the org's quota cache so a paid upgrade takes
   *  effect immediately instead of after the KV TTL. Degrades to a no-op when unbound. */
  QUOTA_CACHE?: KVNamespace;
}

function mapSubscriptionStatus(event: NormalizedBillingEvent): string {
  if (event.type === "payment.failed") return "past_due";
  switch (event.type) {
    case "subscription.cancelled": return "cancelled";
    case "subscription.paused": return "paused";
    case "subscription.resumed": return "active";
    case "subscription.expired": return "expired";
    default: break;
  }
  switch (event.providerStatus) {
    case "active":
    case "on_trial": return "active";
    case "past_due":
    case "unpaid": return "past_due";
    case "paused": return "paused";
    case "cancelled": return "cancelled";
    case "expired": return "expired";
    default: return "active";
  }
}

/**
 * Vendor cutover (Lemon Squeezy is the ONLY billing provider): the BUILDER's own platform plan
 * (growth/business), previously the last Stripe-backed path. Fires on every subscription.* /
 * payment.success event whose checkout metadata carries kind="platform_plan" (set by
 * POST /billing/checkout). This is an ORG-level event — there is no space to resolve and no
 * agent to wake, so handleLemonSqueezyWebhook branches here BEFORE its space-dispatch machinery.
 *
 * Writes BOTH plan_tier locations on purpose:
 *   - `subscriptions` (org-unique row) — what GET /billing/subscription displays;
 *   - `orgs.plan_tier` — what EntitlementsChecker.getTenantTier actually enforces platform-wide
 *     (free-tier template gating, space/seat quotas). The old Stripe webhook only ever wrote
 *     `subscriptions`, so a paid upgrade never actually unlocked entitlements — a real,
 *     previously-undetected bug this cutover closes, not just relocates.
 *
 * `event.provider` picks WHICH id-columns get written (ls_* vs whop_*, migration 0067) — Whop was
 * added as a second platform provider tried before LS (AUDIT_TODO.md AI-7); the other provider's
 * columns are left untouched (COALESCE), so an org that switched provider keeps its historical id
 * from the one it's no longer on rather than clobbering it with NULL.
 */
export async function recordPlatformPlanSubscription(
  event: NormalizedBillingEvent,
  env: LemonSqueezyEnv
): Promise<boolean> {
  const custom = (event.metadata ?? {}) as Record<string, unknown>;
  if (custom["kind"] !== "platform_plan") return false;
  const orgId = requiredMetadataString(custom, "org_id", "platform plan");
  const plan = requiredMetadataString(custom, "plan", "platform plan");
  if (plan !== "growth" && plan !== "business") throw new Error("platform plan webhook contains an unsupported plan");

  // A failed renewal may mark an existing subscription delinquent, but it must never create a
  // paid org tier by itself. Refund events are acknowledged without changing entitlement state;
  // the subscription lifecycle event is the source of truth for access removal.
  if (event.type === "payment.failed") {
    // Payment notifications can arrive after a user has replaced their subscription. Only let a
    // failure for the subscription currently recorded on the org update its state; a failure for
    // an older subscription (or an initial payment with no row yet) must not downgrade new access.
    if (!event.subscriptionId) return true;
    const subscriptionColumn = event.provider === "whop" ? "whop_subscription_id" : "ls_subscription_id";
    await env.PLATFORM_DB.prepare(
      `UPDATE subscriptions SET status = 'past_due', provider_event_at = COALESCE(?, provider_event_at),
         billing_provider = COALESCE(billing_provider, ?), updated_at = datetime('now')
       WHERE org_id = ? AND plan_tier = ? AND ${subscriptionColumn} = ?
         AND (billing_provider IS NULL OR billing_provider = ?)
         AND ((? IS NULL AND provider_event_at IS NULL) OR
              (? IS NOT NULL AND (provider_event_at IS NULL OR ? > provider_event_at)))`
    ).bind(event.providerUpdatedAt ?? null, event.provider, orgId, plan, event.subscriptionId,
      event.provider, event.providerUpdatedAt ?? null, event.providerUpdatedAt ?? null,
      event.providerUpdatedAt ?? null).run();
    return true;
  }
  if (event.type === "refund.issued") return true;
  if (event.type !== "payment.success" && !event.type.startsWith("subscription.")) return true;

  const status = mapSubscriptionStatus(event);
  // Access policy: cancelled keeps the paid tier until LS sends subscription.expired at period
  // end (LS's own grace semantics); expired drops the org back to free. past_due keeps the tier
  // (dunning may still recover the payment) but surfaces the status.
  const planTier = status === "expired" ? "free" : plan;
  const isWhop = event.provider === "whop";
  const subscriptionColumn = isWhop ? "whop_subscription_id" : "ls_subscription_id";

  const write = await env.PLATFORM_DB.prepare(
    `INSERT INTO subscriptions
       (id, org_id, plan_tier, status, ls_customer_id, ls_subscription_id,
        whop_customer_id, whop_subscription_id, current_period_end, billing_provider, provider_event_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(org_id) DO UPDATE SET
       plan_tier          = excluded.plan_tier,
       status             = excluded.status,
       ls_customer_id       = COALESCE(excluded.ls_customer_id, subscriptions.ls_customer_id),
       ls_subscription_id   = COALESCE(excluded.ls_subscription_id, subscriptions.ls_subscription_id),
       whop_customer_id     = COALESCE(excluded.whop_customer_id, subscriptions.whop_customer_id),
       whop_subscription_id = COALESCE(excluded.whop_subscription_id, subscriptions.whop_subscription_id),
       current_period_end = excluded.current_period_end,
       billing_provider   = excluded.billing_provider,
       provider_event_at  = excluded.provider_event_at,
       updated_at         = datetime('now')
     WHERE (subscriptions.billing_provider = excluded.billing_provider OR subscriptions.billing_provider IS NULL)
       AND (
         (subscriptions.${subscriptionColumn} = excluded.${subscriptionColumn})
         OR (? = 'subscription.created' AND excluded.provider_event_at IS NOT NULL
             AND (subscriptions.${subscriptionColumn} IS NULL OR
                  (subscriptions.provider_event_at IS NOT NULL
                   AND excluded.provider_event_at > subscriptions.provider_event_at)))
       )
       AND ((excluded.provider_event_at IS NULL AND subscriptions.provider_event_at IS NULL)
            OR (excluded.provider_event_at IS NOT NULL
                AND (subscriptions.provider_event_at IS NULL OR excluded.provider_event_at > subscriptions.provider_event_at)))`
  ).bind(
    crypto.randomUUID(), orgId, planTier, status,
    isWhop ? null : (event.customerId ?? null), isWhop ? null : (event.subscriptionId ?? null),
    isWhop ? (event.customerId ?? null) : null, isWhop ? (event.subscriptionId ?? null) : null,
    event.currentPeriodEnd ?? null, event.provider, event.providerUpdatedAt ?? null, event.type
  ).run();

  // A stale or unversioned event for a replaced subscription is acknowledged but cannot rewrite
  // the active entitlement. Do not mirror its attempted tier into the organization row.
  if (write.meta.changes === 0) {
    console.warn(`[billing/${event.provider}] Ignored stale or unversioned platform lifecycle event org=${orgId} event=${event.type}`);
    return true;
  }

  await env.PLATFORM_DB.prepare(
    "UPDATE orgs SET plan_tier = ? WHERE id = ?"
  ).bind(planTier, orgId).run();

  if (env.QUOTA_CACHE) await invalidateQuotaCache(env.QUOTA_CACHE, orgId);
  console.log(`[billing/ls] Platform plan ${status}: org=${orgId} tier=${planTier}`);
  return true;
}

/** Apply verified payment and subscription lifecycle updates for a marketplace template. */
async function settleNativeTemplateRoyalty(event: NormalizedBillingEvent, env: LemonSqueezyEnv): Promise<boolean> {
  if (event.type !== "payment.success") return false;
  const mapped = event.subscriptionId
    ? (await env.PLATFORM_DB.prepare("SELECT id FROM template_subscriptions WHERE provider_subscription_id = ? AND space_id = ?")
      .bind(event.subscriptionId, event.spaceId).first<{ id: string }>())?.id
    : undefined;
  if (event.metadata?.kind !== "template_subscription" && !mapped) return false;
  const subscriptionId = event.metadata?.template_subscription_id ?? mapped;
  if (!subscriptionId || !event.providerEventId || !Number.isSafeInteger(event.amountCents) || event.amountCents <= 0) {
    throw new Error("captured template payment is missing an id, subscription, or positive amount");
  }
  const subscription = await env.PLATFORM_DB.prepare("SELECT id FROM template_subscriptions WHERE id = ? AND space_id = ? AND status IN ('active','paused')")
    .bind(subscriptionId, event.spaceId).first<{ id: string }>();
  if (!subscription) throw new Error("captured template payment has no active matching subscription");
  await settleTemplateSubscriptionPayment(env.PLATFORM_DB, event.spaceId, event.amountCents, event.providerEventId, event.subscriptionId, subscriptionId);
  return true;
}

async function syncNativeTemplateSubscriptionStatus(event: NormalizedBillingEvent, env: LemonSqueezyEnv): Promise<boolean> {
  if (!event.type.startsWith("subscription.")) return false;
  const id = event.metadata?.kind === "template_subscription" ? event.metadata.template_subscription_id : undefined;
  if (!id && !event.subscriptionId) return false;
  const status = event.type === "subscription.cancelled" || event.type === "subscription.expired" || event.providerStatus === "cancelled" || event.providerStatus === "expired"
    ? "cancelled"
    : event.type === "subscription.paused" || event.providerStatus === "paused" || event.providerStatus === "past_due" || event.providerStatus === "unpaid"
      ? "paused"
      : event.type === "subscription.resumed" || event.type === "subscription.updated" ? "active" : "paused";
  const result = await env.PLATFORM_DB.prepare(`UPDATE template_subscriptions SET
    status = CASE WHEN paid_cycles_total > 0 THEN ? WHEN ? = 'cancelled' THEN 'cancelled' ELSE 'paused' END,
    provider_subscription_id = COALESCE(provider_subscription_id, ?), updated_at = datetime('now')
    WHERE space_id = ? AND ((? IS NOT NULL AND id = ?) OR (? IS NOT NULL AND provider_subscription_id = ?))`)
    .bind(status, status, event.subscriptionId, event.spaceId, id ?? null, id ?? null, event.subscriptionId, event.subscriptionId).run();
  return result.meta.changes > 0;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * S0.3: the top-level idempotency gate — checked BEFORE any side effect (reseller ledger, order
 * recording, business subscription, credit-pack grant, wakeAgent). Lemon Squeezy retries on any
 * non-2xx response or timeout, which previously re-ran the ENTIRE handler on every retry; only
 * launchpad_orders had its own (separately keyed) idempotency, so a plain retry of e.g. a
 * subscription.updated event re-woke the agent every time. INSERT OR IGNORE on the
 * (provider, event_id) primary key: `event_id` is a signed-body fingerprint at webhook ingress,
 * not Lemon Squeezy's resource ID, because a resource can emit many distinct lifecycle events.
 * Exact re-deliveries map to the same fingerprint; changed payloads for the same resource remain
 * processable while money effects retain their separate resource/payment idempotency keys.
 */
export async function markEventProcessedOnce(
  provider: string,
  eventId: string,
  eventType: string,
  db: D1Database
): Promise<boolean> {
  const result = await db.prepare(
    `INSERT OR IGNORE INTO processed_webhook_events (provider, event_id, event_type) VALUES (?, ?, ?)`
  ).bind(provider, eventId, eventType).run();
  return (result.meta?.changes ?? 0) > 0;
}

/**
 * Reverse markEventProcessedOnce so a later delivery of the same event is reprocessed. Called when
 * a money side-effect failed TRANSIENTLY (see handleLemonSqueezyWebhook): the event was reserved to
 * dedupe concurrent deliveries, but since it didn't fully succeed we release the reservation and
 * return a non-200 so Lemon Squeezy retries. Every money handler is idempotent, so reprocessing is
 * safe — the parts that succeeded are no-ops, the failed part completes.
 */
export async function unmarkEventProcessed(provider: string, eventId: string, db: D1Database): Promise<void> {
  try {
    await db.prepare(`DELETE FROM processed_webhook_events WHERE provider = ? AND event_id = ?`).bind(provider, eventId).run();
  } catch { /* best-effort — a failed delete just means the retry is deduped, no worse than today */ }
}

/**
 * F-21 / F-28 (money leak): checkout kinds that must NEVER accrue a reseller/referral builder
 * margin. The decided revenue model (ARCH-REVENUE) keeps 100% of subscription-class revenue for
 * Naelao and treats a wallet top-up as the business's own capital (passthrough), so attributing a
 * builder cut on any of them creates obligations exceeding money-in — WORST case a builder
 * colluding with a child business loops wallet_topups to farm payout balance. revenue_cut_surcharge
 * is excluded too (F-28): the surcharge IS the mechanism that already collects the cut, so running
 * it through attribution as well double-pays a referral-mode builder for the same revenue. Genuine
 * end-customer revenue — product sales (product_id, no kind) and seats — still attributes normally.
 */
export async function handleLemonSqueezyWebhook(
  request: Request,
  env: LemonSqueezyEnv
): Promise<Response> {
  const provider = new LemonSqueezyProvider({
    ...(env.LEMON_SQUEEZY_API_KEY ? { LEMON_SQUEEZY_API_KEY: env.LEMON_SQUEEZY_API_KEY } : {}),
    ...(env.LEMON_SQUEEZY_WEBHOOK_SECRET ? { LEMON_SQUEEZY_WEBHOOK_SECRET: env.LEMON_SQUEEZY_WEBHOOK_SECRET } : {}),
    ...(env.LEMON_SQUEEZY_STORE_ID ? { LEMON_SQUEEZY_STORE_ID: env.LEMON_SQUEEZY_STORE_ID } : {}),
  });

  let rawBody: string;
  try { rawBody = await readBoundedRequestText(request, 1024 * 1024); }
  catch { return Response.json({ error: "payload_too_large" }, { status: 413 }); }

  // 1. Verify HMAC signature
  const valid = await provider.verifyWebhook(rawBody, request.headers);
  if (!valid) {
    console.warn("[billing/ls] Webhook signature verification failed");
    return Response.json({ error: "invalid_signature" }, { status: 401 });
  }

  // 2. Parse + normalize event
  let event: NormalizedBillingEvent;
  try {
    event = provider.parseWebhookEvent(rawBody);
  } catch (err) {
    console.warn("[billing/ls] Unrecognised event:", (err as Error).message);
    // Return 200 so Lemon Squeezy doesn't retry unknown events
    return Response.json({ ok: true, skipped: true });
  }

  // 2b. Platform-plan events (the builder's own growth/business subscription) are ORG-level:
  // there is no space to resolve and no agent to wake, so they branch off here — before the
  // space-dispatch machinery — with their own exactly-once gate and retry-release, mirroring
  // the main path's semantics below.
  const topCustom = (event.metadata ?? {}) as Record<string, unknown>;
  if (event.type === "refund.issued" && !event.providerEventId) {
    return Response.json({ error: "missing_provider_event_id" }, { status: 500 });
  }
  if (topCustom["kind"] === "template_subscription" &&
      (typeof topCustom["template_subscription_id"] !== "string" || !topCustom["template_subscription_id"].trim()) &&
      !event.subscriptionId) {
    return Response.json({ error: "missing_template_subscription_id" }, { status: 500 });
  }
  if (topCustom["kind"] === "platform_plan") {
    // data.id identifies the subscription resource, not a webhook delivery. Creation, renewal,
    // cancellation, and expiry can all share it. Hash the signed body for delivery dedupe while
    // retaining providerEventId separately for subscription matching and money-ledger joins.
    const planEventId = `body:${await sha256Hex(rawBody)}`;
    const firstDelivery = await markEventProcessedOnce("lemon_squeezy", planEventId, event.type, env.PLATFORM_DB);
    if (!firstDelivery) {
      console.log(`[billing/ls] Duplicate delivery of platform-plan event=${planEventId} — no-op`);
      return Response.json({ ok: true, duplicate: true });
    }
    try {
      await recordPlatformPlanSubscription(event, env);
    } catch (err) {
      console.error("[billing/ls] platform plan recording failed:", (err as Error).message);
      await unmarkEventProcessed("lemon_squeezy", planEventId, env.PLATFORM_DB);
      return Response.json({ error: "processing_failed", failed: ["platform plan recording"] }, { status: 500 });
    }
    return Response.json({ ok: true, kind: "platform_plan" });
  }

  // Marketplace license purchases are platform-native one-time sales, not a business's
  // userland order. Grant the tenant fork and developer earning before the generic space flow.
  if (topCustom["kind"] === "marketplace_license") {
    const licenseEventId = `body:${await sha256Hex(rawBody)}`;
    const firstDelivery = await markEventProcessedOnce("lemon_squeezy", licenseEventId, event.type, env.PLATFORM_DB);
    if (!firstDelivery) return Response.json({ ok: true, duplicate: true, kind: "marketplace_license" });
    try {
      await settleMarketplaceLicenseEvent(event, env);
    } catch (err) {
      console.error("[billing/ls] marketplace license settlement failed:", (err as Error).message);
      await unmarkEventProcessed("lemon_squeezy", licenseEventId, env.PLATFORM_DB);
      return Response.json({ error: "processing_failed", failed: ["marketplace license settlement"] }, { status: 500 });
    }
    return Response.json({ ok: true, kind: "marketplace_license" });
  }

  const mappedTemplateSubscription = event.subscriptionId
    ? await env.PLATFORM_DB.prepare("SELECT id FROM template_subscriptions WHERE provider_subscription_id = ? AND space_id = ?")
      .bind(event.subscriptionId, event.spaceId).first<{ id: string }>()
    : null;
  const templateSubscriptionId = topCustom["kind"] === "template_subscription"
    ? String(topCustom["template_subscription_id"] ?? "")
    : mappedTemplateSubscription?.id;
  if (templateSubscriptionId) {
    const templateEventId = `body:${await sha256Hex(rawBody)}`;
    const firstDelivery = await markEventProcessedOnce("lemon_squeezy", templateEventId, event.type, env.PLATFORM_DB);
    if (!firstDelivery) return Response.json({ ok: true, duplicate: true, kind: "template_subscription" });
    try {
      if (event.type === "payment.success") await settleNativeTemplateRoyalty(event, env);
      else if (event.type.startsWith("subscription.")) await syncNativeTemplateSubscriptionStatus(event, env);
    } catch (err) {
      console.error("[billing/ls] template royalty/status failed:", (err as Error).message);
      await unmarkEventProcessed("lemon_squeezy", templateEventId, env.PLATFORM_DB);
      return Response.json({ error: "processing_failed", failed: ["template subscription settlement"] }, { status: 500 });
    }
    return Response.json({ ok: true, kind: "template_subscription" });
  }

  // The Naelao platform handles platform plans, template subscriptions, and marketplace
  // licenses above. Legacy Space-owned storefront, seat, wallet, and revenue-cut events have
  // been retired; acknowledging them without applying stale accounting is deliberate.
  return Response.json({ ok: true, skipped: true, reason: "legacy_space_commerce_removed" });
}
