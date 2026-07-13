/**
 * Whop as the PLATFORM billing provider (builder Growth/Business plan checkout) — a replacement
 * for Lemon Squeezy's `/billing/checkout`/`/billing/portal`/webhook path specifically (item 45's
 * "Lemon Squeezy is the ONLY billing provider" was written when Stripe was the alternative being
 * removed; Whop is added here ALONGSIDE it, tried first, LS kept as a fallback for a deployment/
 * region where it works — see AUDIT_TODO.md AI-7).
 *
 * Distinct from BOTH other Whop integrations in this codebase:
 *   - `./whop.ts` (Platforms API, invite-only) — auto-provisions a sub-merchant company PER
 *     BUSINESS. Not used here at all.
 *   - `./whop-oauth-checkout.ts` — a BUSINESS's own connected Whop company (OAuth-delegated).
 *     Not used here either.
 * Here, Naelao itself is a normal Whop seller with its OWN company and its OWN master API key
 * (`WHOP_API_KEY`) — the same relationship any creator selling on Whop has, no invite needed.
 * Growth/Business plans are created ONCE in Naelao's own Whop company (like the LS variant ids
 * this mirrors), and a builder checks out against one of those two fixed plan ids.
 *
 * Whop has no API-mintable "customer portal" session the way Stripe/LS do — per Whop's own docs,
 * self-serve subscription management (cancel, update card, billing history) lives at a FIXED,
 * already-authenticated page (whop.com → Profile → Orders), not a per-customer generated link.
 * `WHOP_PLATFORM_ORDERS_URL` below defaults to that.
 *
 * VERIFY BEFORE PRODUCTION (same precedent as every other Whop integration point in this repo):
 * exact field names for plan/checkout creation and the webhook payload shape are Whop's
 * documented REST conventions, not confirmed against a live company/plan in this pass.
 */

import type { NormalizedBillingEvent } from "./types.js";

const WHOP_API = "https://api.whop.com/api/v5";

async function whopSellerRequest<T>(
  apiKey: string,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>
): Promise<T> {
  const resp = await fetch(`${WHOP_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await resp.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!resp.ok) {
    const detail = typeof json === "object" && json !== null ? JSON.stringify(json) : text;
    throw new Error(`Whop platform-plan ${method} ${path} failed: ${resp.status} ${detail}`.slice(0, 500));
  }
  return json as T;
}

function pick(obj: Record<string, unknown> | undefined, ...keys: string[]): string {
  if (!obj) return "";
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v) return v;
  }
  return "";
}

export interface WhopPlatformPlanCheckoutParams {
  planId: string;
  customerEmail?: string;
  redirectUrl?: string;
  metadata: Record<string, string>;
}

/** Create a checkout link against one of Naelao's own (already-created, fixed) Whop plan ids. */
export async function createWhopPlatformPlanCheckout(
  apiKey: string,
  params: WhopPlatformPlanCheckoutParams
): Promise<{ checkout_url: string }> {
  const result = await whopSellerRequest<Record<string, unknown>>(apiKey, "POST", "/checkout_configurations", {
    plan_id: params.planId,
    ...(params.redirectUrl ? { redirect_url: params.redirectUrl } : {}),
    ...(params.customerEmail ? { prefill_email: params.customerEmail } : {}),
    metadata: params.metadata,
  });
  const url = pick(result, "checkout_url", "purchase_url", "url");
  if (!url) throw new Error("Whop platform-plan checkout_configuration response did not include a checkout url");
  return { checkout_url: url };
}

/** Whop has no mintable per-customer portal session — a fixed, already-authenticated page. */
export const WHOP_CUSTOMER_ORDERS_URL = "https://whop.com/orders/";

// ── Webhook verification + parsing (mirrors ./whop.ts's HMAC scheme — same Whop-Signature
// header/hex-HMAC-SHA256 mechanism, but this reads Naelao's OWN company's webhook secret, a
// DIFFERENT secret than the per-business sub-merchant wallet webhook uses) ──

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

export async function verifyWhopPlatformPlanWebhook(
  rawBody: string,
  headers: Headers,
  webhookSecret: string
): Promise<boolean> {
  const header = headers.get("Whop-Signature") ?? headers.get("whop-signature");
  if (!header || !webhookSecret) return false;
  const expected = await hmacSha256Hex(webhookSecret, rawBody);
  return timingSafeEqualHex(expected, header.toLowerCase());
}

const STATUS_MAP: Record<string, NormalizedBillingEvent["type"]> = {
  "membership.went_valid": "subscription.created",
  "payment.succeeded": "payment.success",
};

/**
 * Parse a verified Whop platform-plan webhook into the SAME `NormalizedBillingEvent` shape
 * `recordPlatformPlanSubscription` (workers/billing/src/lemon-squeezy.ts) already consumes —
 * reused as-is (provider-agnostic logic; only the id-column choice branches on `provider`),
 * rather than duplicating that function's org/plan-tier-update logic for a second provider.
 * `metadata` is read from `data.metadata` (set at checkout time by `createWhopPlatformPlanCheckout`
 * — `{ kind: "platform_plan", org_id, plan }`, mirroring the LS checkout's own metadata shape).
 */
export function parseWhopPlatformPlanEvent(rawBody: string): NormalizedBillingEvent {
  const event = JSON.parse(rawBody) as {
    id?: string;
    event?: string;
    type?: string;
    data?: {
      id?: string;
      status?: string;
      final_amount?: number;
      amount?: number;
      currency?: string;
      metadata?: Record<string, string>;
      renewal_period_end?: string;
      plan_id?: string;
      membership_id?: string;
    };
  };
  const eventName = event.event ?? event.type ?? "";
  const data = event.data ?? {};

  let type: NormalizedBillingEvent["type"];
  if (eventName === "membership.went_invalid") {
    // Whop doesn't distinguish cancellation-vs-payment-failure vs plain expiry in this event —
    // mapSubscriptionStatus (lemon-squeezy.ts) falls back on providerStatus/type to decide;
    // "subscription.cancelled" is the conservative default (keeps paid tier until an explicit
    // expiry signal, matching the same grace-period posture the LS path already documents).
    type = "subscription.cancelled";
  } else {
    type = STATUS_MAP[eventName] ?? "payment.success";
  }

  return {
    type,
    provider: "whop",
    spaceId: String(data.metadata?.["org_id"] ?? ""),
    customerId: String(data.membership_id ?? data.id ?? ""),
    subscriptionId: data.plan_id ? String(data.plan_id) : null,
    providerEventId: event.id ?? null,
    variantOrPriceId: String(data.plan_id ?? ""),
    amountCents: Math.round(Number(data.final_amount ?? data.amount ?? 0)) || 0,
    currency: (data.currency ?? "usd").toUpperCase(),
    metadata: data.metadata ?? {},
    ...(data.status !== undefined ? { providerStatus: data.status } : {}),
    ...(data.renewal_period_end !== undefined ? { currentPeriodEnd: data.renewal_period_end } : {}),
  };
}
