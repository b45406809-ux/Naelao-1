import type {
  BillingProvider,
  BillingProviderEnv,
  CheckoutParams,
  NormalizedBillingEvent,
  NormalizedEventType,
} from './types';

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= (a.charCodeAt(i) ?? 0) ^ (b.charCodeAt(i) ?? 0);
  }
  return result === 0;
}

const STRIPE_EVENT_MAP: Record<string, NormalizedEventType> = {
  'checkout.session.completed': 'payment.success',
  'invoice.payment_succeeded': 'payment.success',
  'invoice.payment_failed': 'payment.failed',
  'customer.subscription.created': 'subscription.created',
  'customer.subscription.updated': 'subscription.updated',
  'customer.subscription.deleted': 'subscription.cancelled',
  'charge.refunded': 'refund.issued',
};

export class StripeProvider implements BillingProvider {
  readonly name = 'stripe' as const;

  async verifyWebhook(rawBody: string, headers: Headers, secret: string): Promise<boolean> {
    const sigHeader = headers.get('Stripe-Signature') ?? '';
    if (!sigHeader) return false;

    const parts = Object.fromEntries(
      sigHeader.split(',').map(p => {
        const [k, ...v] = p.split('=');
        return [k, v.join('=')];
      })
    );

    const timestamp = parts['t'] ?? '';
    const v1Sig = parts['v1'] ?? '';

    if (!timestamp || !v1Sig) return false;

    const ts = parseInt(timestamp, 10);
    if (Math.abs(Date.now() / 1000 - ts) > 300) return false;

    const payload = `${timestamp}.${rawBody}`;
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const expected = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
    const expectedHex = [...new Uint8Array(expected)]
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    return timingSafeEqual(v1Sig, expectedHex);
  }

  parseWebhookEvent(rawBody: string): NormalizedBillingEvent {
    const event = JSON.parse(rawBody) as {
      id: string;
      type: string;
      data: {
        object: {
          id: string;
          customer?: string;
          subscription?: string;
          metadata?: { spaceId?: string };
          subscription_details?: { metadata?: { spaceId?: string } };
          amount_refunded?: number;
          amount?: number;
          currency?: string;
          plan?: { id: string };
        };
      };
    };

    const normalized = STRIPE_EVENT_MAP[event.type];
    if (!normalized) {
      throw new Error('unknown_event_type: ' + event.type);
    }

    const obj = event.data.object;
    const spaceId =
      obj.metadata?.spaceId ??
      obj.subscription_details?.metadata?.spaceId ??
      '';

    return {
      type: normalized,
      provider: 'stripe',
      spaceId,
      customerId: obj.customer ?? '',
      subscriptionId: obj.subscription ?? null,
      variantOrPriceId: obj.plan?.id ?? '',
      amountCents: obj.amount_refunded ?? obj.amount ?? 0,
      currency: obj.currency ?? 'usd',
      rawEventId: event.id,
    };
  }

  async createCheckout(params: CheckoutParams, env: BillingProviderEnv): Promise<{ url: string }> {
    if (!env.STRIPE_SECRET_KEY) {
      throw new Error('stripe not configured');
    }

    const body = new URLSearchParams({
      'line_items[0][price]': params.planVariantOrPriceId,
      'line_items[0][quantity]': '1',
      mode: 'subscription',
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
      'metadata[spaceId]': params.spaceId,
    });

    if (params.customerEmail) {
      body.set('customer_email', params.customerEmail);
    }

    const resp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    if (!resp.ok) {
      throw new Error('stripe_checkout_failed: ' + resp.status);
    }

    const result = (await resp.json()) as { url: string };
    return { url: result.url };
  }

  async getCustomerPortalUrl(customerId: string, env: BillingProviderEnv): Promise<string> {
    if (!env.STRIPE_SECRET_KEY) {
      throw new Error('stripe not configured');
    }

    const body = new URLSearchParams({ customer: customerId });

    const resp = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    if (!resp.ok) {
      throw new Error('stripe_portal_failed: ' + resp.status);
    }

    const result = (await resp.json()) as { url: string };
    return result.url;
  }

  async cancelSubscription(subscriptionId: string, env: BillingProviderEnv): Promise<void> {
    if (!env.STRIPE_SECRET_KEY) {
      throw new Error('stripe not configured');
    }

    const resp = await fetch(`https://api.stripe.com/v1/subscriptions/${subscriptionId}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      },
    });

    if (!resp.ok) {
      throw new Error('stripe_cancel_failed: ' + resp.status);
    }
  }
}
