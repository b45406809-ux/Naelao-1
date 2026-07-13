/**
 * Whop OAuth-delegated checkout — lets a business's OWN connected Whop company (via the
 * "Connect with Whop" OAuth2+PKCE flow, `connectors/oauth.ts` + catalogue.ts's `WHOP.oauth`)
 * create plans and checkout links for its own end-user subscriptions/credit-packs, WITHOUT
 * needing the invite-gated Whop Platforms/connected-accounts API (`./whop.ts`) or a Naelao
 * master API key.
 *
 * This is a THIRD, distinct Whop integration mode alongside:
 *   - `./whop.ts` — Naelao's ONE master Platforms API key, auto-provisions an isolated
 *     sub-merchant company per business (invite-only, not yet approved).
 *   - the generic OAuth mcp-connector (read-only: list_memberships, post_announcement, …) —
 *     Model A, deliberately no money-in ops.
 * Here, the business's OWN vaulted OAuth access token (never Naelao's) authenticates every call
 * — the checkout settles 100% into THAT business's own Whop balance. Naelao's platform cut is
 * NOT auto-split at checkout (a normal OAuth-scoped token has no payment-split primitive the way
 * the Platforms API does) — it is expected to reach the ledger via the existing revenue-tracker
 * prebuilt's periodic `list_payments` poll (workers/agents/src/script-engine/prebuilt/
 * revenue-tracker.ts), which already reports a business's total Whop revenue — a checkout created
 * here shows up there like any other Whop sale, so no separate fee-tracking mechanism is needed.
 *
 * VERIFY BEFORE PRODUCTION (same "defensive, unverified-shape" precedent as `./whop.ts` and
 * `revenue-tracker.ts`'s own headers — Whop's docs weren't exercised against a live OAuth-scoped
 * token in this pass): the exact multi-step shape (access_pass → plan → checkout_configuration)
 * and field names below are Whop's documented REST conventions as of this build
 * (docs.whop.com/api-reference/{plans,checkout-configurations}), not confirmed against a live
 * response. Confirm/narrow once a real Whop OAuth app is registered and a business has connected.
 */

const WHOP_API = "https://api.whop.com/api/v5";

async function whopOAuthRequest<T>(
  accessToken: string,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>
): Promise<T> {
  const resp = await fetch(`${WHOP_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
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
    throw new Error(`Whop OAuth ${method} ${path} failed: ${resp.status} ${detail}`.slice(0, 500));
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

/**
 * Create (or reuse, if `existingAccessPassId` is given) the "access pass" — Whop's product-level
 * container a plan attaches to. One per Naelao product-level offering (e.g. "Business
 * Subscription" or "Credit Pack") is created once and cached by the caller (billing worker), not
 * once per checkout.
 */
export async function createOrGetAccessPass(
  accessToken: string,
  params: { title: string; existingAccessPassId?: string }
): Promise<{ access_pass_id: string }> {
  if (params.existingAccessPassId) return { access_pass_id: params.existingAccessPassId };
  const result = await whopOAuthRequest<{ id?: string }>(accessToken, "POST", "/access_passes", {
    title: params.title,
    visibility: "hidden", // not listed on the company's public storefront — reached only via the direct checkout link
  });
  if (!result.id) throw new Error("Whop access_pass creation returned no id");
  return { access_pass_id: result.id };
}

export interface WhopOAuthPlanParams {
  accessPassId: string;
  priceCents: number;
  currency?: string;
  /** "renewal" for a recurring subscription (business_subscription), "one_time" for a credit pack. */
  billingModel: "renewal" | "one_time";
  /** Required when billingModel is "renewal" — Whop's billing_period is in days. */
  billingPeriodDays?: number;
}

/** Create a plan on the business's own access pass. Not cached/reused across calls — the caller
 *  (billing worker) is responsible for reusing a previously-created plan id for the same builder-
 *  configured plan/pack rather than minting a new Whop plan on every checkout. */
export async function createWhopOAuthPlan(
  accessToken: string,
  params: WhopOAuthPlanParams
): Promise<{ plan_id: string }> {
  const result = await whopOAuthRequest<{ id?: string }>(accessToken, "POST", "/plans", {
    access_pass_id: params.accessPassId,
    plan_type: params.billingModel,
    base_currency: (params.currency ?? "usd").toLowerCase(),
    initial_price: params.priceCents / 100,
    ...(params.billingModel === "renewal"
      ? { billing_period: params.billingPeriodDays ?? 30, release_method: "buy_now" }
      : { release_method: "buy_now" }),
  });
  if (!result.id) throw new Error("Whop plan creation returned no id");
  return { plan_id: result.id };
}

export interface WhopOAuthCheckoutParams {
  planId: string;
  redirectUrl?: string;
  customerEmail?: string;
  metadata?: Record<string, string>;
}

/** Create a checkout configuration + return its checkout URL — settles into the business's own
 *  Whop balance (never a Naelao-held one). */
export async function createWhopOAuthCheckoutLink(
  accessToken: string,
  params: WhopOAuthCheckoutParams
): Promise<{ checkout_url: string }> {
  const result = await whopOAuthRequest<Record<string, unknown>>(accessToken, "POST", "/checkout_configurations", {
    plan_id: params.planId,
    ...(params.redirectUrl ? { redirect_url: params.redirectUrl } : {}),
    ...(params.customerEmail ? { prefill_email: params.customerEmail } : {}),
    metadata: params.metadata ?? {},
  });
  const url = pick(result, "checkout_url", "purchase_url", "url");
  if (!url) throw new Error("Whop checkout_configuration response did not include a checkout url");
  return { checkout_url: url };
}

/**
 * One-shot convenience: access_pass → plan → checkout link, for a caller that doesn't want to
 * manage access-pass/plan reuse itself (accepts minting a fresh Whop plan per call — fine for a
 * first cut; a caller that wants one persistent plan per builder-configured pack should call the
 * three functions above directly and cache the ids).
 */
export async function createWhopOAuthCheckout(
  accessToken: string,
  params: {
    title: string;
    priceCents: number;
    currency?: string;
    billingModel: "renewal" | "one_time";
    billingPeriodDays?: number;
    redirectUrl?: string;
    customerEmail?: string;
    metadata?: Record<string, string>;
  }
): Promise<{ checkout_url: string }> {
  const { access_pass_id } = await createOrGetAccessPass(accessToken, { title: params.title });
  const { plan_id } = await createWhopOAuthPlan(accessToken, {
    accessPassId: access_pass_id,
    priceCents: params.priceCents,
    billingModel: params.billingModel,
    ...(params.currency !== undefined ? { currency: params.currency } : {}),
    ...(params.billingPeriodDays !== undefined ? { billingPeriodDays: params.billingPeriodDays } : {}),
  });
  return createWhopOAuthCheckoutLink(accessToken, {
    planId: plan_id,
    ...(params.redirectUrl !== undefined ? { redirectUrl: params.redirectUrl } : {}),
    ...(params.customerEmail !== undefined ? { customerEmail: params.customerEmail } : {}),
    ...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
  });
}
