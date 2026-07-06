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
import { mintInternalToken } from "@naelao/http";

export interface LemonSqueezyEnv {
  LEMON_SQUEEZY_WEBHOOK_SECRET?: string;
  LEMON_SQUEEZY_API_KEY?: string;
  LEMON_SQUEEZY_STORE_ID?: string;
  LAUNCHPAD_FEE_BPS?: string;
  AGENTS_WORKER: Fetcher;
  SPACES_WORKER?: Fetcher;
  PLATFORM_DB: D1Database;
  /** For minting the internal HMAC token the direct (non-router) SPACES_WORKER call below needs. */
  PLATFORM_SECRET: string;
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
        headers: {
          "content-type": "application/json",
          "x-naelao-tenant-id": space.tenant_id,
          "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, space.tenant_id),
        },
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

/** Map Lemon Squeezy's own subscription status vocabulary onto business_subscriptions' narrower
 *  CHECK-constrained enum. "on_trial" and "unpaid" don't have their own column value — trialing
 *  counts as active access, unpaid is a stronger past_due (the builder's UI doesn't currently
 *  need to distinguish them; add a value if that changes). */
function mapSubscriptionStatus(event: NormalizedBillingEvent): string {
  switch (event.type) {
    case "subscription.cancelled": return "cancelled";
    case "subscription.paused": return "paused";
    case "subscription.resumed": return "active";
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
 * Phase E (§A1.17): a business subscribing to one of its product's builder-defined plans
 * (productConfig.pricingConfig.plans). Fires on every subscription.* event whose checkout
 * metadata carries kind="business_subscription" (set by POST /internal/business-subscriptions/
 * checkout). Upserts by business_space_id (a business has at most one current plan — switching
 * plans overwrites the row rather than accumulating history; reseller_ledger is the historical
 * revenue record) so a webhook retry or a later status transition is a no-op / in-place update,
 * never a duplicate row.
 */
async function recordBusinessSubscription(
  event: NormalizedBillingEvent,
  env: LemonSqueezyEnv
): Promise<boolean> {
  const custom = (event.metadata ?? {}) as Record<string, unknown>;
  if (custom["kind"] !== "business_subscription" || !event.spaceId) return false;
  const planId = custom["plan_id"] ? String(custom["plan_id"]) : null;
  const productSpaceId = custom["product_space_id"] ? String(custom["product_space_id"]) : null;
  if (!planId || !productSpaceId) return false;

  const status = mapSubscriptionStatus(event);
  await env.PLATFORM_DB.prepare(
    `INSERT INTO business_subscriptions
       (id, business_space_id, product_space_id, plan_id, status, ls_subscription_id, ls_customer_id, current_period_end, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(business_space_id) DO UPDATE SET
       product_space_id = excluded.product_space_id,
       plan_id = excluded.plan_id,
       status = excluded.status,
       ls_subscription_id = excluded.ls_subscription_id,
       ls_customer_id = excluded.ls_customer_id,
       current_period_end = excluded.current_period_end,
       updated_at = excluded.updated_at`
  ).bind(
    crypto.randomUUID(), event.spaceId, productSpaceId, planId, status,
    event.subscriptionId ?? null, event.customerId ?? null, event.currentPeriodEnd ?? null,
    new Date().toISOString()
  ).run();
  console.log(`[billing/ls] Business subscription ${status}: business=${event.spaceId} plan=${planId}`);
  return true;
}

/**
 * Phase E: an end user buying a one-time credit pack for their OWN ProductUserDO balance. Fires
 * on payment.success with checkout metadata kind="credit_pack". Grants via the spaces worker
 * (only it holds the PRODUCT_USER_DO binding) with a stable idempotency_key so a webhook retry
 * never double-grants — ProductUserDO's own credit_ledger enforces this with a unique partial
 * index (see workers/spaces/src/do/ProductUserDO.ts migration v2).
 */
async function grantCreditPackPurchase(
  event: NormalizedBillingEvent,
  env: LemonSqueezyEnv
): Promise<boolean> {
  if (event.type !== "payment.success") return false;
  const custom = (event.metadata ?? {}) as Record<string, unknown>;
  if (custom["kind"] !== "credit_pack" || !event.spaceId) return false;
  const endUserId = custom["end_user_id"] ? String(custom["end_user_id"]) : null;
  const productSpaceId = custom["product_space_id"] ? String(custom["product_space_id"]) : null;
  const credits = custom["credits"] ? parseInt(String(custom["credits"]), 10) : 0;
  if (!endUserId || !productSpaceId || !credits) return false;
  if (!env.SPACES_WORKER) return false;

  const product = await env.PLATFORM_DB.prepare("SELECT tenant_id FROM spaces WHERE id = ?")
    .bind(productSpaceId).first<{ tenant_id: string }>();
  if (!product) return false;

  const idempotencyKey = event.subscriptionId ?? `credit_pack:${event.customerId ?? ""}:${event.amountCents}:${endUserId}:${credits}`;
  try {
    const resp = await env.SPACES_WORKER.fetch(new Request("http://spaces-worker/internal/credit-packs/grant", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": product.tenant_id,
        "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, product.tenant_id),
      },
      body: JSON.stringify({ product_space_id: productSpaceId, end_user_id: endUserId, credits, idempotency_key: idempotencyKey }),
    }));
    if (!resp.ok) {
      console.error(`[billing/ls] Credit pack grant failed for end_user=${endUserId}: ${await resp.text()}`);
      return false;
    }
    console.log(`[billing/ls] Granted ${credits} credits to end_user=${endUserId} product=${productSpaceId}`);
    return true;
  } catch (err) {
    console.error("[billing/ls] Credit pack grant error:", (err as Error).message);
    return false;
  }
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

/**
 * The Launchpad core agent that handles order fulfillment (spec §11 / launchpad/spacetype.ts).
 * Billing worker deliberately doesn't import the agents worker's module (workers stay
 * independent — mirrors the "naelao-agent" literal every dispatcher hardcodes per A1.16.7)
 * so this is a local literal, kept in sync by convention.
 */
const FULFILLMENT_AGENT_ID = "launchpad-fulfillment-v1";

/**
 * Resolve a pre-seeded project bound to the fulfillment agent for this space, if the builder's
 * template created one (creator-store/newsletter-business/micro-saas seed one — e.g. "Orders" —
 * via bootstrap.projects with default_agent_id: "launchpad-fulfillment-v1"; see
 * launchpad/spacetype.ts). When present, a billing event is scoped to that project
 * (workspace-scoped, its own approval gates and execution ceiling apply) instead of running
 * space-wide — the Space Assistant does the general coordination, but the actual order-handling
 * work has a dedicated home a builder can rename, reassign, or remove.
 *
 * Matches on default_agent_id first (the real binding — survives a rename). Falls back to a
 * project literally named "Orders" for a space provisioned before projects.default_agent_id
 * existed, or where a builder manually created an "Orders" project without setting the binding.
 * Best-effort: returns undefined (never throws) when SPACES_WORKER is unbound, the lookup fails,
 * or no matching project exists — the caller falls back to the space-wide Space Assistant run
 * exactly as before, so a builder who deletes/reassigns the project doesn't break anything.
 */
type SpaceProject = { id: string; name: string; status?: string; default_agent_id?: string | null };

async function fetchSpaceProjects(
  spaceId: string,
  tenantId: string,
  env: LemonSqueezyEnv
): Promise<SpaceProject[] | undefined> {
  if (!env.SPACES_WORKER) return undefined;
  try {
    const resp = await env.SPACES_WORKER.fetch(new Request(`http://spaces-worker/spaces/${spaceId}/projects`, {
      headers: {
        "x-naelao-tenant-id": tenantId,
        "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, tenantId),
      },
    }));
    if (!resp.ok) return undefined;
    const { data } = await resp.json<{ data: SpaceProject[] }>();
    return data;
  } catch {
    return undefined;
  }
}

export async function resolveFulfillmentProjectId(
  spaceId: string,
  tenantId: string,
  env: LemonSqueezyEnv
): Promise<string | undefined> {
  const data = await fetchSpaceProjects(spaceId, tenantId, env);
  if (!data) return undefined;
  const byBinding = data.find((p) => p.default_agent_id === FULFILLMENT_AGENT_ID && p.status !== "archived");
  if (byBinding) return byBinding.id;
  const byName = data.find((p) => p.name?.trim().toLowerCase() === "orders" && p.status !== "archived");
  return byName?.id;
}

/**
 * Whether launchpad-fulfillment-v1 is actually bound to a project in this space — the STRONG
 * signal (a real default_agent_id, set only when the builder's template installed this exact
 * agent), unlike resolveFulfillmentProjectId's looser name-only "Orders" fallback above (kept
 * for scoping an already-decided Space Assistant run, not for deciding WHICH agent to wake — a
 * space that merely happens to have a project literally named "Orders" without the agent
 * actually being provisioned must not get routed to an agent that 404s). Used by the routing
 * decision in handleLemonSqueezyWebhook. Best-effort: false (never throws) on any failure — the
 * caller falls back to the Space Assistant, exactly as every billing event did before this fix.
 */
export async function isFulfillmentAgentBound(
  spaceId: string,
  tenantId: string,
  env: LemonSqueezyEnv
): Promise<boolean> {
  const data = await fetchSpaceProjects(spaceId, tenantId, env);
  return data?.some((p) => p.default_agent_id === FULFILLMENT_AGENT_ID && p.status !== "archived") ?? false;
}

/** POST to agents worker: wake the agent with a billing event goal. */
async function wakeAgent(
  spaceId: string,
  agentId: string,
  tenantId: string,
  event: NormalizedBillingEvent,
  agentsWorker: Fetcher,
  platformSecret: string,
  orderId?: string | null,
  projectId?: string
): Promise<void> {
  const goal = GOAL_MAP[event.type] ?? `Handle billing event: ${event.type}`;
  const sessionId = `billing-${event.type}-${Date.now()}`;

  // S0.2: mint a real internal HMAC token — the endpoint no longer accepts the static
  // x-naelao-internal header, since that trusted a caller-chosen tenantId with no proof.
  const internalToken = await mintInternalToken(platformSecret, tenantId);
  const resp = await agentsWorker.fetch(
    new Request(`http://agents-worker/agents/${agentId}/script/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-space-id": spaceId,
        "x-naelao-tenant-id": tenantId,
        "x-naelao-internal-token": internalToken,
      },
      body: JSON.stringify({
        goal,
        sessionId,
        ...(projectId ? { projectId } : {}),
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
    console.log(`[billing/ls] Woke agent ${agentId} for space ${spaceId}${projectId ? ` project=${projectId}` : ""} — event=${event.type}`);
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

  // 5b. Phase E: business subscription state (subscription.* events only) and credit-pack grants
  //     (payment.success only) — both keyed off checkout metadata.kind, so they never collide
  //     with the seat/product paths above (each event matches at most one of these four kinds).
  try {
    await recordBusinessSubscription(event, env);
  } catch (err) {
    console.error("[billing/ls] Business subscription recording failed:", (err as Error).message);
  }
  try {
    await grantCreditPackPurchase(event, env);
  } catch (err) {
    console.error("[billing/ls] Credit pack grant failed:", (err as Error).message);
  }

  // 6. Wake an agent asynchronously (ctx.waitUntil equivalent: fire-and-forget). Pass the order
  //    id so the fulfilment agent can look it up and deliver the product, and scope the run to
  //    the space's "Orders" project when the template seeded one (best-effort — falls back to a
  //    space-wide run when there isn't one).
  const projectId = await resolveFulfillmentProjectId(event.spaceId, agent.tenantId, env);

  // F: routing decision (spec §11 / appendix A1.16.x) — LaunchpadAgentDefinition.trigger for
  // launchpad-fulfillment-v1 is `{ type: "webhook", event: "order.completed" }`, but nothing
  // ever woke that agent; every order fired against the generic Space Assistant instead, so the
  // specialist's own system prompt AND its own requires_approval_for gates (customer_email_send,
  // refund_issue — see approval-gates-structural.test.ts) never actually applied to a real order.
  // Decision: an order-completed event ("payment.success") routes to the fulfillment specialist's
  // OWN agent DO instead of the Space Assistant, but ONLY when isFulfillmentAgentBound confirms
  // the specialist is actually provisioned in this space (a real default_agent_id binding — not
  // the looser "a project happens to be named Orders" fallback resolveFulfillmentProjectId also
  // accepts for scoping, since routing to an agent that was never installed would just 404 and
  // silently drop the order). No binding (a space provisioned before projects.default_agent_id
  // existed, a manually reassigned/removed project, or a raw core-agents install with no
  // template) falls back to the Space Assistant exactly as before — never left unhandled. Every
  // OTHER billing event type (subscription changes, payment failures, refunds) keeps waking the
  // Space Assistant unchanged: order-completed is the only event this SpaceType defines a
  // specialist trigger for. Only one agent is ever woken per event — never both.
  const fulfillmentBound = event.type === "payment.success" && (await isFulfillmentAgentBound(event.spaceId, agent.tenantId, env));
  const targetAgentId = fulfillmentBound ? FULFILLMENT_AGENT_ID : agent.agentId;
  await wakeAgent(event.spaceId, targetAgentId, agent.tenantId, event, env.AGENTS_WORKER, env.PLATFORM_SECRET, orderId, projectId);

  return Response.json({ ok: true, event_type: event.type, space_id: event.spaceId, order_id: orderId });
}
