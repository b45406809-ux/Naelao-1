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
import { readBoundedResponseJson } from "@naelao/http";

const LS_API = "https://api.lemonsqueezy.com/v1";
const MAX_LS_PROVIDER_RESPONSE_BYTES = 256 * 1024;
const LS_PROVIDER_TIMEOUT_MS = 15_000;

async function readLsJson<T>(response: Response, operation: string): Promise<T> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Lemon Squeezy ${operation} failed: ${response.status}`);
  }
  try {
    return await readBoundedResponseJson<T>(response, MAX_LS_PROVIDER_RESPONSE_BYTES);
  } catch {
    throw new Error(`Lemon Squeezy ${operation} returned an invalid or oversized response`);
  }
}

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
  // A subscription that actually ENDED (grace period over). Previously unmapped — parseWebhookEvent
  // threw "Unmapped Lemon Squeezy event" and the webhook 200-skipped it, so an expired subscription
  // silently kept its paid tier forever (business subscriptions AND builder platform plans).
  subscription_expired: "subscription.expired",
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
    const isSubscriptionPayment = eventName.startsWith("subscription_payment_");
    const amountCents = parseInt(String(attrs["total"] ?? attrs["total_usd"] ?? "0"), 10) || 0;

    const providerStatus = !isOrder && attrs["status"] ? String(attrs["status"]) : null;
    const currentPeriodEnd = !isOrder && (attrs["renews_at"] ?? attrs["ends_at"]) ? String(attrs["renews_at"] ?? attrs["ends_at"]) : null;

    return {
      type,
      provider: "lemon_squeezy",
      spaceId,
      customerId: String(attrs["customer_id"] ?? ""),
      subscriptionId: isOrder ? (attrs["subscription_id"] ? String(attrs["subscription_id"]) : null)
        : isSubscriptionPayment ? String(attrs["subscription_id"] ?? event.data?.id ?? "") || null
        : (event.data?.id ?? null),
      // S0.3: previously discarded for order events (only kept for subscriptions) — this is the
      // real, stable LS event/resource id and must survive for BOTH kinds so it can serve as the
      // canonical idempotency key (webhook dedup + order recording), not a synthetic derived one.
      // Payment webhooks can reference the long-lived subscription resource as data.id.
      // Prefer the captured order/payment/invoice id when the provider includes one; updated_at
      // is a stable per-resource event discriminator on retries. Without either, the caller hashes
      // the complete raw event body instead of treating the subscription id as a payment id.
      providerEventId: isSubscriptionPayment
        ? String(attrs["order_id"] ?? attrs["payment_id"] ?? attrs["invoice_id"] ??
          (attrs["updated_at"] ? `${event.data?.id ?? "subscription"}:${eventName}:${attrs["updated_at"]}` : "")) || null
        : event.data?.id ?? null,
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
      signal: AbortSignal.timeout(LS_PROVIDER_TIMEOUT_MS),
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
    const json = await readLsJson<{ data?: { attributes?: { url?: string } } }>(resp, "checkout");
    const url = json.data?.attributes?.url;
    if (typeof url !== "string" || url.length > 2048 || new URL(url).protocol !== "https:") throw new Error("Lemon Squeezy checkout returned an invalid url");
    return { url };
  }

  async getCustomerPortalUrl(subscriptionId: string): Promise<string> {
    const apiKey = this.env.LEMON_SQUEEZY_API_KEY;
    if (!apiKey) throw new Error("Lemon Squeezy not configured");
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(subscriptionId)) throw new Error("Invalid Lemon Squeezy subscription ID");
    const resp = await fetch(`${LS_API}/subscriptions/${encodeURIComponent(subscriptionId)}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/vnd.api+json" },
      signal: AbortSignal.timeout(LS_PROVIDER_TIMEOUT_MS),
    });
    const json = await readLsJson<{
      data?: { attributes?: { urls?: { customer_portal?: string } } };
    }>(resp, "subscription fetch");
    const url = json.data?.attributes?.urls?.customer_portal;
    if (typeof url !== "string" || url.length > 2048 || new URL(url).protocol !== "https:") throw new Error("Invalid customer portal URL");
    return url;
  }

  async cancelSubscription(subscriptionId: string): Promise<void> {
    const apiKey = this.env.LEMON_SQUEEZY_API_KEY;
    if (!apiKey) throw new Error("Lemon Squeezy not configured");
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(subscriptionId)) throw new Error("Invalid Lemon Squeezy subscription ID");
    const resp = await fetch(`${LS_API}/subscriptions/${encodeURIComponent(subscriptionId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/vnd.api+json" },
      signal: AbortSignal.timeout(LS_PROVIDER_TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error(`Lemon Squeezy cancel failed: ${resp.status}`);
  }
}

// ── Wallet Connect helpers (builder-owned LS stores) ────────────────────────────────────────────
// LS has NO OAuth and NO create-store API — the connect flow is guided BYO: verify the builder's
// own API key by listing the stores it can see, let them pick one, then auto-create a webhook on
// THEIR store (LS's POST /v1/webhooks is real) pointing back at Naelao with a generated
// per-connection signing secret. The key itself lives encrypted in the credentials vault, never
// in D1 plaintext and never in an agent isolate.

export interface LsStoreSummary {
  id: string;
  name: string;
  url: string;
}

/** Verify an API key by listing its stores. Throws on a bad key (401/403). */
export async function lsListStores(apiKey: string): Promise<LsStoreSummary[]> {
  const resp = await fetch(`${LS_API}/stores`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/vnd.api+json" },
    signal: AbortSignal.timeout(LS_PROVIDER_TIMEOUT_MS),
  });
  const json = await readLsJson<{
    data?: Array<{ id?: string; attributes?: { name?: string; url?: string } }>;
  }>(resp, "store list");
  return (json.data ?? []).map((store) => ({
    id: String(store.id ?? ""),
    name: String(store.attributes?.name ?? ""),
    url: String(store.attributes?.url ?? ""),
  }));
}

/** Events a wallet-connection webhook subscribes to (mirror of EVENT_MAP's keys). */
const LS_WALLET_WEBHOOK_EVENTS = Object.keys(EVENT_MAP);

/** Create a webhook on the builder's own store; returns the LS webhook id (for later cleanup). */
export async function lsCreateWebhook(
  apiKey: string,
  storeId: string,
  url: string,
  secret: string
): Promise<{ id: string }> {
  const resp = await fetch(`${LS_API}/webhooks`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/vnd.api+json",
      Accept: "application/vnd.api+json",
    },
    signal: AbortSignal.timeout(LS_PROVIDER_TIMEOUT_MS),
    body: JSON.stringify({
      data: {
        type: "webhooks",
        attributes: { url, secret, events: LS_WALLET_WEBHOOK_EVENTS },
        relationships: { store: { data: { type: "stores", id: storeId } } },
      },
    }),
  });
  const json = await readLsJson<{ data?: { id?: string } }>(resp, "webhook create");
  const id = json.data?.id;
  if (!id) throw new Error("Lemon Squeezy webhook create returned no id");
  return { id: String(id) };
}

/** Best-effort webhook deletion on disconnect (never blocks the disconnect itself). */
export async function lsDeleteWebhook(apiKey: string, webhookId: string): Promise<void> {
  const resp = await fetch(`${LS_API}/webhooks/${encodeURIComponent(webhookId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/vnd.api+json" },
    signal: AbortSignal.timeout(LS_PROVIDER_TIMEOUT_MS),
  });
  if (!resp.ok && resp.status !== 404) {
    throw new Error(`Lemon Squeezy webhook delete failed: ${resp.status}`);
  }
}
