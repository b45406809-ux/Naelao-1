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

/**
 * §A1.27: per-model context window size, in tokens — replaces the single hardcoded
 * `MODEL_CONTEXT_LIMIT_TOKENS = 190_000` figure previously baked into `NaelaoAgentDO.ts` (tagged
 * to Sonnet specifically, so it was already wrong for any other model even before the model
 * switcher makes model choice real). Verify against current model documentation before relying on
 * this for a hard cutoff — these are the platform's own approximate defaults, kept next to
 * computeTokenCostMicro's per-model pricing table since both vary per model and should stay
 * mutually consistent (same set of known model strings).
 */
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "claude-sonnet-4-6": 200_000,
  "claude-haiku-4-5-20251001": 200_000,
  "claude-opus-4-8": 200_000,
  // CF Workers AI — every window below is the model's REAL served window, read from the account's
  // own /ai/models/search API rather than the model's nominal upstream figure. Llama 3.3 is the
  // clearest reason not to assume: Workers AI serves it at 24k against a native 128k. Context
  // accounting and the shell's context meter must never treat these as interchangeable.
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": 24_000,
  "@cf/qwen/qwen3-30b-a3b-fp8": 32_768,
  "@cf/openai/gpt-oss-120b": 128_000,
  "@cf/openai/gpt-oss-20b": 128_000,
  "@cf/mistralai/mistral-small-3.1-24b-instruct": 128_000,
  "@cf/ibm-granite/granite-4.0-h-micro": 131_000,
  "@cf/meta/llama-4-scout-17b-16e-instruct": 131_000,
  "@cf/zai-org/glm-4.7-flash": 131_072,
  "@cf/nvidia/nemotron-3-120b-a12b": 256_000,
  "@cf/google/gemma-4-26b-a4b-it": 256_000,
  "@cf/zai-org/glm-5.2": 262_144,
  "@cf/moonshotai/kimi-k2.6": 262_144,
  "@cf/moonshotai/kimi-k2.7-code": 262_144,
};

/**
 * The models a builder may select, and the ONLY models an eval or a run may name.
 *
 * Two properties are load-bearing and both were verified against the account's live
 * /ai/models/search rather than assumed:
 *  - every `@cf/...` entry advertises `function_calling: true`. The reasoner's entire action
 *    space is declared as provider tools (script-engine/reasoner.ts), so a model without tool
 *    calling degrades to the prose-JSON fallback and is materially less reliable — it does not
 *    belong on a list a builder can pick from.
 *  - the list is CURATED, not free text: cost has to stay predictable, and every entry needs a
 *    real context window above for accounting to work.
 *
 * Claude ids are retained for accounts whose AI Gateway actually has Anthropic wired; on an
 * account without it (which is the case today — see CLAUDE.md item 68) they simply never resolve,
 * and the Workers AI entries are the real choice set.
 */
export const ALLOWED_MODELS = [
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-6",
  "claude-opus-4-8",
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/meta/llama-4-scout-17b-16e-instruct",
  "@cf/openai/gpt-oss-120b",
  "@cf/openai/gpt-oss-20b",
  "@cf/qwen/qwen3-30b-a3b-fp8",
  "@cf/mistralai/mistral-small-3.1-24b-instruct",
  "@cf/ibm-granite/granite-4.0-h-micro",
  "@cf/google/gemma-4-26b-a4b-it",
  "@cf/zai-org/glm-4.7-flash",
  "@cf/zai-org/glm-5.2",
  "@cf/nvidia/nemotron-3-120b-a12b",
  "@cf/moonshotai/kimi-k2.6",
  "@cf/moonshotai/kimi-k2.7-code",
] as const;

export type AllowedModel = (typeof ALLOWED_MODELS)[number];

/** Whether a model string is one a builder may select / a run may name. */
export function isAllowedModel(model: string): model is AllowedModel {
  return (ALLOWED_MODELS as readonly string[]).includes(model);
}
const DEFAULT_CONTEXT_WINDOW = 200_000;

/** Context window size for a model, falling back to a documented default for an unknown model
 *  string rather than throwing — a model-switcher allowlist entry that outpaces this table
 *  should degrade to a sane default, not break context accounting. */
export function contextWindowForModel(model: string): number {
  return MODEL_CONTEXT_WINDOWS[model] ?? DEFAULT_CONTEXT_WINDOW;
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
    // CF Workers AI bills in "neurons", not tokens, so this is DERIVED rather than published as
    // a per-token price: three real calls against this account solved neurons = 0.026668*input +
    // 0.204805*output exactly (the fit reproduces a held-out third measurement to 4 decimal
    // places), converted at Cloudflare's own $0.011 per 1,000 neurons. Recheck if Cloudflare
    // changes neuron pricing or this model's neuron cost. Note the shape differs from the Claude
    // models: cheaper input than Haiku, but pricier output — a long-answer workload is NOT
    // automatically cheaper here.
    "@cf/meta/llama-3.3-70b-instruct-fp8-fast": { input: 0.293, output: 2.253 },
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

/**
 * §A1.26: which Cloudflare compute resource an execution ran on — used to price it, and to
 * choose the `usage_events` metric an infra-credit debit is recorded against. "workflow_step" is
 * billed as a flat per-invocation cost rather than per-ms (a durable CF Workflow step's own
 * orchestration overhead isn't meaningfully proportional to wall-clock time at Naelao's scale).
 */
export type InfraResourceType = "isolate" | "container" | "workflow_step";

/**
 * Approximate default USD rates for each resource type — NOT authoritative Cloudflare pricing.
 * Tune against the platform's real CF invoice before relying on this for margin analysis; the
 * relative ordering (container > isolate, workflow steps a small flat fee) is what actually
 * matters for fair per-tenant metering, not the exact figures.
 */
const INFRA_PRICING: Record<InfraResourceType, { perMs: number; flatUsd?: number }> = {
  // Tier 2-4 CF Worker Loader isolates — cheapest, proportional to CF's own CPU-ms billing.
  isolate: { perMs: 0.00000002 },
  // Tier 5 CF Containers — full-VM compute, materially costlier per unit time than an isolate.
  container: { perMs: 0.0000006 },
  // A durable CF Workflow step's cost is dominated by orchestration overhead, not wall-clock —
  // a small flat per-step fee rather than a per-ms rate.
  workflow_step: { perMs: 0, flatUsd: 0.00005 },
};

/**
 * Converts real Cloudflare infra consumption (isolate/container wall-clock time, or a durable
 * Workflow step) into the platform credit unit — the infra-usage counterpart to tokensToCredits.
 * Same "always round up, minimum 1 credit for any nonzero cost" invariant: an execution that
 * consumed real compute must never be recorded as free.
 */
export function infraTimeToCredits(resourceType: InfraResourceType, durationMs: number): number {
  const pricing = INFRA_PRICING[resourceType];
  const costUsd = pricing.perMs * Math.max(0, durationMs) + (pricing.flatUsd ?? 0);
  if (costUsd <= 0) return 0;
  return Math.max(1, Math.ceil(costUsd * CREDITS_PER_USD));
}
