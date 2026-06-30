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

export interface LemonSqueezyEnv {
  LEMON_SQUEEZY_WEBHOOK_SECRET?: string;
  LEMON_SQUEEZY_API_KEY?: string;
  LEMON_SQUEEZY_STORE_ID?: string;
  AGENTS_WORKER: Fetcher;
  PLATFORM_DB: D1Database;
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
  agentsWorker: Fetcher
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

  // 4. Wake the Space Assistant agent asynchronously (ctx.waitUntil equivalent: fire-and-forget)
  await wakeAgent(event.spaceId, agent.agentId, agent.tenantId, event, env.AGENTS_WORKER);

  return Response.json({ ok: true, event_type: event.type, space_id: event.spaceId });
}
