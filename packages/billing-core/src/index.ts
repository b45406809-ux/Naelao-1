// Stripe Meters API calls, proration, subscription lifecycle helpers
//
// Provider-agnostic billing (spec Appendix H): Lemon Squeezy is the primary provider,
// Stripe is a future addition. See ./providers. The Stripe helpers below remain for
// usage-metering until the Stripe BillingProvider lands.
export * from "./providers/index.js";
export * from "./reseller.js";
// model-benchmarks.ts and effort.ts import ALLOWED_MODELS back from THIS file (a deliberate
// circular re-export, not a mistake) — they must be re-exported only AFTER everything they
// depend on (ALLOWED_MODELS, capabilityForModel, etc.) is actually defined below, or their own
// module-top-level evaluation reads those bindings before this file has assigned them. See the
// bottom of this file for the actual export statements.

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

// The curated model list, context windows, and reasoning-capability table — split into its own
// dependency-free leaf module (see models.ts's own header for why: a real deploy-time module-
// evaluation-order bug, caught by an actual `wrangler deploy`, not by the local test suite).
export * from "./models.js";

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
    // CF Workers AI bills in "neurons", not tokens, so this is DERIVED rather than published as
    // a per-token price: three real calls against this account solved neurons = 0.026668*input +
    // 0.204805*output exactly (the fit reproduces a held-out third measurement to 4 decimal
    // places), converted at Cloudflare's own $0.011 per 1,000 neurons. Recheck if Cloudflare
    // changes neuron pricing or this model's neuron cost. Note the shape differs from the Claude
    // models: cheaper input than Haiku, but pricier output — a long-answer workload is NOT
    // automatically cheaper here.
    "@cf/meta/llama-3.3-70b-instruct-fp8-fast": { input: 0.293, output: 2.253 },
    // Google AI Studio (Gemini) — Google's own published per-1M-token pricing for the CURRENT
    // (3.x) generation these "-latest" aliases resolve to (see models.ts's MODEL_CONTEXT_WINDOWS
    // comment for why aliases, not pinned ids — the 2.5 generation was cut off from new-user
    // access mid-session). Standard tier only, not the >200K-context doubled rate for Pro — this
    // table has no precedent for context-length-tiered pricing elsewhere. Billed to the CUSTOMER
    // as real value even though the actual API call rides on the operator's own BYOK Google AI
    // Studio key (often free-tier, $0 marginal cost to Naelao) — matches how every other model
    // here is priced by real provider cost, not by what Naelao itself happens to pay. An alias's
    // underlying model — and therefore its real price — can shift over time; revisit if Google
    // republishes different figures for whatever these currently resolve to.
    "google-ai-studio/gemini-flash-lite-latest": { input: 0.30, output: 2.50 },
    "google-ai-studio/gemini-flash-latest": { input: 1.50, output: 7.50 },
    "google-ai-studio/gemini-pro-latest": { input: 2.00, output: 12.0 },
    // Groq — real per-1M-token pricing read directly off `GET
    // https://api.groq.com/openai/v1/models`'s own `pricing.prompt`/`pricing.completion` fields
    // (quoted per-token there; multiplied by 1e6 here) on 2026-08-10, not estimated. Billed to the
    // customer as real value even though the actual call rides on the operator's own free-tier
    // Groq key ($0 marginal cost to Naelao today) — same convention this table already applies to
    // the Gemini rows above. gpt-oss-120b deliberately absent — see models.ts's ALLOWED_MODELS
    // comment for the live tool-calling failure that excluded it from the catalogue.
    "groq/openai/gpt-oss-20b": { input: 0.075, output: 0.30 },
    "groq/llama-3.3-70b-versatile": { input: 0.59, output: 0.79 },
    "groq/llama-3.1-8b-instant": { input: 0.05, output: 0.08 },
    "groq/qwen/qwen3.6-27b": { input: 0.60, output: 3.00 },
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
export { CREDITS_PER_USD } from "./credits.js";

/**
 * Converts real reasoner token usage into the platform credit unit, using computeTokenCostMicro's
 * per-model pricing. This is the ONLY place "tokens spent" becomes "credits charged" — replaces
 * the earlier honest-but-coarse "1 token ≈ 1 credit" proxy used before real usage was tracked
 * (NaelaoAgentDO's project spend cap, sub-agent budgets). Always rounds UP: a run that cost
 * anything above $0 must never be recorded as free.
 */
export { tokensToCredits, calculateResourceCredits, ACTIVE_PHONE_LINE_MONTHLY_CREDITS } from "./credits.js";
export type { ResourceType, ResourceMetadata } from "./credits.js";

/**
 * §A1.26: which Cloudflare compute resource an execution ran on — used to price it, and to
 * choose the `usage_events` metric an infra-credit debit is recorded against. "workflow_step" is
 * billed as a flat per-invocation cost rather than per-ms (a durable CF Workflow step's own
 * orchestration overhead isn't meaningfully proportional to wall-clock time at Naelao's scale).
 */
export { infraTimeToCredits } from "./credits.js";
export type { InfraResourceType } from "./credits.js";

// See the comment near the top of this file — these must come last.
export * from "./model-benchmarks.js";
export * from "./effort.js";
export * from "./personal-plan.js";
export * from "./plans.js";
