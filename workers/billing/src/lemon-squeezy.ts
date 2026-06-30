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

import { LemonSqueezyProvider, computeResellerAttribution, isLedgerEvent, billingPeriod } from "@naelao/billing-core";
import type { NormalizedBillingEvent, BillingRelationship } from "@naelao/billing-core";

export interface LemonSqueezyEnv {
  LEMON_SQUEEZY_WEBHOOK_SECRET?: string;
  LEMON_SQUEEZY_API_KEY?: string;
  LEMON_SQUEEZY_STORE_ID?: string;
  LAUNCHPAD_FEE_BPS?: string;
  AGENTS_WORKER: Fetcher;
  SPACES_WORKER?: Fetcher;
  PLATFORM_DB: D1Database;
}

/**
 * Activate a paid seat (member/seat billing — the third payer class). On a seat payment,
 * add the buyer to the space's members in SpaceDO and record the fee in launchpad_orders
 * (so seat revenue shows in the same rollup). Returns the order id, or null when the event
 * is not a seat purchase. Idempotent on the provider event id.
 */
async function recordSeatActivation(
  event: NormalizedBillingEvent,
  env: LemonSqueezyEnv
): Promise<string | null> {
  if (event.type !== "payment.success") return null;
  const custom = (event.metadata ?? {}) as Record<string, unknown>;
  if (custom["kind"] !== "seat" || !event.spaceId) return null;

  const space = await env.PLATFORM_DB.prepare(
    "SELECT tenant_id FROM spaces WHERE id = ?"
  ).bind(event.spaceId).first<{ tenant_id: string }>();
  if (!space) return null;

  const gross = event.amountCents ?? 0;
  const feeBps = custom["fee_bps"] ? parseInt(String(custom["fee_bps"]), 10) : parseInt(env.LAUNCHPAD_FEE_BPS ?? "500", 10);
  const fee = Math.round((gross * feeBps) / 10_000);
  const net = Math.max(0, gross - fee);
  const id = crypto.randomUUID();
  const providerEventId = event.subscriptionId ?? `seat:${event.customerId ?? ""}:${gross}:${event.spaceId}`;

  await env.PLATFORM_DB.prepare(
    `INSERT OR IGNORE INTO launchpad_orders
       (id, space_id, tenant_id, product_id, customer_email, gross_cents, fee_cents, net_cents,
        currency, ls_subscription_id, status, provider_event_id)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 'paid', ?)`
  ).bind(
    id, event.spaceId, space.tenant_id, event.customerId ?? null,
    gross, fee, net, event.currency ?? "USD", event.subscriptionId ?? null, providerEventId
  ).run();

  // Activate the member in SpaceDO (idempotent — addMember upserts).
  const userId = custom["user_id"] ? String(custom["user_id"]) : (event.customerId ?? "");
  if (env.SPACES_WORKER && userId) {
    try {
      await env.SPACES_WORKER.fetch(new Request(`http://spaces-worker/spaces/${event.spaceId}/members`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-naelao-tenant-id": space.tenant_id, "x-naelao-internal": "billing" },
        body: JSON.stringify({ space_id: event.spaceId, user_id: userId, role: "member" }),
      }));
    } catch (err) {
      console.error("[billing/ls] Seat member activation failed:", (err as Error).message);
    }
  }
  console.log(`[billing/ls] Seat activated space=${event.spaceId} user=${userId} gross=${gross}c fee=${fee}c`);
  return id;
}

/**
 * Record a customer product order on payment.success, capturing the platform fee. Driven by
 * the custom_data the commerce checkout carried (product_id, fee_bps). Idempotent on the
 * provider event id so webhook retries don't double-write. Returns the order id (or null
 * when this event is not a product sale — e.g. a builder's own plan subscription).
 */
async function recordProductOrder(
  event: NormalizedBillingEvent,
  env: LemonSqueezyEnv
): Promise<string | null> {
  if (event.type !== "payment.success") return null;
  const custom = (event.metadata ?? {}) as Record<string, unknown>;
  const productId = custom["product_id"] ? String(custom["product_id"]) : null;
  if (!productId || !event.spaceId) return null; // not a Launchpad product sale

  const space = await env.PLATFORM_DB.prepare(
    "SELECT tenant_id FROM spaces WHERE id = ?"
  ).bind(event.spaceId).first<{ tenant_id: string }>();
  if (!space) return null;

  const gross = event.amountCents ?? 0;
  const feeBps = custom["fee_bps"] ? parseInt(String(custom["fee_bps"]), 10) : parseInt(env.LAUNCHPAD_FEE_BPS ?? "500", 10);
  const fee = Math.round((gross * feeBps) / 10_000);
  const net = Math.max(0, gross - fee);
  const id = crypto.randomUUID();
  const providerEventId = event.subscriptionId ?? `${event.type}:${event.customerId ?? ""}:${gross}:${productId}`;

  // INSERT OR IGNORE on the unique provider_event_id index → idempotent.
  await env.PLATFORM_DB.prepare(
    `INSERT OR IGNORE INTO launchpad_orders
       (id, space_id, tenant_id, product_id, customer_email, gross_cents, fee_cents, net_cents,
        currency, ls_subscription_id, status, provider_event_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', ?)`
  ).bind(
    id, event.spaceId, space.tenant_id, productId, event.customerId ?? null,
    gross, fee, net, event.currency ?? "USD", event.subscriptionId ?? null, providerEventId
  ).run();
  console.log(`[billing/ls] Recorded order space=${event.spaceId} product=${productId} gross=${gross}c fee=${fee}c`);
  return id;
}

const GOAL_MAP: Record<NormalizedBillingEvent["type"], string> = {
  "payment.success": "A new payment was completed. Fulfil the order, send confirmation, and provision access.",
  "payment.failed": "A payment has failed. Trigger the dunning flow and notify the customer.",
  "subscription.created": "A new subscription has been created. Provision entitlements and send a welcome message.",
  "subscription.updated": "A subscription has been updated. Sync entitlements and notify the customer if needed.",
  "subscription.cancelled": "A subscription has been cancelled. Schedule access removal and send a goodbye message.",
  "subscription.paused": "A subscription has been paused. Temporarily remove access and notify the customer.",
  "subscription.resumed": "A subscription has been resumed. Restore access and notify the customer.",
  "refund.issued": "A refund has been issued. Revoke access and send confirmation to the customer.",
};

/** Look up the default agent for a space from D1. Returns null if the space is not found. */
async function resolveDefaultAgent(
  spaceId: string,
  db: D1Database
): Promise<{ agentId: string; tenantId: string } | null> {
  const row = await db.prepare(
    "SELECT tenant_id FROM spaces WHERE id = ? AND status = 'active'"
  ).bind(spaceId).first<{ tenant_id: string }>();
  if (!row) return null;
  // The default agent is always "naelao-agent" — provisioned by DEFAULT_NAELAO_AGENT profile
  return { agentId: "naelao-agent", tenantId: row.tenant_id };
}

/** POST to agents worker: wake the agent with a billing event goal. */
async function wakeAgent(
  spaceId: string,
  agentId: string,
  tenantId: string,
  event: NormalizedBillingEvent,
  agentsWorker: Fetcher,
  orderId?: string | null
): Promise<void> {
  const goal = GOAL_MAP[event.type] ?? `Handle billing event: ${event.type}`;
  const sessionId = `billing-${event.type}-${Date.now()}`;

  const resp = await agentsWorker.fetch(
    new Request(`http://agents-worker/agents/${agentId}/script/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-space-id": spaceId,
        "x-naelao-tenant-id": tenantId,
        "x-naelao-internal": "billing",
      },
      body: JSON.stringify({
        goal,
        sessionId,
        context: {
          trigger: "billing_event",
          event_type: event.type,
          provider: event.provider,
          customer_id: event.customerId,
          subscription_id: event.subscriptionId,
          amount_cents: event.amountCents,
          currency: event.currency,
          metadata: event.metadata,
          ...(orderId ? { order_id: orderId } : {}),
        },
      }),
    })
  );

  if (!resp.ok) {
    const body = await resp.text();
    console.error(`[billing/ls] Failed to wake agent ${agentId} for space ${spaceId}: ${body}`);
  } else {
    console.log(`[billing/ls] Woke agent ${agentId} for space ${spaceId} — event=${event.type}`);
  }
}

/**
 * If the billing event belongs to a child tenant under a reseller, attribute it to the
 * parent and write a reseller-ledger entry (consolidated invoicing — spec G-AS34/G-AS35).
 * No-op when the space's tenant is not a child tenant or the relationship is "platform".
 */
async function recordResellerAttribution(
  event: NormalizedBillingEvent,
  db: D1Database
): Promise<void> {
  if (!isLedgerEvent(event.type)) return;

  // Resolve the space's tenant, then its parent reseller (if any).
  const space = await db.prepare(
    "SELECT tenant_id FROM spaces WHERE id = ?"
  ).bind(event.spaceId).first<{ tenant_id: string }>();
  if (!space) return;

  const hierarchy = await db.prepare(
    "SELECT parent_tenant_id FROM tenant_hierarchy WHERE child_tenant_id = ? AND status = 'active'"
  ).bind(space.tenant_id).first<{ parent_tenant_id: string }>();
  if (!hierarchy) return;

  const reseller = await db.prepare(
    "SELECT billing_relationship, wholesale_cents, referral_share_pct FROM reseller_accounts WHERE tenant_id = ? AND status = 'active'"
  ).bind(hierarchy.parent_tenant_id).first<{
    billing_relationship: string;
    wholesale_cents: number | null;
    referral_share_pct: number;
  }>();
  if (!reseller) return;

  const attribution = computeResellerAttribution(event, {
    billingRelationship: reseller.billing_relationship as BillingRelationship,
    wholesaleCents: reseller.wholesale_cents,
    referralSharePct: reseller.referral_share_pct,
  });
  if (!attribution) return;

  await db.prepare(
    `INSERT INTO reseller_ledger
       (id, parent_tenant_id, child_tenant_id, child_space_id, event_type,
        retail_cents, wholesale_cents, margin_cents, currency, period)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    crypto.randomUUID(),
    hierarchy.parent_tenant_id,
    space.tenant_id,
    event.spaceId,
    event.type,
    attribution.retailCents,
    attribution.wholesaleCents,
    attribution.marginCents,
    attribution.currency,
    billingPeriod()
  ).run();
  console.log(`[billing/ls] Reseller ledger: parent=${hierarchy.parent_tenant_id} margin=${attribution.marginCents}c (${attribution.relationship})`);
}

/** Handle an inbound Lemon Squeezy webhook POST. */
export async function handleLemonSqueezyWebhook(
  request: Request,
  env: LemonSqueezyEnv
): Promise<Response> {
  const provider = new LemonSqueezyProvider({
    ...(env.LEMON_SQUEEZY_API_KEY ? { LEMON_SQUEEZY_API_KEY: env.LEMON_SQUEEZY_API_KEY } : {}),
    ...(env.LEMON_SQUEEZY_WEBHOOK_SECRET ? { LEMON_SQUEEZY_WEBHOOK_SECRET: env.LEMON_SQUEEZY_WEBHOOK_SECRET } : {}),
    ...(env.LEMON_SQUEEZY_STORE_ID ? { LEMON_SQUEEZY_STORE_ID: env.LEMON_SQUEEZY_STORE_ID } : {}),
  });

  const rawBody = await request.text();

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

  // 3. Resolve the Naelao space from spaceId in the event
  if (!event.spaceId) {
    console.warn("[billing/ls] Event missing spaceId — cannot dispatch to agent");
    return Response.json({ ok: true, skipped: true });
  }

  const agent = await resolveDefaultAgent(event.spaceId, env.PLATFORM_DB);
  if (!agent) {
    console.warn(`[billing/ls] No active space found for spaceId=${event.spaceId}`);
    return Response.json({ ok: true, skipped: true });
  }

  // 4. Reseller attribution — if this space is a child tenant under a reseller, roll the
  //    event up into the parent's consolidated ledger (G-AS34/G-AS35). Best-effort.
  try {
    await recordResellerAttribution(event, env.PLATFORM_DB);
  } catch (err) {
    console.error("[billing/ls] Reseller attribution failed:", (err as Error).message);
  }

  // 5. Record money-in (idempotent). A seat purchase activates a member; otherwise a
  //    product sale is fulfilled. Plan/subscription events for the builder skip both.
  let orderId: string | null = null;
  try {
    orderId = (await recordSeatActivation(event, env)) ?? (await recordProductOrder(event, env));
  } catch (err) {
    console.error("[billing/ls] Order recording failed:", (err as Error).message);
  }

  // 6. Wake the Space Assistant agent asynchronously (ctx.waitUntil equivalent: fire-and-forget).
  //    Pass the order id so the fulfilment agent can look it up and deliver the product.
  await wakeAgent(event.spaceId, agent.agentId, agent.tenantId, event, env.AGENTS_WORKER, orderId);

  return Response.json({ ok: true, event_type: event.type, space_id: event.spaceId, order_id: orderId });
}
