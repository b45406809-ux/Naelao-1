/**
 * Lemon Squeezy billing provider (spec Appendix H) — the PRIMARY provider.
 *
 * Event mapping (spec):
 *   order_created                → payment.success
 *   order_refunded               → refund.issued
 *   subscription_created         → subscription.created
 *   subscription_updated         → subscription.updated
 *   subscription_cancelled       → subscription.cancelled
 *   subscription_paused          → subscription.paused
 *   subscription_unpaused        → subscription.resumed
 *   subscription_payment_success → payment.success
 *   subscription_payment_failed  → payment.failed
 *   subscription_payment_recovered → payment.success
 *
 * spaceId path: order events → event.meta.custom_data.spaceId;
 *               subscription events → event.data.attributes.custom_data.spaceId.
 * Amount: parseInt(attributes.total, 10) — cents, integer, NEVER parseFloat.
 */

import type {
  BillingProvider,
  BillingProviderEnv,
  CheckoutParams,
  NormalizedBillingEvent,
} from "./types.js";

const LS_API = "https://api.lemonsqueezy.com/v1";

const EVENT_MAP: Record<string, NormalizedBillingEvent["type"]> = {
  order_created: "payment.success",
  order_refunded: "refund.issued",
  subscription_created: "subscription.created",
  subscription_updated: "subscription.updated",
  subscription_cancelled: "subscription.cancelled",
  subscription_paused: "subscription.paused",
  subscription_unpaused: "subscription.resumed",
  subscription_payment_success: "payment.success",
  subscription_payment_failed: "payment.failed",
  subscription_payment_recovered: "payment.success",
};

/** Constant-time hex compare to avoid signature timing leaks. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export class LemonSqueezyProvider implements BillingProvider {
  readonly name = "lemon_squeezy" as const;

  constructor(private readonly env: BillingProviderEnv) {}

  /** Verify the X-Signature header: HMAC-SHA256(rawBody, webhookSecret) as hex. */
  async verifyWebhook(rawBody: string, headers: Headers): Promise<boolean> {
    const secret = this.env.LEMON_SQUEEZY_WEBHOOK_SECRET;
    const signature = headers.get("X-Signature") ?? headers.get("x-signature");
    if (!secret || !signature) return false;

    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
    const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return timingSafeEqualHex(expected, signature.trim().toLowerCase());
  }

  parseWebhookEvent(rawBody: string): NormalizedBillingEvent {
    const event = JSON.parse(rawBody) as {
      meta?: { event_name?: string; custom_data?: Record<string, string> };
      data?: {
        id?: string;
        attributes?: Record<string, unknown> & { custom_data?: Record<string, string> };
      };
    };

    const eventName = event.meta?.event_name ?? "";
    const type = EVENT_MAP[eventName];
    if (!type) throw new Error(`Unmapped Lemon Squeezy event: ${eventName}`);

    const attrs = event.data?.attributes ?? {};
    // spaceId comes from meta.custom_data (orders) or attributes.custom_data (subscriptions).
    const spaceId =
      event.meta?.custom_data?.["spaceId"] ?? attrs.custom_data?.["spaceId"] ?? "";

    const isOrder = eventName.startsWith("order_");
    const amountCents = parseInt(String(attrs["total"] ?? attrs["total_usd"] ?? "0"), 10) || 0;

    const providerStatus = !isOrder && attrs["status"] ? String(attrs["status"]) : null;
    const currentPeriodEnd = !isOrder && (attrs["renews_at"] ?? attrs["ends_at"]) ? String(attrs["renews_at"] ?? attrs["ends_at"]) : null;

    return {
      type,
      provider: "lemon_squeezy",
      spaceId,
      customerId: String(attrs["customer_id"] ?? ""),
      subscriptionId: isOrder ? null : (event.data?.id ?? null),
      // S0.3: previously discarded for order events (only kept for subscriptions) — this is the
      // real, stable LS event/resource id and must survive for BOTH kinds so it can serve as the
      // canonical idempotency key (webhook dedup + order recording), not a synthetic derived one.
      providerEventId: event.data?.id ?? null,
      variantOrPriceId: String(attrs["variant_id"] ?? attrs["first_order_item"] ?? ""),
      amountCents,
      currency: String(attrs["currency"] ?? "USD"),
      metadata: event.meta?.custom_data ?? attrs.custom_data ?? {},
      ...(providerStatus ? { providerStatus } : {}),
      ...(currentPeriodEnd ? { currentPeriodEnd } : {}),
    };
  }

  async createCheckout(params: CheckoutParams): Promise<{ url: string }> {
    const apiKey = this.env.LEMON_SQUEEZY_API_KEY;
    const storeId = this.env.LEMON_SQUEEZY_STORE_ID;
    if (!apiKey || !storeId) throw new Error("Lemon Squeezy not configured (API key / store id)");

    const resp = await fetch(`${LS_API}/checkouts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/vnd.api+json",
        Accept: "application/vnd.api+json",
      },
      body: JSON.stringify({
        data: {
          type: "checkouts",
          attributes: {
            checkout_data: {
              email: params.customerEmail,
              custom: { spaceId: params.spaceId, ...(params.metadata ?? {}) },
              // LS's documented "pay what you want" override — only takes effect when the
              // variant itself is configured for custom pricing in the store dashboard; a normal
              // fixed-price variant ignores this field rather than erroring, so this is safe to
              // always include when set.
              ...(params.customPriceCents !== undefined ? { custom_price: params.customPriceCents } : {}),
            },
            ...(params.successUrl ? { product_options: { redirect_url: params.successUrl } } : {}),
          },
          relationships: {
            store: { data: { type: "stores", id: storeId } },
            variant: { data: { type: "variants", id: params.variantOrPriceId } },
          },
        },
      }),
    });
    if (!resp.ok) throw new Error(`Lemon Squeezy checkout failed: ${resp.status}`);
    const json = (await resp.json()) as { data?: { attributes?: { url?: string } } };
    const url = json.data?.attributes?.url;
    if (!url) throw new Error("Lemon Squeezy checkout returned no url");
    return { url };
  }

  async getCustomerPortalUrl(subscriptionId: string): Promise<string> {
    const apiKey = this.env.LEMON_SQUEEZY_API_KEY;
    if (!apiKey) throw new Error("Lemon Squeezy not configured");
    const resp = await fetch(`${LS_API}/subscriptions/${subscriptionId}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/vnd.api+json" },
    });
    if (!resp.ok) throw new Error(`Lemon Squeezy subscription fetch failed: ${resp.status}`);
    const json = (await resp.json()) as {
      data?: { attributes?: { urls?: { customer_portal?: string } } };
    };
    const url = json.data?.attributes?.urls?.customer_portal;
    if (!url) throw new Error("No customer portal url");
    return url;
  }

  async cancelSubscription(subscriptionId: string): Promise<void> {
    const apiKey = this.env.LEMON_SQUEEZY_API_KEY;
    if (!apiKey) throw new Error("Lemon Squeezy not configured");
    const resp = await fetch(`${LS_API}/subscriptions/${subscriptionId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/vnd.api+json" },
    });
    if (!resp.ok) throw new Error(`Lemon Squeezy cancel failed: ${resp.status}`);
  }
}
