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

const LS_EVENT_MAP: Record<string, NormalizedEventType> = {
  order_created: 'payment.success',
  order_refunded: 'refund.issued',
  subscription_created: 'subscription.created',
  subscription_updated: 'subscription.updated',
  subscription_cancelled: 'subscription.cancelled',
  subscription_paused: 'subscription.paused',
  subscription_unpaused: 'subscription.resumed',
  subscription_payment_success: 'payment.success',
  subscription_payment_failed: 'payment.failed',
  subscription_payment_recovered: 'payment.success',
};

export class LemonSqueezyProvider implements BillingProvider {
  readonly name = 'lemon_squeezy' as const;

  async verifyWebhook(rawBody: string, headers: Headers, secret: string): Promise<boolean> {
    const signature = headers.get('X-Signature') ?? '';
    if (!signature) return false;

    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const expected = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
    const expectedHex = [...new Uint8Array(expected)]
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    return timingSafeEqual(signature, expectedHex);
  }

  parseWebhookEvent(rawBody: string): NormalizedBillingEvent {
    const payload = JSON.parse(rawBody) as Record<string, unknown>;
    const meta = payload['meta'] as { event_name: string; custom_data?: { spaceId?: string } };
    const data = payload['data'] as {
      id: string;
      attributes: {
        identifier?: string;
        total?: string;
        currency?: string;
        customer_id?: number;
        first_order_item?: { variant_id: number };
        variant_id?: number;
        urls?: { customer_portal?: string };
        custom_data?: { spaceId?: string };
      };
    };

    const eventName = meta.event_name;
    const normalized = LS_EVENT_MAP[eventName];
    if (!normalized) {
      throw new Error('unknown_event_type: ' + eventName);
    }

    const attrs = data.attributes;
    const spaceId =
      meta.custom_data?.spaceId ??
      attrs.custom_data?.spaceId ??
      '';

    const amountStr = attrs.total ?? '0';
    const amountCents = parseInt(amountStr, 10);

    const variantId =
      attrs.first_order_item?.variant_id?.toString() ??
      attrs.variant_id?.toString() ??
      '';

    return {
      type: normalized,
      provider: 'lemon_squeezy',
      spaceId,
      customerId: attrs.customer_id?.toString() ?? '',
      subscriptionId: data.id ?? null,
      variantOrPriceId: variantId,
      amountCents,
      currency: attrs.currency ?? 'USD',
      portalUrl: attrs.urls?.customer_portal,
      rawEventId: data.id,
    };
  }

  async createCheckout(params: CheckoutParams, env: BillingProviderEnv): Promise<{ url: string }> {
    const storeId =
      env.ENVIRONMENT === 'production'
        ? env.LEMON_SQUEEZY_STORE_ID_PROD
        : env.LEMON_SQUEEZY_STORE_ID_TEST;

    const body = {
      data: {
        type: 'checkouts',
        attributes: {
          checkout_data: {
            custom: { spaceId: params.spaceId },
            email: params.customerEmail,
          },
          checkout_options: {},
          product_options: {
            redirect_url: params.successUrl,
          },
        },
        relationships: {
          store: { data: { type: 'stores', id: storeId } },
          variant: { data: { type: 'variants', id: params.planVariantOrPriceId } },
        },
      },
    };

    const resp = await fetch('https://api.lemonsqueezy.com/v1/checkouts', {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.api+json',
        'Content-Type': 'application/vnd.api+json',
        Authorization: `Bearer ${env.LEMON_SQUEEZY_API_KEY}`,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      throw new Error('lemon_squeezy_checkout_failed: ' + resp.status);
    }

    const result = (await resp.json()) as { data: { attributes: { url: string } } };
    return { url: result.data.attributes.url };
  }

  async getCustomerPortalUrl(subscriptionId: string, env: BillingProviderEnv): Promise<string> {
    const resp = await fetch(
      `https://api.lemonsqueezy.com/v1/subscriptions/${subscriptionId}`,
      {
        headers: {
          Accept: 'application/vnd.api+json',
          Authorization: `Bearer ${env.LEMON_SQUEEZY_API_KEY}`,
        },
      }
    );

    if (!resp.ok) {
      throw new Error('lemon_squeezy_portal_fetch_failed: ' + resp.status);
    }

    const result = (await resp.json()) as {
      data: { attributes: { urls: { customer_portal: string } } };
    };
    return result.data.attributes.urls.customer_portal;
  }

  async cancelSubscription(subscriptionId: string, env: BillingProviderEnv): Promise<void> {
    const resp = await fetch(
      `https://api.lemonsqueezy.com/v1/subscriptions/${subscriptionId}`,
      {
        method: 'DELETE',
        headers: {
          Accept: 'application/vnd.api+json',
          Authorization: `Bearer ${env.LEMON_SQUEEZY_API_KEY}`,
        },
      }
    );

    if (!resp.ok) {
      throw new Error('lemon_squeezy_cancel_failed: ' + resp.status);
    }
  }
}
