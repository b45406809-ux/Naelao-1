/**
 * Provider-agnostic billing (original spec, Appendix H "Billing Provider Strategy",
 * byte ~2261k). Lemon Squeezy is the PRIMARY provider; Stripe is a future addition. Both
 * implement BillingProvider so the rest of the platform never branches on provider.
 *
 * See CLAUDE.md CURRENT DIRECTION #9.
 */

/** A billing event normalized across providers (the only shape downstream code sees). */
export interface NormalizedBillingEvent {
  type:
    | "payment.success"
    | "payment.failed"
    | "subscription.created"
    | "subscription.updated"
    | "subscription.cancelled"
    | "subscription.paused"
    | "subscription.resumed"
    | "refund.issued";
  provider: "lemon_squeezy" | "stripe";
  spaceId: string;
  customerId: string;
  subscriptionId: string | null;
  /** The provider's own stable event/resource id (LS's `data.id` — present on every event,
   *  order or subscription alike). This is the canonical idempotency key for webhook dedup and
   *  order recording — never a synthetic derived key, which can collide across genuinely
   *  distinct events (S0.3). */
  providerEventId: string | null;
  variantOrPriceId: string;
  /** Always an integer, always cents. */
  amountCents: number;
  currency: string;
  metadata: Record<string, string>;
  /** Raw provider subscription status (e.g. LS's "active"/"cancelled"/"past_due"/"paused"/
   *  "expired"/"on_trial"/"unpaid") — only present on subscription.* events. Provider-specific
   *  vocabulary; callers that need a normalized status should map it themselves per-provider. */
  providerStatus?: string;
  /** ISO timestamp of the next renewal (or, once cancelled, the period end) — only present on
   *  subscription.* events. */
  currentPeriodEnd?: string;
}

export interface CheckoutParams {
  spaceId: string;
  variantOrPriceId: string;
  customerEmail?: string;
  successUrl?: string;
  metadata?: Record<string, string>;
}

/** The single interface every billing provider implements. */
export interface BillingProvider {
  readonly name: "lemon_squeezy" | "stripe";
  verifyWebhook(rawBody: string, headers: Headers): Promise<boolean>;
  parseWebhookEvent(rawBody: string): NormalizedBillingEvent;
  createCheckout(params: CheckoutParams): Promise<{ url: string }>;
  getCustomerPortalUrl(subscriptionId: string): Promise<string>;
  cancelSubscription(subscriptionId: string): Promise<void>;
}

/** Env shape a provider needs (subset of the billing worker env). */
export interface BillingProviderEnv {
  BILLING_PROVIDER?: "lemon_squeezy" | "stripe";
  // Lemon Squeezy
  LEMON_SQUEEZY_API_KEY?: string;
  LEMON_SQUEEZY_WEBHOOK_SECRET?: string;
  LEMON_SQUEEZY_STORE_ID?: string;
  // Stripe (future)
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
}
