import { describe, it, expect } from "vitest";
import billingWorker from "../../workers/billing/src/index.js";

// Vendor cutover: Lemon Squeezy is the ONLY billing provider. The builder's own platform plan
// (growth/business) — previously the last Stripe-backed path — now runs through the same LS
// store: POST /billing/checkout creates an LS checkout tagged kind="platform_plan", and the LS
// webhook's new early branch (recordPlatformPlanSubscription) upserts the org's subscription.
// The webhook tests run against a real fake-D1 loaded with the REAL migrations, which is what
// locks in the entitlement fix: the old Stripe webhook only ever wrote subscriptions.plan_tier,
// but EntitlementsChecker.getTenantTier reads orgs.plan_tier — so a paid upgrade never actually
// unlocked anything. The platform-plan handler must write BOTH.

const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const SECRET = "test-platform-secret";
const ORG_ID = "org-1";

function makeEnv(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const db = {
    prepare() {
      const stmt = {
        bind() { return stmt; },
        async first() { return null; },
        async run() { return { meta: { changes: 1 } }; },
      };
      return stmt;
    },
  };
  return { ENVIRONMENT: "test", PLATFORM_SECRET: SECRET, PLATFORM_DB: db, ...overrides };
}

function checkoutReq(body: unknown, role = "owner"): Request {
  return new Request("https://billing.naelao.com/billing/checkout", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-naelao-tenant-id": ORG_ID,
      "x-naelao-user-id": "user-1",
      "x-naelao-role": role,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /billing/checkout — Lemon Squeezy platform plans (Stripe removed)", () => {
  it("boots without any STRIPE_* env at all (validateEnv no longer requires them)", async () => {
    const res = await billingWorker.fetch(
      checkoutReq({ plan: "growth", success_url: "https://app.naelao.com/dashboard/settings" }),
      makeEnv() as never,
      execCtx
    );
    expect(res.status).toBe(200); // would 500 "Missing required secret" before the cutover
  });

  it("returns the dev placeholder when LS creds / plan variant are unset", async () => {
    const res = await billingWorker.fetch(
      checkoutReq({ plan: "business", success_url: "https://x.example/done" }),
      makeEnv() as never,
      execCtx
    );
    const body = (await res.json()) as { checkout_url: string; dev?: boolean; plan: string };
    expect(body.dev).toBe(true);
    expect(body.plan).toBe("business");
    expect(body.checkout_url).toContain("/dev/platform-plan/business");
  });

  it("no longer requires cancel_url (an LS checkout has no cancel redirect)", async () => {
    const res = await billingWorker.fetch(
      checkoutReq({ plan: "growth", success_url: "https://x.example/done" }),
      makeEnv() as never,
      execCtx
    );
    expect(res.status).toBe(200);
  });

  it("rejects a regular org member before looking up or creating a checkout", async () => {
    const res = await billingWorker.fetch(
      checkoutReq({ plan: "growth", success_url: "https://x.example/done" }, "member"),
      makeEnv({ WHOP_API_KEY: "must-not-be-used", WHOP_GROWTH_PLAN_ID: "plan-1" }) as never,
      execCtx
    );
    expect(res.status).toBe(403);
  });

  it("creates a real LS checkout tagged kind=platform_plan with org_id + plan when configured", async () => {
    const originalFetch = globalThis.fetch;
    let captured: { data: { attributes: { checkout_data: { custom: Record<string, string> } } } } | null = null;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      captured = JSON.parse(init!.body as string);
      return new Response(JSON.stringify({ data: { attributes: { url: "https://checkout.lemonsqueezy.com/plan" } } }), { status: 200 });
    }) as typeof fetch;
    try {
      const res = await billingWorker.fetch(
        checkoutReq({ plan: "growth", success_url: "https://x.example/done" }),
        makeEnv({
          LEMON_SQUEEZY_API_KEY: "key",
          LEMON_SQUEEZY_STORE_ID: "store",
          LEMON_SQUEEZY_GROWTH_VARIANT_ID: "var_growth",
        }) as never,
        execCtx
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { checkout_url: string; dev?: boolean };
      expect(body.checkout_url).toBe("https://checkout.lemonsqueezy.com/plan");
      expect(body.dev).toBeUndefined();
      expect(captured!.data.attributes.checkout_data.custom).toMatchObject({
        kind: "platform_plan",
        org_id: ORG_ID,
        plan: "growth",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("POST /billing/portal — Lemon Squeezy customer portal", () => {
  it("404s when the org has no LS billing profile yet", async () => {
    const res = await billingWorker.fetch(
      new Request("https://billing.naelao.com/billing/portal", {
        method: "POST",
        headers: { "content-type": "application/json", "x-naelao-tenant-id": ORG_ID, "x-naelao-role": "owner" },
        body: "{}",
      }),
      makeEnv() as never,
      execCtx
    );
    expect(res.status).toBe(404);
  });

  it("bounds the provider response and refuses redirects while using a deadline", async () => {
    const originalFetch = globalThis.fetch;
    let captured: RequestInit | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      captured = init;
      return Response.json({ data: { attributes: { urls: { customer_portal: "https://store.lemonsqueezy.com/billing" } } } });
    }) as typeof fetch;
    const env = makeEnv({
      PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ ls_customer_id: "customer-1", whop_customer_id: null }) }) }) },
      LEMON_SQUEEZY_API_KEY: "test-key",
    });
    try {
      const res = await billingWorker.fetch(
        new Request("https://billing.naelao.com/billing/portal", { method: "POST", headers: { "x-naelao-tenant-id": ORG_ID, "x-naelao-role": "owner", "content-type": "application/json" }, body: "{}" }),
        env as never,
        execCtx
      );
      expect(res.status).toBe(200);
      expect(captured?.redirect).toBe("error");
      expect(captured?.signal).toBeInstanceOf(AbortSignal);
    } finally {
      globalThis.fetch = originalFetch;
    }

    globalThis.fetch = (async () => new Response("x".repeat(1024 * 1024 + 1), { headers: { "content-type": "application/json" } })) as typeof fetch;
    try {
      const res = await billingWorker.fetch(
        new Request("https://billing.naelao.com/billing/portal", { method: "POST", headers: { "x-naelao-tenant-id": ORG_ID, "x-naelao-role": "owner", "content-type": "application/json" }, body: "{}" }),
        env as never,
        execCtx
      );
      expect(res.status).toBe(500);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ── Webhook: platform_plan events against a real fake-D1 with the REAL migrations ────────────

async function loadDb() {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { createFakeD1 } = await import("../stubs/d1-sqlite.js");
  const m = (f: string) => readFileSync(join(__dirname, "../../infra/migrations/", f), "utf8");
  const fakeDb = createFakeD1([
    m("0002_orgs.sql"),
    m("0004_billing.sql"),
    m("0033_reseller_accounts.sql"), // 0050/0052's idempotency index references reseller_ledger
    m("0035_commerce.sql"),
    m("0050_webhook_idempotency.sql"),
    m("0052_webhook_idempotency_event_type.sql"),
    m("0062_subscriptions_lemon_squeezy.sql"),
    m("0067_subscriptions_whop_platform_plan.sql"),
    m("0049_business_subscriptions.sql"),
    m("0125_subscription_event_ordering.sql"),
  ]);
  await fakeDb.prepare("INSERT INTO orgs (id, name, owner_id, plan_tier) VALUES (?, 'Test Org', 'user-1', 'free')")
    .bind(ORG_ID).run();
  return fakeDb;
}

async function signedWebhook(rawBody: string, webhookSecret: string): Promise<Request> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(webhookSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const sig = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return new Request("https://billing.naelao.com/webhooks/lemon-squeezy", { method: "POST", headers: { "X-Signature": sig }, body: rawBody });
}

function planEventBody(eventName: string, opts: { subId?: string; status?: string; plan?: string; updatedAt?: string } = {}): string {
  const custom = { kind: "platform_plan", org_id: ORG_ID, plan: opts.plan ?? "growth", spaceId: ORG_ID };
  return JSON.stringify({
    meta: { event_name: eventName, custom_data: custom },
    data: {
      id: opts.subId ?? "sub_1",
      attributes: {
        status: opts.status ?? "active",
        customer_id: "cust_9",
        ...(opts.updatedAt ? { updated_at: opts.updatedAt } : {}),
        renews_at: "2026-08-11T00:00:00Z",
        custom_data: custom,
      },
    },
  });
}

async function webhookEnv(fakeDb: unknown) {
  return {
    PLATFORM_SECRET: SECRET,
    PLATFORM_DB: fakeDb,
    LEMON_SQUEEZY_WEBHOOK_SECRET: "whsec_test",
    AGENTS_WORKER: { fetch: async () => new Response("{}") },
  };
}

describe("LS webhook — kind=platform_plan upserts the ORG's plan (no space dispatch)", () => {
  it("subscription_created activates the plan in BOTH subscriptions AND orgs.plan_tier", async () => {
    const { handleLemonSqueezyWebhook } = await import("../../workers/billing/src/lemon-squeezy.js");
    const fakeDb = await loadDb();
    const res = await handleLemonSqueezyWebhook(await signedWebhook(planEventBody("subscription_created"), "whsec_test"), await webhookEnv(fakeDb) as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, kind: "platform_plan" });

    const sub = await fakeDb.prepare("SELECT plan_tier, status, ls_customer_id, ls_subscription_id FROM subscriptions WHERE org_id = ?").bind(ORG_ID).first();
    expect(sub).toMatchObject({ plan_tier: "growth", status: "active", ls_customer_id: "cust_9", ls_subscription_id: "sub_1" });

    // THE entitlement fix: getTenantTier reads orgs.plan_tier — the old Stripe webhook never
    // wrote it, so upgrades never unlocked free-tier gates. This is what makes the upgrade real.
    const org = await fakeDb.prepare("SELECT plan_tier FROM orgs WHERE id = ?").bind(ORG_ID).first();
    expect(org).toMatchObject({ plan_tier: "growth" });
  });

  it("records platform billing events without an Agents binding", async () => {
    const fakeDb = await loadDb();
    const env = await webhookEnv(fakeDb) as Record<string, unknown>;
    delete env["AGENTS_WORKER"];
    const res = await billingWorker.fetch(await signedWebhook(planEventBody("subscription_created"), "whsec_test"), env as never, execCtx);
    expect(res.status).toBe(200);
    const org = await fakeDb.prepare("SELECT plan_tier FROM orgs WHERE id = ?").bind(ORG_ID).first();
    expect(org).toMatchObject({ plan_tier: "growth" });
  });

  it("subscription_expired drops the org back to free only for the currently recorded subscription", async () => {
    const { handleLemonSqueezyWebhook } = await import("../../workers/billing/src/lemon-squeezy.js");
    const fakeDb = await loadDb();
    const env = await webhookEnv(fakeDb);
    await handleLemonSqueezyWebhook(await signedWebhook(planEventBody("subscription_created", { subId: "sub_1" }), "whsec_test"), env as never);
    const res = await handleLemonSqueezyWebhook(
      await signedWebhook(planEventBody("subscription_expired", { subId: "sub_1", status: "expired" }), "whsec_test"),
      env as never
    );
    expect(res.status).toBe(200);
    const sub = await fakeDb.prepare("SELECT plan_tier, status FROM subscriptions WHERE org_id = ?").bind(ORG_ID).first();
    expect(sub).toMatchObject({ plan_tier: "free", status: "expired" });
    const org = await fakeDb.prepare("SELECT plan_tier FROM orgs WHERE id = ?").bind(ORG_ID).first();
    expect(org).toMatchObject({ plan_tier: "free" });
  });

  it("a duplicate delivery of the same event id is a no-op (exactly-once gate)", async () => {
    const { handleLemonSqueezyWebhook } = await import("../../workers/billing/src/lemon-squeezy.js");
    const fakeDb = await loadDb();
    const env = await webhookEnv(fakeDb);
    const body = planEventBody("subscription_created", { subId: "sub_dup" });
    const first = await handleLemonSqueezyWebhook(await signedWebhook(body, "whsec_test"), env as never);
    expect(await first.json()).toMatchObject({ ok: true, kind: "platform_plan" });
    const second = await handleLemonSqueezyWebhook(await signedWebhook(body, "whsec_test"), env as never);
    expect(await second.json()).toMatchObject({ ok: true, duplicate: true });
  });

  it("cancelled keeps the paid tier (LS grace until expiry) but surfaces the status", async () => {
    const { handleLemonSqueezyWebhook } = await import("../../workers/billing/src/lemon-squeezy.js");
    const fakeDb = await loadDb();
    const env = await webhookEnv(fakeDb);
    await handleLemonSqueezyWebhook(await signedWebhook(planEventBody("subscription_created", { subId: "s1" }), "whsec_test"), env as never);
    await handleLemonSqueezyWebhook(
      await signedWebhook(planEventBody("subscription_cancelled", { subId: "s1", status: "cancelled" }), "whsec_test"),
      env as never
    );
    const sub = await fakeDb.prepare("SELECT plan_tier, status FROM subscriptions WHERE org_id = ?").bind(ORG_ID).first();
    expect(sub).toMatchObject({ plan_tier: "growth", status: "cancelled" });
  });

  it("releases malformed platform-plan events for visible retry instead of acknowledging paid metadata", async () => {
    const { handleLemonSqueezyWebhook } = await import("../../workers/billing/src/lemon-squeezy.js");
    const fakeDb = await loadDb();
    const custom = { kind: "platform_plan", plan: "enterprise-typo", spaceId: "x" }; // no org_id, bad plan
    const body = JSON.stringify({
      meta: { event_name: "subscription_created", custom_data: custom },
      data: { id: "sub_bad", attributes: { status: "active", customer_id: "c", custom_data: custom } },
    });
    const res = await handleLemonSqueezyWebhook(await signedWebhook(body, "whsec_test"), await webhookEnv(fakeDb) as never);
    expect(res.status).toBe(500);
    const sub = await fakeDb.prepare("SELECT * FROM subscriptions WHERE org_id = ?").bind(ORG_ID).first();
    expect(sub).toBeNull();
    const processed = await fakeDb.prepare("SELECT COUNT(*) AS count FROM processed_webhook_events WHERE provider = 'lemon_squeezy'").first() as { count: number };
    expect(processed.count).toBe(0);
  });

  it("does not grant a platform tier for an initial failed payment", async () => {
    const { handleLemonSqueezyWebhook } = await import("../../workers/billing/src/lemon-squeezy.js");
    const fakeDb = await loadDb();
    const res = await handleLemonSqueezyWebhook(
      await signedWebhook(planEventBody("subscription_payment_failed", { subId: "sub_failed" }), "whsec_test"),
      await webhookEnv(fakeDb) as never
    );
    expect(res.status).toBe(200);
    const sub = await fakeDb.prepare("SELECT * FROM subscriptions WHERE org_id = ?").bind(ORG_ID).first();
    expect(sub).toBeNull();
    const org = await fakeDb.prepare("SELECT plan_tier FROM orgs WHERE id = ?").bind(ORG_ID).first();
    expect(org).toMatchObject({ plan_tier: "free" });
  });

  it("marks a failed renewal past_due without removing an existing paid tier", async () => {
    const { handleLemonSqueezyWebhook } = await import("../../workers/billing/src/lemon-squeezy.js");
    const fakeDb = await loadDb();
    const env = await webhookEnv(fakeDb);
    await handleLemonSqueezyWebhook(
      await signedWebhook(planEventBody("subscription_created", { subId: "sub_paid" }), "whsec_test"),
      env as never
    );
    const res = await handleLemonSqueezyWebhook(
      await signedWebhook(planEventBody("subscription_payment_failed", { subId: "sub_paid" }), "whsec_test"),
      env as never
    );
    expect(res.status).toBe(200);
    const sub = await fakeDb.prepare("SELECT plan_tier, status FROM subscriptions WHERE org_id = ?").bind(ORG_ID).first();
    expect(sub).toMatchObject({ plan_tier: "growth", status: "past_due" });
  });

  it("ignores a failed payment from a replaced platform subscription", async () => {
    const { handleLemonSqueezyWebhook } = await import("../../workers/billing/src/lemon-squeezy.js");
    const fakeDb = await loadDb();
    const env = await webhookEnv(fakeDb);
    await handleLemonSqueezyWebhook(
      await signedWebhook(planEventBody("subscription_created", { subId: "sub_old", updatedAt: "2026-04-01T00:00:00Z" }), "whsec_test"),
      env as never
    );
    await handleLemonSqueezyWebhook(
      await signedWebhook(planEventBody("subscription_created", { subId: "sub_current", updatedAt: "2026-05-01T00:00:00Z" }), "whsec_test"),
      env as never
    );
    const res = await handleLemonSqueezyWebhook(
      await signedWebhook(planEventBody("subscription_payment_failed", { subId: "sub_old" }), "whsec_test"),
      env as never
    );
    expect(res.status).toBe(200);
    const sub = await fakeDb.prepare("SELECT plan_tier, status, ls_subscription_id FROM subscriptions WHERE org_id = ?").bind(ORG_ID).first();
    expect(sub).toMatchObject({ plan_tier: "growth", status: "active", ls_subscription_id: "sub_current" });
  });

  it("ignores late expiry from a replaced subscription and never downgrades the current org", async () => {
    const { handleLemonSqueezyWebhook } = await import("../../workers/billing/src/lemon-squeezy.js");
    const fakeDb = await loadDb();
    const env = await webhookEnv(fakeDb);
    await handleLemonSqueezyWebhook(await signedWebhook(planEventBody("subscription_created", { subId: "sub_old", updatedAt: "2026-04-01T00:00:00Z" }), "whsec_test"), env as never);
    await handleLemonSqueezyWebhook(await signedWebhook(planEventBody("subscription_created", { subId: "sub_current", updatedAt: "2026-05-01T00:00:00Z" }), "whsec_test"), env as never);
    const res = await handleLemonSqueezyWebhook(await signedWebhook(planEventBody("subscription_expired", { subId: "sub_old", status: "expired", updatedAt: "2026-04-15T00:00:00Z" }), "whsec_test"), env as never);
    expect(res.status).toBe(200);
    const sub = await fakeDb.prepare("SELECT plan_tier, status, ls_subscription_id FROM subscriptions WHERE org_id = ?").bind(ORG_ID).first();
    expect(sub).toMatchObject({ plan_tier: "growth", status: "active", ls_subscription_id: "sub_current" });
    const org = await fakeDb.prepare("SELECT plan_tier FROM orgs WHERE id = ?").bind(ORG_ID).first();
    expect(org).toMatchObject({ plan_tier: "growth" });
  });

  it("rejects out-of-order lifecycle transitions for the same platform subscription", async () => {
    const { handleLemonSqueezyWebhook } = await import("../../workers/billing/src/lemon-squeezy.js");
    const fakeDb = await loadDb();
    const env = await webhookEnv(fakeDb);
    await handleLemonSqueezyWebhook(await signedWebhook(planEventBody("subscription_created", { subId: "sub_same", updatedAt: "2026-05-02T00:00:00Z" }), "whsec_test"), env as never);
    await handleLemonSqueezyWebhook(await signedWebhook(planEventBody("subscription_expired", { subId: "sub_same", status: "expired", updatedAt: "2026-05-01T00:00:00Z" }), "whsec_test"), env as never);
    const sub = await fakeDb.prepare("SELECT plan_tier, status FROM subscriptions WHERE org_id = ?").bind(ORG_ID).first();
    expect(sub).toMatchObject({ plan_tier: "growth", status: "active" });
  });

  it("processes later subscription.updated events for the same resource id", async () => {
    const { handleLemonSqueezyWebhook } = await import("../../workers/billing/src/lemon-squeezy.js");
    const fakeDb = await loadDb();
    const env = await webhookEnv(fakeDb);
    const subscriptionUpdate = (status: string) => JSON.stringify({
      meta: { event_name: "subscription_updated", custom_data: { kind: "platform_plan", org_id: ORG_ID, plan: "growth" } },
      data: { id: "sub_stable", attributes: { status, customer_id: "cust_9", custom_data: { kind: "platform_plan", org_id: ORG_ID, plan: "growth" } } },
    });
    await handleLemonSqueezyWebhook(await signedWebhook(subscriptionUpdate("past_due"), "whsec_test"), env as never);
    const second = await handleLemonSqueezyWebhook(await signedWebhook(subscriptionUpdate("active"), "whsec_test"), env as never);
    expect(second.status).toBe(200);
    const sub = await fakeDb.prepare("SELECT plan_tier, status, ls_subscription_id FROM subscriptions WHERE org_id = ?").bind(ORG_ID).first();
    expect(sub).toMatchObject({ plan_tier: "growth", status: "active", ls_subscription_id: "sub_stable" });
  });

  it("does not reactivate a platform plan when the payment is refunded", async () => {
    const { handleLemonSqueezyWebhook } = await import("../../workers/billing/src/lemon-squeezy.js");
    const fakeDb = await loadDb();
    const env = await webhookEnv(fakeDb);
    await handleLemonSqueezyWebhook(
      await signedWebhook(planEventBody("subscription_created", { subId: "sub_refund" }), "whsec_test"),
      env as never
    );
    const refundBody = JSON.stringify({
      meta: { event_name: "order_refunded", custom_data: { kind: "platform_plan", org_id: ORG_ID, plan: "growth" } },
      data: { id: "sub_refund", attributes: { total: 1000, currency: "USD", custom_data: { kind: "platform_plan", org_id: ORG_ID, plan: "growth" } } },
    });
    const res = await handleLemonSqueezyWebhook(await signedWebhook(refundBody, "whsec_test"), env as never);
    expect(res.status).toBe(200);
    const sub = await fakeDb.prepare("SELECT plan_tier, status FROM subscriptions WHERE org_id = ?").bind(ORG_ID).first();
    expect(sub).toMatchObject({ plan_tier: "growth", status: "active" });
  });
});
