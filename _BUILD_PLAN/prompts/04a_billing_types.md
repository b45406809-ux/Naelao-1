# Prompt 04a: packages/billing-providers/src/types.ts

---
## PASTE THIS ENTIRE BLOCK INTO YOUR FREE AI
---


**Platform context:** Naelao = multi-tenant AI agent builder on Cloudflare Workers + Durable Objects.
NO Node.js · NO PostgreSQL · NO Supabase. Data in SpaceDO SQLite. Worker comms via Service Bindings.
Routing via Hono. Auth via JWT (HMAC-SHA256). Billing via Lemon Squeezy (BillingProvider interface).
Errors always: { error: { code: 'SNAKE_CASE', message: 'text' } }. compatibility_date: "2025-01-01".

**Generate ONE file: `packages/billing-providers/src/types.ts`**

This defines the provider-agnostic billing abstraction. Switching from Lemon Squeezy to Stripe
means changing one env var (`BILLING_PROVIDER`), not touching any billing logic.

```typescript
export type BillingProviderName = 'lemon_squeezy' | 'stripe';

export type NormalizedEventType =
  | 'payment.success' | 'payment.failed'
  | 'subscription.created' | 'subscription.updated'
  | 'subscription.cancelled' | 'subscription.paused'
  | 'subscription.resumed' | 'refund.issued';

export interface NormalizedBillingEvent {
  type: NormalizedEventType;
  provider: BillingProviderName;
  spaceId: string;
  customerId: string;
  subscriptionId: string | null;
  variantOrPriceId: string;
  amountCents: number;      // ALWAYS integer, ALWAYS cents — never parseFloat
  currency: string;
  portalUrl?: string;
  rawEventId: string;       // provider's idempotency key
}

export interface CheckoutParams {
  spaceId: string;
  planVariantOrPriceId: string;
  successUrl: string;
  cancelUrl: string;
  customerEmail?: string;
}

export interface BillingProvider {
  readonly name: BillingProviderName;
  verifyWebhook(rawBody: string, headers: Headers, secret: string): Promise<boolean>;
  parseWebhookEvent(rawBody: string): NormalizedBillingEvent;
  createCheckout(params: CheckoutParams, env: BillingProviderEnv): Promise<{ url: string }>;
  getCustomerPortalUrl(subscriptionId: string, env: BillingProviderEnv): Promise<string>;
  cancelSubscription(subscriptionId: string, env: BillingProviderEnv): Promise<void>;
}

export interface BillingProviderEnv {
  LEMON_SQUEEZY_API_KEY: string;
  LEMON_SQUEEZY_STORE_ID_PROD: string;
  LEMON_SQUEEZY_STORE_ID_TEST: string;
  LEMON_SQUEEZY_VARIANT_CREDITS: string;  // JSON: {"12345":5000,...}
  STRIPE_SECRET_KEY?: string;
  BILLING_PROVIDER: BillingProviderName;
  ENVIRONMENT: 'production' | 'staging' | 'development';
}
```

Also export: `VariantCreditMap` type, `parseVariantCredits(json: string): VariantCreditMap` helper.
Generate the complete file.
