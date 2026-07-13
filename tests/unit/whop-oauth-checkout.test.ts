import { describe, it, expect, afterEach } from "vitest";
import {
  createOrGetAccessPass,
  createWhopOAuthPlan,
  createWhopOAuthCheckoutLink,
  createWhopOAuthCheckout,
} from "../../packages/billing-core/src/providers/whop-oauth-checkout.js";

// Whop OAuth-delegated checkout — a business's OWN connected Whop company creates plans/checkout
// links for its own end-user subscriptions/credit-packs (AUDIT_TODO.md AI-7 pivot), using the
// business's own vaulted OAuth access token, never Naelao's key.

interface Call { url: string; headers: Record<string, string>; body: unknown }
let calls: Call[] = [];
const realFetch = globalThis.fetch;

function mockFetch(responses: Record<string, unknown>) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).forEach((v, k) => { headers[k] = v; });
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, headers, body });
    for (const [path, resp] of Object.entries(responses)) {
      if (url.includes(path)) return new Response(JSON.stringify(resp), { status: 200 });
    }
    return new Response(JSON.stringify({ error: `unmocked ${url}` }), { status: 500 });
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  calls = [];
});

describe("createOrGetAccessPass", () => {
  it("creates a hidden access pass with a Bearer token from the caller's own OAuth access token", async () => {
    mockFetch({ "/access_passes": { id: "ap_1" } });
    const result = await createOrGetAccessPass("biz-oauth-token", { title: "Business Subscription" });
    expect(result.access_pass_id).toBe("ap_1");
    expect(calls[0]!.headers["authorization"]).toBe("Bearer biz-oauth-token");
    expect((calls[0]!.body as { visibility: string }).visibility).toBe("hidden");
  });

  it("reuses an existing access pass id without calling the API", async () => {
    const result = await createOrGetAccessPass("tok", { title: "x", existingAccessPassId: "ap_existing" });
    expect(result.access_pass_id).toBe("ap_existing");
    expect(calls).toHaveLength(0);
  });

  it("throws a clear error when Whop returns no id", async () => {
    mockFetch({ "/access_passes": {} });
    await expect(createOrGetAccessPass("tok", { title: "x" })).rejects.toThrow(/no id/);
  });
});

describe("createWhopOAuthPlan", () => {
  it("creates a renewal plan with the billing_period in days", async () => {
    mockFetch({ "/plans": { id: "plan_1" } });
    const result = await createWhopOAuthPlan("tok", {
      accessPassId: "ap_1", priceCents: 2900, billingModel: "renewal", billingPeriodDays: 30,
    });
    expect(result.plan_id).toBe("plan_1");
    const body = calls[0]!.body as { plan_type: string; billing_period: number; initial_price: number };
    expect(body.plan_type).toBe("renewal");
    expect(body.billing_period).toBe(30);
    expect(body.initial_price).toBe(29);
  });

  it("creates a one_time plan without a billing_period", async () => {
    mockFetch({ "/plans": { id: "plan_pack" } });
    await createWhopOAuthPlan("tok", { accessPassId: "ap_1", priceCents: 500, billingModel: "one_time" });
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body["plan_type"]).toBe("one_time");
    expect(body["billing_period"]).toBeUndefined();
  });
});

describe("createWhopOAuthCheckoutLink", () => {
  it("returns the checkout url, preferring checkout_url over other field names", async () => {
    mockFetch({ "/checkout_configurations": { checkout_url: "https://whop.com/checkout/abc", url: "https://ignored" } });
    const result = await createWhopOAuthCheckoutLink("tok", { planId: "plan_1" });
    expect(result.checkout_url).toBe("https://whop.com/checkout/abc");
  });

  it("falls back to purchase_url/url when checkout_url is absent", async () => {
    mockFetch({ "/checkout_configurations": { url: "https://whop.com/checkout/xyz" } });
    const result = await createWhopOAuthCheckoutLink("tok", { planId: "plan_1" });
    expect(result.checkout_url).toBe("https://whop.com/checkout/xyz");
  });

  it("throws when no url is returned at all", async () => {
    mockFetch({ "/checkout_configurations": {} });
    await expect(createWhopOAuthCheckoutLink("tok", { planId: "plan_1" })).rejects.toThrow(/did not include/);
  });
});

describe("createWhopOAuthCheckout (one-shot convenience)", () => {
  it("chains access_pass -> plan -> checkout_configuration, all authenticated with the SAME business token", async () => {
    mockFetch({
      "/access_passes": { id: "ap_biz" },
      "/plans": { id: "plan_biz" },
      "/checkout_configurations": { checkout_url: "https://whop.com/checkout/final" },
    });
    const result = await createWhopOAuthCheckout("biz-token", {
      title: "Pro Plan", priceCents: 2900, billingModel: "renewal", billingPeriodDays: 30,
      redirectUrl: "https://shop.example.com/thanks", customerEmail: "buyer@example.com",
      metadata: { kind: "business_subscription", plan_id: "pro" },
    });
    expect(result.checkout_url).toBe("https://whop.com/checkout/final");
    expect(calls).toHaveLength(3);
    for (const call of calls) expect(call.headers["authorization"]).toBe("Bearer biz-token");
    const checkoutBody = calls[2]!.body as { plan_id: string; redirect_url: string; prefill_email: string; metadata: Record<string, string> };
    expect(checkoutBody.plan_id).toBe("plan_biz");
    expect(checkoutBody.redirect_url).toBe("https://shop.example.com/thanks");
    expect(checkoutBody.prefill_email).toBe("buyer@example.com");
    expect(checkoutBody.metadata).toMatchObject({ kind: "business_subscription", plan_id: "pro" });
  });
});
