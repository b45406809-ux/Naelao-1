/**
 * Wallet Connect webhooks — money-in events from a space's OWN payment account
 * (payment_connections, migration 0063). Two public ingress routes, both signature-verified:
 *
 *   POST /webhooks/stripe                              — the platform's ONE Stripe Connect
 *     endpoint. Verified with STRIPE_CONNECT_WEBHOOK_SECRET (Stripe signs; a builder can't
 *     forge). The event's top-level `account` field says which connected account it happened
 *     on → resolved to a payment_connections row.
 *
 *   POST /webhooks/lemon-squeezy/wallet/:connectionId  — one webhook per LS connection,
 *     auto-created on the BUILDER's OWN store at connect time with a generated per-connection
 *     signing secret (vault-encrypted). Because the builder controls that store (and could
 *     craft any custom_data), the event's own spaceId claim is NEVER trusted here.
 *
 * Both handlers FORCE event.spaceId to the connection row's own space_id before any side
 * effect — the connection row (created by a verified owner/admin) is the authority on which
 * space an event belongs to, never the webhook payload.
 *
 * Settlement model — deliberately different from handleLemonSqueezyWebhook's Naelao-custody
 * path: the gross already settled in the BUILDER's own account (that's the whole point), so
 * settleOrderToWallet (crediting the platform-internal wallet) is NEVER called — doing so
 * would double-count revenue that's already in their bank. What IS recorded:
 *   - launchpad_orders row (Orders UI / analytics / fulfillment), idempotent.
 *   - stripe rail: Naelao's fee (+ any parent-builder share) was auto-collected via
 *     application_fee_amount, so a parent-builder share is recorded as the usual
 *     builder_revenue_share ledger row (payable from what Naelao collected).
 *   - lemon_squeezy rail: nothing was auto-split — Naelao's fee is recorded as a
 *     reseller_ledger row kind='platform_fee_receivable' (parent_tenant_id='platform';
 *     margin_cents = what this tenant owes Naelao for the sale). Parent-builder revenue
 *     share is deliberately NOT attributed on this rail (Naelao collected nothing to pay it
 *     from) — documented limitation, not silently wrong.
 * Subscription-class events on wallet rails are acknowledged but not recorded (product
 * checkouts on both rails are one-time payments today).
 */

import type { NormalizedBillingEvent } from "@naelao/billing-core";
import { LemonSqueezyProvider, StripeProvider } from "@naelao/billing-core";
import type { BillingEnv } from "./index.js";
import {
  markEventProcessedOnce,
  unmarkEventProcessed,
  sha256Hex,
  resolveDefaultAgent,
  resolveFulfillmentProjectId,
  isFulfillmentAgentBound,
  recordBuilderRevenueShare,
  resolveBuilderShare,
  type LemonSqueezyEnv,
  wakeAgent,
} from "./lemon-squeezy.js";
import {
  getConnectionByProviderAccount,
  getConnectionById,
  fetchWalletVaultSecret,
  type PaymentConnectionRow,
} from "./wallet-connections.js";

/** Current YYYY-MM, matching lemon-squeezy.ts's own billingPeriod convention. */
function billingPeriod(): string {
  return new Date().toISOString().slice(0, 7);
}

function lemonSqueezyEnvOf(env: BillingEnv): LemonSqueezyEnv {
  return {
    PLATFORM_DB: env.PLATFORM_DB,
    PLATFORM_SECRET: env.PLATFORM_SECRET,
    // LemonSqueezyEnv declares this required, but nothing this module reaches through lsEnv
    // uses it (wakeAgent gets the fetcher as a direct argument, guarded at the call site).
    AGENTS_WORKER: env.AGENTS_WORKER as Fetcher,
    ...(env.SPACES_WORKER ? { SPACES_WORKER: env.SPACES_WORKER } : {}),
    ...(env.LAUNCHPAD_FEE_BPS ? { LAUNCHPAD_FEE_BPS: env.LAUNCHPAD_FEE_BPS } : {}),
  };
}

/**
 * Stable order key for a wallet event. Stripe: the payment_intent is the one id shared between
 * checkout.session.completed and the later charge.refunded (their evt_ ids never match), so the
 * order row is keyed on it. LS wallet: LS order ids are only unique within a store, and the
 * builder controls their store — namespace by connection so two builders' stores can never
 * collide (or deliberately collide) on an order id.
 */
function walletOrderKey(connection: PaymentConnectionRow, event: NormalizedBillingEvent): string {
  if (connection.provider === "stripe") {
    const pi = (event.metadata ?? {})["payment_intent"];
    return pi ? `pi:${pi}` : (event.providerEventId ?? `stripe:${connection.id}:${event.amountCents}`);
  }
  return `lswallet:${connection.id}:${event.providerEventId ?? ""}`;
}

/**
 * Record a paid order for a wallet-connected space. Idempotent (INSERT OR IGNORE on the unique
 * provider_event_id index). NEVER settles to the platform-internal wallet — see module header.
 */
async function recordWalletOrder(
  connection: PaymentConnectionRow,
  event: NormalizedBillingEvent,
  env: BillingEnv
): Promise<string | null> {
  if (event.type !== "payment.success") return null;
  const custom = (event.metadata ?? {}) as Record<string, unknown>;
  const productId = custom["product_id"] ? String(custom["product_id"]) : null;
  if (!productId) return null; // not a Launchpad product sale (some other checkout on their account)

  const gross = event.amountCents ?? 0;
  const feeBps = custom["fee_bps"] ? parseInt(String(custom["fee_bps"]), 10) : parseInt(env.LAUNCHPAD_FEE_BPS ?? "500", 10);
  const fee = Math.round((gross * feeBps) / 10_000);
  const lsEnv = lemonSqueezyEnvOf(env);
  const builderShare = await resolveBuilderShare(event, gross, fee, lsEnv);
  // Parent-builder share is only payable when Naelao actually collected it (stripe rail's
  // application fee covers fee + builderFee; the LS rail collects nothing).
  const builderFee = connection.provider === "stripe" ? (builderShare?.builderFeeCents ?? 0) : 0;
  const net = Math.max(0, gross - fee - builderFee);
  const orderKey = walletOrderKey(connection, event);
  const id = crypto.randomUUID();

  await env.PLATFORM_DB.prepare(
    `INSERT OR IGNORE INTO launchpad_orders
       (id, space_id, tenant_id, product_id, customer_email, gross_cents, fee_cents, builder_fee_cents, net_cents,
        currency, ls_subscription_id, status, provider_event_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', ?)`
  ).bind(
    id, connection.space_id, connection.tenant_id, productId, event.customerId || null,
    gross, fee, builderFee, net, event.currency ?? "USD", event.subscriptionId ?? null, orderKey
  ).run();
  console.log(`[billing/wallet] Recorded ${connection.provider} order space=${connection.space_id} product=${productId} gross=${gross}c fee=${fee}c (settled in builder's own account)`);

  if (connection.provider === "stripe" && builderShare && builderFee > 0) {
    await recordBuilderRevenueShare(env.PLATFORM_DB, builderShare, event, builderFee, orderKey, false);
  }
  if (connection.provider === "lemon_squeezy" && fee > 0) {
    await recordPlatformFeeReceivable(connection, event, fee, orderKey, false, env);
  }
  return id;
}

/**
 * The LS-rail platform fee can't be auto-split (LS is merchant-of-record on the BUILDER's own
 * store), so it's recorded as a receivable — a reseller_ledger row with kind=
 * 'platform_fee_receivable' and parent_tenant_id='platform': margin_cents is what this tenant
 * owes Naelao for the sale, summable per period into a statement. A refund writes a matching
 * negative row (never deletes — audit trail), same convention as builder_revenue_share.
 */
async function recordPlatformFeeReceivable(
  connection: PaymentConnectionRow,
  event: NormalizedBillingEvent,
  feeCents: number,
  orderKey: string,
  reverse: boolean,
  env: BillingEnv
): Promise<void> {
  await env.PLATFORM_DB.prepare(
    `INSERT OR IGNORE INTO reseller_ledger
       (id, parent_tenant_id, child_tenant_id, child_space_id, event_type,
        retail_cents, wholesale_cents, margin_cents, currency, period, provider_event_id, kind)
     VALUES (?, 'platform', ?, ?, ?, ?, 0, ?, ?, ?, ?, 'platform_fee_receivable')`
  ).bind(
    crypto.randomUUID(), connection.tenant_id, connection.space_id,
    reverse ? "refund.issued" : event.type, event.amountCents ?? 0,
    reverse ? -feeCents : feeCents, event.currency ?? "USD", billingPeriod(),
    `${reverse ? "feerefund" : "fee"}:${orderKey}`
  ).run();
  console.log(`[billing/wallet] Platform fee receivable ${reverse ? "reversed" : "recorded"}: tenant=${connection.tenant_id} ${reverse ? -feeCents : feeCents}c`);
}

/**
 * Flip a wallet order to refunded + reverse the ledger rows. No wallet clawback — the wallet
 * was never credited on this rail; the actual money movement happens in the builder's own
 * provider account (Stripe/LS handle the refund itself).
 */
async function recordWalletRefund(
  connection: PaymentConnectionRow,
  event: NormalizedBillingEvent,
  env: BillingEnv
): Promise<void> {
  if (event.type !== "refund.issued") return;
  const orderKey = walletOrderKey(connection, event);

  const order = await env.PLATFORM_DB.prepare(
    "SELECT space_id, tenant_id, fee_cents, builder_fee_cents, status FROM launchpad_orders WHERE provider_event_id = ?"
  ).bind(orderKey).first<{ space_id: string; tenant_id: string; fee_cents: number; builder_fee_cents: number; status: string }>();
  if (!order || order.status === "refunded") return;
  // Cross-connection safety: an order key is already connection-namespaced (LS) or
  // payment_intent-scoped (Stripe), but belt-and-suspenders — never flip another space's order.
  if (order.space_id !== connection.space_id) return;

  const updateResult = await env.PLATFORM_DB.prepare(
    "UPDATE launchpad_orders SET status = 'refunded' WHERE provider_event_id = ? AND status != 'refunded'"
  ).bind(orderKey).run();
  if (updateResult.meta.changes === 0) return; // concurrent delivery already handled it

  if (connection.provider === "stripe" && order.builder_fee_cents > 0) {
    const hierarchy = await env.PLATFORM_DB.prepare(
      "SELECT parent_tenant_id FROM tenant_hierarchy WHERE child_tenant_id = ? AND status = 'active'"
    ).bind(order.tenant_id).first<{ parent_tenant_id: string }>();
    if (hierarchy) {
      await recordBuilderRevenueShare(
        env.PLATFORM_DB,
        { builderFeeCents: order.builder_fee_cents, parentTenantId: hierarchy.parent_tenant_id, childTenantId: order.tenant_id, childSpaceId: order.space_id },
        event, order.builder_fee_cents, orderKey, true
      );
    }
  }
  if (connection.provider === "lemon_squeezy" && order.fee_cents > 0) {
    await recordPlatformFeeReceivable(connection, event, order.fee_cents, orderKey, true, env);
  }
}

/**
 * Shared dispatch for a verified, connection-resolved wallet event. Mirrors
 * handleLemonSqueezyWebhook's exactly-once + release-on-transient-failure semantics.
 */
async function dispatchWalletEvent(
  connection: PaymentConnectionRow,
  event: NormalizedBillingEvent,
  rawBody: string,
  dedupeProvider: string,
  env: BillingEnv
): Promise<Response> {
  // The connection row is the authority on which space this event belongs to — never the
  // payload's own claim (a builder controls their own LS store's custom_data).
  event.spaceId = connection.space_id;

  const eventId = `${connection.id}:${event.providerEventId ?? `hash:${await sha256Hex(rawBody)}`}`;
  const firstDelivery = await markEventProcessedOnce(dedupeProvider, eventId, event.type, env.PLATFORM_DB);
  if (!firstDelivery) {
    return Response.json({ ok: true, duplicate: true });
  }

  const failures: string[] = [];
  let orderId: string | null = null;
  try {
    orderId = await recordWalletOrder(connection, event, env);
  } catch (err) {
    console.error("[billing/wallet] order recording failed:", (err as Error).message);
    failures.push("order recording");
  }
  try {
    await recordWalletRefund(connection, event, env);
  } catch (err) {
    console.error("[billing/wallet] refund recording failed:", (err as Error).message);
    failures.push("refund recording");
  }

  if (failures.length > 0) {
    await unmarkEventProcessed(dedupeProvider, eventId, env.PLATFORM_DB);
    return Response.json({ error: "processing_failed", failed: failures }, { status: 500 });
  }

  // Wake the agent (fulfillment specialist for a paid order when bound, Space Assistant
  // otherwise) — same routing decision as the platform LS path.
  const lsEnv = lemonSqueezyEnvOf(env);
  const agent = await resolveDefaultAgent(connection.space_id, env.PLATFORM_DB);
  if (agent && env.AGENTS_WORKER) {
    try {
      const projectId = await resolveFulfillmentProjectId(connection.space_id, agent.tenantId, lsEnv);
      const fulfillmentBound = event.type === "payment.success" && (await isFulfillmentAgentBound(connection.space_id, agent.tenantId, lsEnv));
      const targetAgentId = fulfillmentBound ? "launchpad-fulfillment-v1" : agent.agentId;
      await wakeAgent(connection.space_id, targetAgentId, agent.tenantId, event, env.AGENTS_WORKER, env.PLATFORM_SECRET, orderId, projectId);
    } catch (err) {
      // Agent wake is best-effort (matches the platform path's fire-and-forget posture) — the
      // money side-effects above already settled idempotently.
      console.error("[billing/wallet] agent wake failed:", (err as Error).message);
    }
  }

  return Response.json({ ok: true, event_type: event.type, space_id: connection.space_id, order_id: orderId, rail: connection.provider });
}

/** POST /webhooks/stripe — the platform's single Stripe Connect webhook endpoint. */
export async function handleStripeConnectWebhook(request: Request, env: BillingEnv): Promise<Response> {
  if (!env.STRIPE_CONNECT_WEBHOOK_SECRET) {
    console.warn("[billing/wallet] Stripe webhook received but STRIPE_CONNECT_WEBHOOK_SECRET is unset");
    return Response.json({ error: "stripe_not_configured" }, { status: 503 });
  }
  const rawBody = await request.text();
  const provider = new StripeProvider({ secretKey: env.STRIPE_PLATFORM_SECRET_KEY ?? "", webhookSecret: env.STRIPE_CONNECT_WEBHOOK_SECRET });

  const valid = await provider.verifyWebhook(rawBody, request.headers);
  if (!valid) {
    console.warn("[billing/wallet] Stripe webhook signature verification failed");
    return Response.json({ error: "invalid_signature" }, { status: 401 });
  }

  let event: NormalizedBillingEvent;
  try {
    event = provider.parseWebhookEvent(rawBody);
  } catch (err) {
    console.log("[billing/wallet] Unmapped Stripe event:", (err as Error).message);
    return Response.json({ ok: true, skipped: true }); // 200 so Stripe doesn't retry unknown types
  }

  // Which connected account did this happen on? Only Connect events carry it; a platform-account
  // event (shouldn't occur — Naelao does no platform-account Stripe billing) is skipped.
  const stripeAccount = (event.metadata ?? {})["stripe_account"];
  if (!stripeAccount) return Response.json({ ok: true, skipped: true, reason: "no connected account" });

  const connection = await getConnectionByProviderAccount(env.PLATFORM_DB, "stripe", stripeAccount);
  if (!connection) {
    console.warn(`[billing/wallet] Stripe event for unknown connected account ${stripeAccount}`);
    return Response.json({ ok: true, skipped: true });
  }

  return dispatchWalletEvent(connection, event, rawBody, "stripe", env);
}

/** POST /webhooks/lemon-squeezy/wallet/:connectionId — per-connection BYO-store webhook. */
export async function handleWalletLsWebhook(request: Request, env: BillingEnv, connectionId: string): Promise<Response> {
  const connection = await getConnectionById(env.PLATFORM_DB, connectionId);
  if (!connection || connection.provider !== "lemon_squeezy" || connection.status === "disabled") {
    // 200 (not 404): a disconnected builder's store may keep POSTing until its webhook is
    // deleted; LS retrying a 404 forever helps no one.
    return Response.json({ ok: true, skipped: true });
  }
  if (!connection.webhook_secret_credential) {
    return Response.json({ ok: true, skipped: true, reason: "no webhook secret on connection" });
  }

  const secret = await fetchWalletVaultSecret(env, connection.tenant_id, connection.space_id, connection.webhook_secret_credential);
  if (!secret) {
    // Vault unavailable is TRANSIENT — 500 so LS retries rather than dropping a real order.
    console.error(`[billing/wallet] Could not resolve webhook secret for connection ${connectionId}`);
    return Response.json({ error: "secret_unavailable" }, { status: 500 });
  }

  const rawBody = await request.text();
  const provider = new LemonSqueezyProvider({ LEMON_SQUEEZY_WEBHOOK_SECRET: secret });
  const valid = await provider.verifyWebhook(rawBody, request.headers);
  if (!valid) {
    console.warn(`[billing/wallet] LS wallet webhook signature verification failed for connection ${connectionId}`);
    return Response.json({ error: "invalid_signature" }, { status: 401 });
  }

  let event: NormalizedBillingEvent;
  try {
    event = provider.parseWebhookEvent(rawBody);
  } catch (err) {
    console.log("[billing/wallet] Unmapped LS wallet event:", (err as Error).message);
    return Response.json({ ok: true, skipped: true });
  }

  return dispatchWalletEvent(connection, event, rawBody, "lemon_squeezy_wallet", env);
}
