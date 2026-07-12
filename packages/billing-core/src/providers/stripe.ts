/**
 * Stripe billing provider (spec Appendix H's "future addition", now real) — but ONLY as the
 * connected-account rail for Wallet Connect, never platform custody. Item 45's decision stands:
 * Naelao's own platform billing (builder plans, the platform LS store) is Lemon Squeezy ONLY.
 * Stripe enters exclusively as a per-space `payment_connections` row: Naelao holds one platform
 * integration key (universal-tools doctrine, like COMPOSIO_API_KEY), creates a FRESH Express
 * connected account for the builder (an isolated business account — never their personal one),
 * and checkouts are DIRECT CHARGES on that account with `application_fee_amount` as the platform
 * cut. Funds settle in the builder's own account; Stripe pays out to their bank; Naelao never
 * holds their money and has no debit capability (the integration surface is checkout creation,
 * account-status reads, and webhook receives — nothing else).
 *
 * Fetch-based (no Stripe SDK — CF Workers convention in this repo), form-encoded bodies.
 *
 * Event mapping:
 *   checkout.session.completed     → payment.success
 *   invoice.payment_failed         → payment.failed
 *   customer.subscription.created  → subscription.created
 *   customer.subscription.updated  → subscription.updated
 *   customer.subscription.deleted  → subscription.cancelled
 *   charge.refunded                → refund.issued
 *
 * spaceId path: object.metadata.spaceId (we set it on every checkout we create).
 * The Connect event's top-level `account` (which connected account it happened on) is folded
 * into metadata.stripe_account so downstream code can resolve the payment_connections row.
 */

import type {
  BillingProvider,
  CheckoutParams,
  NormalizedBillingEvent,
} from "./types.js";

const STRIPE_API = "https://api.stripe.com/v1";

/** Default tolerance for webhook timestamp skew (Stripe's own recommended 5 minutes). */
const WEBHOOK_TOLERANCE_SECONDS = 300;

export interface StripeProviderOpts {
  /** Naelao's platform secret key (sk_...). */
  secretKey: string;
  /** Webhook signing secret (whsec_...) for the Connect webhook endpoint. */
  webhookSecret?: string;
  /** Connected account to act on (direct charges). Absent = platform account (unused today). */
  stripeAccount?: string;
}

const EVENT_MAP: Record<string, NormalizedBillingEvent["type"]> = {
  "checkout.session.completed": "payment.success",
  "invoice.payment_failed": "payment.failed",
  "customer.subscription.created": "subscription.created",
  "customer.subscription.updated": "subscription.updated",
  "customer.subscription.deleted": "subscription.cancelled",
  "charge.refunded": "refund.issued",
};

/** Constant-time hex compare (same helper shape as the LS provider). */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Flatten a nested params object into Stripe's form-encoded bracket syntax. */
export function stripeFormEncode(params: Record<string, unknown>, prefix = ""): string[] {
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (typeof item === "object" && item !== null) {
          pairs.push(...stripeFormEncode(item as Record<string, unknown>, `${name}[${i}]`));
        } else {
          pairs.push(`${encodeURIComponent(`${name}[${i}]`)}=${encodeURIComponent(String(item))}`);
        }
      });
    } else if (typeof value === "object") {
      pairs.push(...stripeFormEncode(value as Record<string, unknown>, name));
    } else {
      pairs.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
    }
  }
  return pairs;
}

async function stripeRequest<T>(
  opts: { secretKey: string; stripeAccount?: string },
  method: "GET" | "POST" | "DELETE",
  path: string,
  params?: Record<string, unknown>
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.secretKey}`,
    // Direct charges / connected-account actions: Stripe routes the call to the connected
    // account. Never set for platform-account calls (account create, account links, status).
    ...(opts.stripeAccount ? { "Stripe-Account": opts.stripeAccount } : {}),
  };
  let url = `${STRIPE_API}${path}`;
  let body: string | undefined;
  if (params && method === "GET") {
    const qs = stripeFormEncode(params).join("&");
    if (qs) url += `?${qs}`;
  } else if (params) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = stripeFormEncode(params).join("&");
  }
  const resp = await fetch(url, { method, headers, ...(body !== undefined ? { body } : {}) });
  if (!resp.ok) {
    // Surface Stripe's own error message (bounded) — these are actionable ("account cannot
    // accept charges yet"), and this path never carries secrets.
    const text = (await resp.text().catch(() => "")).slice(0, 300);
    throw new Error(`Stripe ${method} ${path} failed: ${resp.status} ${text}`);
  }
  return (await resp.json()) as T;
}

export class StripeProvider implements BillingProvider {
  readonly name = "stripe" as const;

  constructor(private readonly opts: StripeProviderOpts) {}

  /** Verify the Stripe-Signature header: HMAC-SHA256(`${t}.${rawBody}`, whsec) vs any v1=. */
  async verifyWebhook(rawBody: string, headers: Headers): Promise<boolean> {
    const secret = this.opts.webhookSecret;
    const header = headers.get("Stripe-Signature") ?? headers.get("stripe-signature");
    if (!secret || !header) return false;

    let timestamp = "";
    const candidates: string[] = [];
    for (const part of header.split(",")) {
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      const k = part.slice(0, eq).trim();
      const v = part.slice(eq + 1).trim();
      if (k === "t") timestamp = v;
      else if (k === "v1" && v) candidates.push(v.toLowerCase());
    }
    if (!timestamp || candidates.length === 0) return false;

    const ts = parseInt(timestamp, 10);
    if (!Number.isFinite(ts)) return false;
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSeconds - ts) > WEBHOOK_TOLERANCE_SECONDS) return false;

    const expected = await hmacSha256Hex(secret, `${timestamp}.${rawBody}`);
    return candidates.some((candidate) => timingSafeEqualHex(expected, candidate));
  }

  parseWebhookEvent(rawBody: string): NormalizedBillingEvent {
    const event = JSON.parse(rawBody) as {
      id?: string;
      type?: string;
      /** Present on Connect events: which connected account this happened on. */
      account?: string;
      data?: { object?: Record<string, unknown> & { metadata?: Record<string, string> } };
    };

    const eventType = event.type ?? "";
    const type = EVENT_MAP[eventType];
    if (!type) throw new Error(`Unmapped Stripe event: ${eventType}`);

    const obj = event.data?.object ?? {};
    const metadata: Record<string, string> = { ...(obj.metadata ?? {}) };
    if (event.account) metadata["stripe_account"] = event.account;
    // The payment_intent is the ONE id shared between a checkout.session.completed event and the
    // later charge.refunded event for the same purchase (their evt_ ids never match) — carried so
    // order recording can key launchpad_orders on it and refund handling can find the order.
    if (obj["payment_intent"]) metadata["payment_intent"] = String(obj["payment_intent"]);

    const isSubscription = eventType.startsWith("customer.subscription.");
    // amount_total (checkout sessions), amount_refunded (charges), amount_due (invoices) — all
    // already integer cents in Stripe's API; never parseFloat.
    const amountCents =
      Number(obj["amount_total"] ?? obj["amount_refunded"] ?? obj["amount_due"] ?? 0) || 0;

    const providerStatus = isSubscription && obj["status"] ? String(obj["status"]) : null;
    const periodEndUnix = isSubscription ? Number(obj["current_period_end"] ?? 0) : 0;
    const currentPeriodEnd = periodEndUnix > 0 ? new Date(periodEndUnix * 1000).toISOString() : null;

    // First price id, when the object carries line items / a plan (best-effort — checkout
    // sessions created by us carry the ad-hoc price_data, so this is often empty).
    const items = (obj["items"] as { data?: Array<{ price?: { id?: string } }> } | undefined)?.data;
    const variantOrPriceId = String(items?.[0]?.price?.id ?? obj["price"] ?? "");

    return {
      type,
      provider: "stripe",
      spaceId: metadata["spaceId"] ?? "",
      customerId: String(obj["customer"] ?? ""),
      subscriptionId: isSubscription
        ? String(obj["id"] ?? "") || null
        : obj["subscription"]
          ? String(obj["subscription"])
          : null,
      providerEventId: event.id ?? null,
      variantOrPriceId,
      amountCents,
      currency: String(obj["currency"] ?? "usd").toUpperCase(),
      metadata,
      ...(providerStatus ? { providerStatus } : {}),
      ...(currentPeriodEnd ? { currentPeriodEnd } : {}),
    };
  }

  /**
   * One-off payment checkout via Checkout Sessions with ad-hoc price_data — Wallet Connect
   * checkouts never pre-provision Stripe Price objects (unlike the LS variant-provisioning
   * pattern), so `productName`/`currency`/`customPriceCents` carry the whole line item and
   * `variantOrPriceId` is ignored on this rail. When constructed with `stripeAccount`, this is a
   * DIRECT CHARGE on the connected account and `applicationFeeCents` is Naelao's auto-collected
   * platform cut.
   */
  async createCheckout(
    params: CheckoutParams & {
      productName?: string;
      currency?: string;
      applicationFeeCents?: number;
    }
  ): Promise<{ url: string }> {
    if (!this.opts.secretKey) throw new Error("Stripe not configured (secret key)");
    if (params.customPriceCents === undefined || params.customPriceCents <= 0) {
      throw new Error("Stripe checkout requires customPriceCents (ad-hoc price_data rail)");
    }

    const session = await stripeRequest<{ url?: string }>(
      this.opts,
      "POST",
      "/checkout/sessions",
      {
        mode: "payment",
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: (params.currency ?? "USD").toLowerCase(),
              unit_amount: params.customPriceCents,
              product_data: { name: params.productName ?? "Purchase" },
            },
          },
        ],
        ...(params.customerEmail ? { customer_email: params.customerEmail } : {}),
        ...(params.successUrl ? { success_url: params.successUrl } : {}),
        metadata: { spaceId: params.spaceId, ...(params.metadata ?? {}) },
        ...(params.applicationFeeCents && params.applicationFeeCents > 0
          ? { payment_intent_data: { application_fee_amount: params.applicationFeeCents } }
          : {}),
      }
    );
    if (!session.url) throw new Error("Stripe checkout returned no url");
    return { url: session.url };
  }

  async getCustomerPortalUrl(subscriptionId: string): Promise<string> {
    const sub = await stripeRequest<{ customer?: string }>(
      this.opts,
      "GET",
      `/subscriptions/${encodeURIComponent(subscriptionId)}`
    );
    if (!sub.customer) throw new Error("No customer on subscription");
    const portal = await stripeRequest<{ url?: string }>(
      this.opts,
      "POST",
      "/billing_portal/sessions",
      { customer: sub.customer }
    );
    if (!portal.url) throw new Error("No customer portal url");
    return portal.url;
  }

  async cancelSubscription(subscriptionId: string): Promise<void> {
    await stripeRequest(this.opts, "DELETE", `/subscriptions/${encodeURIComponent(subscriptionId)}`);
  }
}

// ── Connect account lifecycle helpers (platform-account calls; not on BillingProvider) ─────────

export interface StripeAccountStatus {
  id: string;
  details_submitted: boolean;
  charges_enabled: boolean;
  payouts_enabled: boolean;
}

/**
 * Create a FRESH Express connected account — the isolated business account. Deliberately never
 * an OAuth link to an existing (possibly personal) account: the whole point of the custody model
 * is that this account starts empty, holds only product revenue, and pays out to whatever bank
 * the builder gives Stripe during hosted onboarding (which Naelao never sees).
 */
export async function createExpressAccount(
  secretKey: string,
  params: { tenantId: string; spaceId: string; email?: string }
): Promise<{ id: string }> {
  return stripeRequest<{ id: string }>({ secretKey }, "POST", "/accounts", {
    type: "express",
    capabilities: {
      card_payments: { requested: "true" },
      transfers: { requested: "true" },
    },
    ...(params.email ? { email: params.email } : {}),
    metadata: { naelao_tenant_id: params.tenantId, naelao_space_id: params.spaceId },
  });
}

/** Stripe-hosted onboarding link (the "Sign in with Google"-style consent/permissions redirect). */
export async function createAccountLink(
  secretKey: string,
  accountId: string,
  refreshUrl: string,
  returnUrl: string
): Promise<{ url: string }> {
  const link = await stripeRequest<{ url?: string }>({ secretKey }, "POST", "/account_links", {
    account: accountId,
    refresh_url: refreshUrl,
    return_url: returnUrl,
    type: "account_onboarding",
  });
  if (!link.url) throw new Error("Stripe account link returned no url");
  return { url: link.url };
}

/**
 * Live account status. Per Stripe's own docs the onboarding return_url does NOT mean onboarding
 * finished — callers must poll this and only activate a connection on charges_enabled.
 */
export async function getAccountStatus(
  secretKey: string,
  accountId: string
): Promise<StripeAccountStatus> {
  const acct = await stripeRequest<{
    id: string;
    details_submitted?: boolean;
    charges_enabled?: boolean;
    payouts_enabled?: boolean;
  }>({ secretKey }, "GET", `/accounts/${encodeURIComponent(accountId)}`);
  return {
    id: acct.id,
    details_submitted: acct.details_submitted === true,
    charges_enabled: acct.charges_enabled === true,
    payouts_enabled: acct.payouts_enabled === true,
  };
}
