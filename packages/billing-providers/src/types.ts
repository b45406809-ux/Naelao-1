export type BillingProviderName = 'lemon_squeezy' | 'stripe';

export type NormalizedEventType =
  | 'payment.success'
  | 'payment.failed'
  | 'subscription.created'
  | 'subscription.updated'
  | 'subscription.cancelled'
  | 'subscription.paused'
  | 'subscription.resumed'
  | 'refund.issued';

export interface NormalizedBillingEvent {
  type: NormalizedEventType;
  provider: BillingProviderName;
  spaceId: string;
  customerId: string;
  subscriptionId: string | null;
  variantOrPriceId: string;
  amountCents: number;
  currency: string;
  portalUrl?: string;
  rawEventId: string;
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
  LEMON_SQUEEZY_VARIANT_CREDITS: string;
  STRIPE_SECRET_KEY?: string;
  BILLING_PROVIDER: BillingProviderName;
  ENVIRONMENT: 'production' | 'staging' | 'development';
}

export type VariantCreditMap = Record<string, number>;

export function parseVariantCredits(json: string): VariantCreditMap {
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    const result: VariantCreditMap = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'number') result[k] = v;
    }
    return result;
  } catch {
    return {};
  }
}
