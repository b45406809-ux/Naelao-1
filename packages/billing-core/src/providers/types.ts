/**
 * Provider-agnostic billing interface for Naelao platform billing. Lemon Squeezy is the primary
 * platform provider; Whop is supported separately for Naelao's own plan checkout. Customer app
 * connections use generic MCP connectors and never enter this billing interface.
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
    | "subscription.expired"
    | "refund.issued";
  /** "whop" is used only for Naelao platform plan checkout. */
  provider: "lemon_squeezy" | "whop";
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
  /** Explicit refunded amount in cents when the provider supplies one. Never infer a refund amount
   * from the original order total: partial refunds must not revoke a full paid entitlement. */
  refundAmountCents?: number;
  currency: string;
  metadata: Record<string, string>;
  /** Raw provider subscription status (e.g. LS's "active"/"cancelled"/"past_due"/"paused"/
   *  "expired"/"on_trial"/"unpaid") — only present on subscription.* events. Provider-specific
   *  vocabulary; callers that need a normalized status should map it themselves per-provider. */
  providerStatus?: string;
  /** ISO timestamp of the next renewal (or, once cancelled, the period end) — only present on
   *  subscription.* events. */
  currentPeriodEnd?: string;
  /** Provider resource update timestamp, when the signed event includes one. Use it only to order
   *  events from that same provider/resource; do not compare timestamps across providers. */
  providerUpdatedAt?: string;
}

export interface CheckoutParams {
  spaceId: string;
  variantOrPriceId: string;
  customerEmail?: string;
  successUrl?: string;
  metadata?: Record<string, string>;
  /** Override the variant's configured price for this ONE checkout (cents). Requires the variant
   *  to be set up for "pay what you want"/custom pricing in the provider's own dashboard — see
   *  the revenue-cut surcharge checkout (workers/billing) for the one caller that needs this. */
  customPriceCents?: number;
}

/** The single interface every platform billing provider implements. */
export interface BillingProvider {
  readonly name: "lemon_squeezy";
  verifyWebhook(rawBody: string, headers: Headers): Promise<boolean>;
  parseWebhookEvent(rawBody: string): NormalizedBillingEvent;
  createCheckout(params: CheckoutParams): Promise<{ url: string }>;
  getCustomerPortalUrl(subscriptionId: string): Promise<string>;
  cancelSubscription(subscriptionId: string): Promise<void>;
}

/** Env shape a provider needs (subset of the billing worker env). */
export interface BillingProviderEnv {
  BILLING_PROVIDER?: "lemon_squeezy";
  // Lemon Squeezy
  LEMON_SQUEEZY_API_KEY?: string;
  LEMON_SQUEEZY_WEBHOOK_SECRET?: string;
  LEMON_SQUEEZY_STORE_ID?: string;
}
