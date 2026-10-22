import { describe, it, expect, afterEach } from "vitest";
import billingWorker from "../../workers/billing/src/index.js";
import { parseWhopPlatformPlanEvent, verifyWhopPlatformPlanWebhook } from "../../packages/billing-core/src/providers/whop-platform-plan.js";
import { mintInternalToken } from "@naelao/http";

// Whop as a second PLATFORM billing provider, tried before Lemon Squeezy (AUDIT_TODO.md AI-7 —
// LS's own onboarding requires a Stripe-linked payout path unavailable in some sellers'
// countries). Naelao's OWN normal Whop seller account (WHOP_API_KEY), NOT the invite-gated
// Platforms API (WHOP_PLATFORM_API_KEY) the business-wallet rail uses.

const SECRET = "test-platform-secret";
const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

interface Call { url: string; headers: Record<string, string>; body: unknown }
let calls: Call[] = [];
const realFetch = globalThis.fetch;

function mockOutboundFetch(responses: Record<string, unknown>) {
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

function makeEnv(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const db = {
    prepare(sql: string) {
      const stmt = {
        bind() { return stmt; },
        async first() {
          if (/SELECT u\.email/.test(sql)) return { email: "owner@example.com" };
          if (/FROM spaces WHERE id = \?/.test(sql)) return { tenant_id: "tenant-1" };
          if (/FROM subscriptions WHERE org_id/.test(sql)) return (overrides as { __subRow?: unknown }).__subRow ?? null;
          return null;
        },
        async run() { return { meta: { changes: 1 } }; },
      };
      return stmt;
    },
  };
  return { ENVIRONMENT: "test", PLATFORM_SECRET: SECRET, PLATFORM_DB: db, ...overrides };
}

describe("POST /billing/checkout — Whop tried first, LS fallback", () => {
  it("uses Whop when WHOP_API_KEY + the plan's Whop plan id are configured", async () => {
    mockOutboundFetch({ "/checkout_configurations": { checkout_url: "https://whop.com/checkout/platform-growth" } });
    const req = new Request("https://billing.naelao.com/billing/checkout", {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": "org-1", "x-naelao-user-id": "user-1", "x-naelao-role": "owner" },
      body: JSON.stringify({ plan: "growth", success_url: "https://dashboard.naelao.com/thanks" }),
    });
    const res = await billingWorker.fetch(
      req,
      makeEnv({ WHOP_API_KEY: "naelao-whop-key", WHOP_GROWTH_PLAN_ID: "plan_growth_naelao" }) as never,
      execCtx
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { checkout_url: string; provider?: string };
    expect(body.checkout_url).toBe("https://whop.com/checkout/platform-growth");
    expect(body.provider).toBe("whop");
    expect(calls[0]!.headers["authorization"]).toBe("Bearer naelao-whop-key");
    const sentBody = calls[0]!.body as { plan_id: string; metadata: Record<string, string> };
    expect(sentBody.plan_id).toBe("plan_growth_naelao");
    expect(sentBody.metadata).toMatchObject({ kind: "platform_plan", org_id: "org-1", plan: "growth" });
  });

  it("falls back to the LS dev placeholder when Whop isn't configured", async () => {
    const req = new Request("https://billing.naelao.com/billing/checkout", {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": "org-1", "x-naelao-user-id": "user-1", "x-naelao-role": "owner" },
      body: JSON.stringify({ plan: "business", success_url: "https://dashboard.naelao.com/thanks" }),
    });
    const res = await billingWorker.fetch(req, makeEnv() as never, execCtx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dev: boolean; checkout_url: string };
    expect(body.dev).toBe(true);
    expect(body.checkout_url).toContain("business");
  });

  it("falls through to LS when the Whop call itself fails", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 })) as typeof fetch;
    const req = new Request("https://billing.naelao.com/billing/checkout", {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": "org-1", "x-naelao-user-id": "user-1", "x-naelao-role": "owner" },
      body: JSON.stringify({ plan: "growth", success_url: "https://dashboard.naelao.com/thanks" }),
    });
    const res = await billingWorker.fetch(
      req,
      makeEnv({ WHOP_API_KEY: "naelao-whop-key", WHOP_GROWTH_PLAN_ID: "plan_growth_naelao" }) as never,
      execCtx
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dev: boolean };
    expect(body.dev).toBe(true);
  });
});

describe("POST /billing/portal — branches to Whop's fixed orders page", () => {
  it("returns the fixed Whop orders URL when the org's subscription row has a whop_customer_id and no ls_customer_id", async () => {
    const req = new Request("https://billing.naelao.com/billing/portal", {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": "org-1", "x-naelao-role": "owner" },
    });
    const res = await billingWorker.fetch(
      req,
      makeEnv({ __subRow: { ls_customer_id: null, whop_customer_id: "mem_123" } }) as never,
      execCtx
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { portal_url: string; provider: string };
    expect(body.portal_url).toBe("https://whop.com/orders/");
    expect(body.provider).toBe("whop");
  });
});

describe("POST /webhooks/whop-platform-plan", () => {
  async function signedReq(rawBody: string, secret: string): Promise<Request> {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
    const sig = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return new Request("https://billing.naelao.com/webhooks/whop-platform-plan", {
      method: "POST",
      headers: { "Whop-Signature": sig },
      body: rawBody,
    });
  }

  it("rejects an unsigned/incorrectly-signed body", async () => {
    const body = JSON.stringify({ event: "membership.went_valid", data: { id: "mem_1", metadata: { org_id: "org-1", plan: "growth" } } });
    const req = new Request("https://billing.naelao.com/webhooks/whop-platform-plan", { method: "POST", body });
    const res = await billingWorker.fetch(req, makeEnv({ WHOP_PLATFORM_PLAN_WEBHOOK_SECRET: "whop_secret", AGENTS_WORKER: { fetch: async () => new Response("{}") } }) as never, execCtx);
    expect(res.status).toBe(401);
  });

  it("records the org's plan_tier on a validly-signed membership.went_valid event", async () => {
    let orgUpdateArgs: unknown[] = [];
    const db = {
      prepare(sql: string) {
        const stmt = {
          bind(...a: unknown[]) { orgUpdateArgs = /UPDATE orgs/.test(sql) ? a : orgUpdateArgs; return stmt; },
          async first() { return null; },
          async run() { return { meta: { changes: 1 } }; },
        };
        return stmt;
      },
    };
    const body = JSON.stringify({
      event: "membership.went_valid",
      data: { id: "mem_1", plan_id: "plan_growth", status: "active", metadata: { kind: "platform_plan", org_id: "org-1", plan: "growth" } },
    });
    const req = await signedReq(body, "whop_secret");
    const res = await billingWorker.fetch(
      req,
      makeEnv({ PLATFORM_DB: db, WHOP_PLATFORM_PLAN_WEBHOOK_SECRET: "whop_secret", AGENTS_WORKER: { fetch: async () => new Response("{}") } }) as never,
      execCtx
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as { handled: boolean }).toMatchObject({ handled: true });
    expect(orgUpdateArgs).toEqual(["growth", "org-1"]);
  });

  it("fulfills a personal-plan payment without requiring the unrelated Agents worker", async () => {
    const grantCalls: Request[] = [];
    const req = await signedReq(JSON.stringify({
      id: "evt_personal",
      event: "payment.succeeded",
      data: {
        id: "payment-1",
        plan_id: "plan-plus-monthly",
        amount: 500,
        metadata: { kind: "personal_plan", plan_id: "plus-monthly", tier: "plus", interval: "month", end_user_id: "user-1", product_space_id: "product-1" },
      },
    }), "whop_secret");
    const res = await billingWorker.fetch(req, makeEnv({
      WHOP_PLATFORM_PLAN_WEBHOOK_SECRET: "whop_secret",
      SPACES_WORKER: {
        async fetch(input: Request) {
          grantCalls.push(input);
          return Response.json({ plan_tier: "plus" });
        },
      },
    }) as never, execCtx);
    expect(res.status).toBe(200);
    expect((await res.json()) as { handled: boolean }).toMatchObject({ handled: true });
    expect(grantCalls).toHaveLength(1);
    expect(new URL(grantCalls[0]!.url).pathname).toBe("/internal/personal-plan/grant");
    await expect(grantCalls[0]!.clone().json()).resolves.toMatchObject({
      action: "purchase", tier: "plus", interval: "month", provider: "whop",
      provider_event_id: "evt_personal", amount_cents: 500,
    });
  });

  it("does not treat an unknown signed Whop event as a successful payment", async () => {
    const updates: string[] = [];
    const db = {
      prepare(sql: string) {
        const stmt = {
          bind() { return stmt; },
          async first() { return null; },
          async run() { updates.push(sql); return { meta: { changes: 1 } }; },
        };
        return stmt;
      },
    };
    const req = await signedReq(JSON.stringify({
      id: "evt_unknown",
      event: "membership.updated",
      data: { id: "mem-1", metadata: { kind: "platform_plan", org_id: "org-1", plan: "growth" } },
    }), "whop_secret");
    const res = await billingWorker.fetch(req, makeEnv({
      PLATFORM_DB: db,
      WHOP_PLATFORM_PLAN_WEBHOOK_SECRET: "whop_secret",
    }) as never, execCtx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ skipped: true, reason: "unparseable body" });
    expect(updates).toHaveLength(0);
  });
});

describe("verifyWhopPlatformPlanWebhook", () => {
  it("rejects when the secret is empty", async () => {
    const headers = new Headers({ "Whop-Signature": "deadbeef" });
    expect(await verifyWhopPlatformPlanWebhook("{}", headers, "")).toBe(false);
  });

  it("rejects when the header is missing", async () => {
    expect(await verifyWhopPlatformPlanWebhook("{}", new Headers(), "secret")).toBe(false);
  });
});

describe("parseWhopPlatformPlanEvent subscription identity", () => {
  it("uses membership_id for payment events and never confuses plan_id with a subscription", () => {
    const event = parseWhopPlatformPlanEvent(JSON.stringify({
      id: "payment-1",
      event: "payment.failed",
      data: {
        id: "payment-1",
        plan_id: "plan-growth",
        membership_id: "membership-current",
        metadata: { kind: "platform_plan", org_id: "org-1", plan: "growth" },
      },
    }));
    expect(event.subscriptionId).toBe("membership-current");
    expect(event.variantOrPriceId).toBe("plan-growth");
  });

  it("uses the membership resource ID for membership lifecycle events", () => {
    const event = parseWhopPlatformPlanEvent(JSON.stringify({
      event: "membership.went_valid",
      data: { id: "membership-1", plan_id: "plan-growth", metadata: { kind: "platform_plan", org_id: "org-1", plan: "growth" } },
    }));
    expect(event.subscriptionId).toBe("membership-1");
  });
});
