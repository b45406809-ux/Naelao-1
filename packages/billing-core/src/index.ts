// Stripe Meters API calls, proration, subscription lifecycle helpers
//
// Provider-agnostic billing (spec Appendix H): Lemon Squeezy is the primary provider,
// Stripe is a future addition. See ./providers. The Stripe helpers below remain for
// usage-metering until the Stripe BillingProvider lands.
export * from "./providers/index.js";
export * from "./reseller.js";

export interface StripeConfig {
  secretKey: string;
  baseUrl?: string; // for testing
}

export interface MeterEvent {
  event_name: string;
  payload: {
    stripe_customer_id: string;
    value: string; // string representation of number, per Stripe API
  };
  timestamp?: number;
  identifier?: string; // idempotency key
}

export interface SubscriptionInfo {
  id: string;
  customer_id: string;
  status: "active" | "trialing" | "past_due" | "canceled" | "incomplete" | "unpaid";
  plan_tier: string;
  current_period_start: number;
  current_period_end: number;
  cancel_at_period_end: boolean;
}

const STRIPE_API_BASE = "https://api.stripe.com/v1";

async function stripeRequest<T>(
  config: StripeConfig,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: Record<string, string>
): Promise<T> {
  const base = config.baseUrl ?? STRIPE_API_BASE;
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${config.secretKey}`,
    "Content-Type": "application/x-www-form-urlencoded",
    "Stripe-Version": "2024-11-20.acacia",
  };
  const init: RequestInit = {
    method,
    headers,
  };
  if (body !== undefined) init.body = new URLSearchParams(body).toString();
  const resp = await fetch(`${base}${path}`, init);
  if (!resp.ok) {
    const err = await resp.json<{ error?: { message?: string } }>().catch(() => ({ error: { message: `HTTP ${resp.status}` } }));
    throw new Error(err.error?.message ?? `Stripe error: HTTP ${resp.status}`);
  }
  return resp.json<T>();
}

// Report usage to Stripe Meters API (billing v2)
export async function reportMeterEvent(config: StripeConfig, event: MeterEvent): Promise<void> {
  await stripeRequest(config, "POST", "/v2/billing/meter_events", {
    event_name: event.event_name,
    "payload[stripe_customer_id]": event.payload.stripe_customer_id,
    "payload[value]": event.payload.value,
    ...(event.timestamp ? { timestamp: String(event.timestamp) } : {}),
    ...(event.identifier ? { identifier: event.identifier } : {}),
  });
}

// Get customer subscription info
export async function getSubscription(config: StripeConfig, subscriptionId: string): Promise<SubscriptionInfo> {
  const sub = await stripeRequest<{
    id: string;
    customer: string;
    status: string;
    items: { data: Array<{ price: { metadata: { plan_tier?: string } } }> };
    current_period_start: number;
    current_period_end: number;
    cancel_at_period_end: boolean;
  }>(config, "GET", `/subscriptions/${subscriptionId}`);
  const tier = sub.items.data[0]?.price.metadata.plan_tier ?? "free";
  return {
    id: sub.id,
    customer_id: sub.customer,
    status: sub.status as SubscriptionInfo["status"],
    plan_tier: tier,
    current_period_start: sub.current_period_start,
    current_period_end: sub.current_period_end,
    cancel_at_period_end: sub.cancel_at_period_end,
  };
}

// Create or retrieve Stripe customer
export async function ensureStripeCustomer(
  config: StripeConfig,
  tenantId: string,
  email: string,
  name?: string
): Promise<string> {
  // Search for existing customer by metadata
  const search = await stripeRequest<{ data: Array<{ id: string }> }>(
    config, "GET", `/customers/search?query=metadata["tenant_id"]:"${tenantId}"&limit=1`
  );
  if (search.data.length > 0) return search.data[0]?.id ?? "";

  const customer = await stripeRequest<{ id: string }>(config, "POST", "/customers", {
    email,
    ...(name ? { name } : {}),
    "metadata[tenant_id]": tenantId,
  });
  return customer.id;
}

// Cancel subscription at period end
export async function cancelSubscription(config: StripeConfig, subscriptionId: string): Promise<void> {
  await stripeRequest(config, "POST", `/subscriptions/${subscriptionId}`, {
    cancel_at_period_end: "true",
  });
}

// Update subscription to new price (upgrade/downgrade)
export async function updateSubscriptionPrice(
  config: StripeConfig,
  subscriptionId: string,
  newPriceId: string,
  subscriptionItemId: string
): Promise<void> {
  await stripeRequest(config, "POST", `/subscriptions/${subscriptionId}`, {
    "items[0][id]": subscriptionItemId,
    "items[0][price]": newPriceId,
    proration_behavior: "always_invoice",
  });
}

// Compute token cost in USD micros (cost * 1,000,000 for integer storage)
export function computeTokenCostMicro(
  inputTokens: number,
  outputTokens: number,
  model: string
): number {
  const pricing: Record<string, { input: number; output: number }> = {
    "claude-sonnet-4-6": { input: 3.0, output: 15.0 },      // per 1M tokens in USD
    "claude-haiku-4-5-20251001": { input: 0.25, output: 1.25 },
    "claude-opus-4-8": { input: 15.0, output: 75.0 },
  };
  const p = pricing[model] ?? { input: 3.0, output: 15.0 };
  const costUsd = (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
  return Math.round(costUsd * 1_000_000);
}

/**
 * The platform-wide credit unit: 1 credit = $0.01 USD (a cent). Coarse enough to store as a
 * plain integer everywhere credits are already tracked (`space_credits.balance_credits`,
 * customer-bot `daily_spend_cap_credits`/`project_spend`), fine-grained enough that a single
 * Haiku-tier agent turn (a fraction of a cent) still rounds up to a real, non-zero charge
 * rather than disappearing. Single source of truth — every USD↔credit conversion in the
 * platform must go through this constant, not a locally re-derived rate.
 */
export const CREDITS_PER_USD = 100;

/**
 * Converts real reasoner token usage into the platform credit unit, using computeTokenCostMicro's
 * per-model pricing. This is the ONLY place "tokens spent" becomes "credits charged" — replaces
 * the earlier honest-but-coarse "1 token ≈ 1 credit" proxy used before real usage was tracked
 * (NaelaoAgentDO's project spend cap, sub-agent budgets). Always rounds UP: a run that cost
 * anything above $0 must never be recorded as free.
 */
export function tokensToCredits(inputTokens: number, outputTokens: number, model: string): number {
  if (inputTokens <= 0 && outputTokens <= 0) return 0;
  const costMicro = computeTokenCostMicro(inputTokens, outputTokens, model);
  return Math.max(1, Math.ceil((costMicro * CREDITS_PER_USD) / 1_000_000));
}
