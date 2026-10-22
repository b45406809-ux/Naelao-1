import { describe, it, expect, afterEach } from "vitest";
import billingWorker from "../../workers/billing/src/index.js";
import { mintInternalToken } from "@naelao/http";

// A personal plan is Naelao selling to an INDIVIDUAL, which is the platform-plan shape — so it
// belongs on Naelao's own Whop seller account, tried first, exactly like builder platform plans
// (whop-platform-plan.ts). It shipped LS-only, which is what the user flagged ("you used lemon
// squeezy for phase 4 aren't supposed to use whop payments").
//
// Deliberately NOT the business's-own-connected-Whop rail that credit-packs/wallet-topups take:
// that one settles into a business's revenue, which a personal plan is not.

const SECRET = "test-platform-secret";
const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

interface Call { url: string; body: unknown }
let calls: Call[] = [];
const realFetch = globalThis.fetch;

function mockOutbound(responses: Record<string, unknown>) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, body });
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

const PLAN = {
  id: "plus-monthly", name: "Plus", tier: "plus", priceCents: 900, interval: "month",
  whopPlanId: "plan_whop_plus", lsVariantId: "ls_var_plus",
};

function makeEnv(overrides: Record<string, unknown> = {}, plan: Record<string, unknown> = PLAN) {
  const db = {
    prepare() {
      const stmt = {
        bind() { return stmt; },
        async first() { return { tenant_id: "tenant-1" }; },
        async run() { return { meta: { changes: 1 } }; },
      };
      return stmt;
    },
  };
  const spacesWorker = {
    fetch: async () =>
      Response.json({ product_space_id: "prod-1", personal_plans: [plan] }),
  };
  return {
    ENVIRONMENT: "test",
    PLATFORM_SECRET: SECRET,
    PLATFORM_DB: db,
    SPACES_WORKER: spacesWorker,
    ...overrides,
  } as unknown as Parameters<typeof billingWorker.fetch>[1];
}

async function checkoutReq() {
  const token = await mintInternalToken(SECRET, "tenant-1");
  return new Request("https://billing.naelao.com/internal/personal-plan/checkout", {
    method: "POST",
    headers: { "content-type": "application/json", "x-naelao-internal-token": token, "x-naelao-tenant-id": "tenant-1" },
    body: JSON.stringify({ business_space_id: "biz-1", plan_id: "plus-monthly", end_user_id: "user-a" }),
  });
}

describe("POST /internal/personal-plan/checkout — Whop first", () => {
  it("uses Naelao's own Whop seller account when a Whop plan id is configured", async () => {
    mockOutbound({ "/checkout_configurations": { checkout_url: "https://whop.com/checkout/plus" } });
    const env = makeEnv({ WHOP_API_KEY: "whop-key", LEMON_SQUEEZY_API_KEY: "ls", LEMON_SQUEEZY_STORE_ID: "1" });

    const res = await billingWorker.fetch(await checkoutReq(), env, execCtx);
    expect(res.status).toBe(200);
    const body = await res.json<{ checkout_url: string; provider?: string }>();
    expect(body.provider).toBe("whop");
    expect(body.checkout_url).toBe("https://whop.com/checkout/plus");

    // It really went to Whop, carrying the metadata the webhook routes on.
    const whopCall = calls.find((c) => c.url.includes("/checkout_configurations"));
    expect(whopCall).toBeDefined();
    expect((whopCall!.body as { plan_id: string }).plan_id).toBe("plan_whop_plus");
    expect((whopCall!.body as { metadata: Record<string, string> }).metadata).toMatchObject({
      kind: "personal_plan", plan_id: "plus-monthly", tier: "plus", interval: "month", end_user_id: "user-a", product_space_id: "prod-1",
    });
    // And never touched Lemon Squeezy.
    expect(calls.some((c) => c.url.includes("lemonsqueezy"))).toBe(false);
  });

  it("falls back to Lemon Squeezy when no Whop plan id is configured for this tier", async () => {
    mockOutbound({ "lemonsqueezy.com": { data: { attributes: { url: "https://ls.example/checkout/plus" } } } });
    const planNoWhop = { ...PLAN, whopPlanId: undefined };
    const env = makeEnv({ WHOP_API_KEY: "whop-key", LEMON_SQUEEZY_API_KEY: "ls", LEMON_SQUEEZY_STORE_ID: "1" }, planNoWhop);

    const res = await billingWorker.fetch(await checkoutReq(), env, execCtx);
    expect(res.status).toBe(200);
    expect(calls.some((c) => c.url.includes("/checkout_configurations"))).toBe(false);
  });

  it("falls back to Lemon Squeezy when the Whop call itself fails, rather than erroring the user", async () => {
    // Whop unmocked → 500 from the mock layer → the route must degrade, not surface a failure.
    mockOutbound({ "lemonsqueezy.com": { data: { attributes: { url: "https://ls.example/checkout/plus" } } } });
    const env = makeEnv({ WHOP_API_KEY: "whop-key", LEMON_SQUEEZY_API_KEY: "ls", LEMON_SQUEEZY_STORE_ID: "1" });

    const res = await billingWorker.fetch(await checkoutReq(), env, execCtx);
    expect(res.status).toBe(200);
    expect(calls.some((c) => c.url.includes("/checkout_configurations"))).toBe(true); // tried
    expect(calls.some((c) => c.url.includes("lemonsqueezy.com"))).toBe(true); // then fell back
  });

  it("returns the honest dev placeholder when neither rail is configured", async () => {
    mockOutbound({});
    const env = makeEnv({});
    const res = await billingWorker.fetch(await checkoutReq(), env, execCtx);
    const body = await res.json<{ dev?: boolean; checkout_url: string }>();
    expect(body.dev).toBe(true);
  });
});
