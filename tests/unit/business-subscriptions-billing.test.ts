import { describe, it, expect } from "vitest";
import billingWorker from "../../workers/billing/src/index.js";
import { mintInternalToken } from "@naelao/http";

// Phase E (§A1.17): a business subscribing to a builder-defined plan, and an end user buying a
// one-time credit pack. Both checkout routes resolve the plan/pack catalog via the spaces worker
// (SPACES_WORKER service binding) rather than reading D1 directly here — this worker doesn't know
// the business/product hierarchy rules the spaces worker's parent-walk resolves.

const SECRET = "test-platform-secret";
const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function makeEnv(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const db = {
    prepare(sql: string) {
      const stmt = {
        bind() { return stmt; },
        async first() {
          if (/FROM spaces WHERE id = \?/.test(sql)) return { tenant_id: "tenant-1" };
          return null;
        },
        async run() { return { meta: { changes: 1 } }; },
      };
      return stmt;
    },
  };
  return {
    ENVIRONMENT: "test",
    PLATFORM_SECRET: SECRET,

    PLATFORM_DB: db,
    ...overrides,
  };
}

function internalReq(path: string, body: unknown): Request {
  return new Request(`https://billing.naelao.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function withToken(req: Request, tenantId = "tenant-1"): Promise<Request> {
  const token = await mintInternalToken(SECRET, tenantId);
  const headers = new Headers(req.headers);
  headers.set("x-naelao-tenant-id", tenantId);
  headers.set("x-naelao-internal-token", token);
  return new Request(req, { headers });
}

describe("POST /internal/business-subscriptions/checkout", () => {
  it("requires a verified internal token", async () => {
    const res = await billingWorker.fetch(
      internalReq("/internal/business-subscriptions/checkout", { business_space_id: "biz-1", plan_id: "pro" }),
      makeEnv() as never,
      execCtx
    );
    expect(res.status).toBe(403);
  });

  it("rejects a signed caller whose tenant does not own the requested space", async () => {
    let spacesCalls = 0;
    const crossTenantDb = {
      prepare() {
        const stmt = { bind() { return stmt; }, async first() { return { tenant_id: "tenant-2" }; } };
        return stmt;
      },
    };
    const req = await withToken(internalReq("/internal/business-subscriptions/checkout", { business_space_id: "biz-1", plan_id: "pro" }), "tenant-1");
    const res = await billingWorker.fetch(req, makeEnv({
      PLATFORM_DB: crossTenantDb,
      SPACES_WORKER: { fetch: async () => { spacesCalls++; return Response.json({ plans: [] }); } },
    }) as never, execCtx);
    expect(res.status).toBe(404);
    expect(spacesCalls).toBe(0);
  });

  it("returns the dev checkout placeholder when the plan has no lsVariantId / no LS creds", async () => {
    const spacesWorker = {
      fetch: async () =>
        new Response(
          JSON.stringify({ product_space_id: "prod-root", plans: [{ id: "pro", name: "Pro", priceCents: 2900, interval: "month" }] }),
          { status: 200 }
        ),
    };
    const req = await withToken(internalReq("/internal/business-subscriptions/checkout", { business_space_id: "biz-1", plan_id: "pro" }));
    const res = await billingWorker.fetch(req, makeEnv({ SPACES_WORKER: spacesWorker }) as never, execCtx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { checkout_url: string; dev: boolean; plan: { id: string } };
    expect(body.dev).toBe(true);
    expect(body.plan.id).toBe("pro");
  });

  it("404s when the plan id doesn't exist in the catalog", async () => {
    const spacesWorker = {
      fetch: async () => new Response(JSON.stringify({ product_space_id: "prod-root", plans: [] }), { status: 200 }),
    };
    const req = await withToken(internalReq("/internal/business-subscriptions/checkout", { business_space_id: "biz-1", plan_id: "nonexistent" }));
    const res = await billingWorker.fetch(req, makeEnv({ SPACES_WORKER: spacesWorker }) as never, execCtx);
    expect(res.status).toBe(404);
  });

  it("creates a real LS checkout carrying kind/plan_id/product_space_id in metadata when LS creds + lsVariantId are present", async () => {
    const spacesWorker = {
      fetch: async () =>
        new Response(
          JSON.stringify({ product_space_id: "prod-root", plans: [{ id: "pro", name: "Pro", priceCents: 2900, interval: "month", lsVariantId: "var_pro" }] }),
          { status: 200 }
        ),
    };
    const originalFetch = globalThis.fetch;
    let capturedBody: { data: { attributes: { checkout_data: { custom: Record<string, string> } } } } | null = null;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init!.body as string);
      return new Response(JSON.stringify({ data: { attributes: { url: "https://checkout.lemonsqueezy.com/real" } } }), { status: 200 });
    }) as typeof fetch;
    try {
      const req = await withToken(internalReq("/internal/business-subscriptions/checkout", { business_space_id: "biz-1", plan_id: "pro" }));
      const res = await billingWorker.fetch(
        req,
        makeEnv({ SPACES_WORKER: spacesWorker, LEMON_SQUEEZY_API_KEY: "key", LEMON_SQUEEZY_STORE_ID: "store" }) as never,
        execCtx
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { checkout_url: string; dev?: boolean };
      expect(body.checkout_url).toBe("https://checkout.lemonsqueezy.com/real");
      expect(body.dev).toBeUndefined();
      expect(capturedBody!.data.attributes.checkout_data.custom).toMatchObject({
        kind: "business_subscription",
        plan_id: "pro",
        product_space_id: "prod-root",
        spaceId: "biz-1",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("POST /internal/credit-packs/checkout", () => {
  it("requires end_user_id in addition to business_space_id and pack_id", async () => {
    const req = await withToken(internalReq("/internal/credit-packs/checkout", { business_space_id: "biz-1", pack_id: "pack-1" }));
    const res = await billingWorker.fetch(req, makeEnv() as never, execCtx);
    expect(res.status).toBe(400);
  });

  it("returns the dev placeholder and carries end_user_id + credits in metadata for the webhook to grant against", async () => {
    const spacesWorker = {
      fetch: async () =>
        new Response(
          JSON.stringify({ product_space_id: "prod-root", credit_packs: [{ id: "pack-1", name: "Pack", credits: 1000, priceCents: 500 }] }),
          { status: 200 }
        ),
    };
    const req = await withToken(
      internalReq("/internal/credit-packs/checkout", { business_space_id: "biz-1", pack_id: "pack-1", end_user_id: "alice" })
    );
    const res = await billingWorker.fetch(req, makeEnv({ SPACES_WORKER: spacesWorker }) as never, execCtx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dev: boolean; pack: { credits: number } };
    expect(body.dev).toBe(true);
    expect(body.pack.credits).toBe(1000);
  });
});

// ── Webhook-side handling (business subscription state + credit pack grant) ──────────────────

function lsSubscriptionPayload(eventName: string, custom: Record<string, string>, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    meta: { event_name: eventName },
    data: { id: "sub_123", attributes: { total: "2900", currency: "USD", customer_id: "cust_1", custom_data: custom, status: "active", renews_at: "2026-08-01T00:00:00Z", ...extra } },
  });
}

function lsOrderPayload(eventName: string, custom: Record<string, string>) {
  return JSON.stringify({
    meta: { event_name: eventName, custom_data: custom },
    data: { id: "order_123", attributes: { total: "500", currency: "USD", customer_id: "cust_1" } },
  });
}

async function signedWebhookReq(rawBody: string, secret: string): Promise<Request> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const sig = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return new Request("https://billing.naelao.com/webhooks/lemon-squeezy", {
    method: "POST",
    headers: { "X-Signature": sig },
    body: rawBody,
  });
}

describe("Lemon Squeezy webhook — business subscription state", () => {
  it("upserts a business_subscriptions row on subscription_created", async () => {
    const inserts: Array<{ sql: string; args: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        let bound: unknown[] = [];
        return {
          bind(...a: unknown[]) { bound = a; return this; },
          async first() {
            if (/FROM spaces WHERE id = \?/.test(sql)) return { tenant_id: "tenant-1" };
            if (/FROM tenant_hierarchy/.test(sql)) return null;
            return null;
          },
          async run() {
            if (/INSERT INTO business_subscriptions/.test(sql)) inserts.push({ sql, args: bound });
            return { meta: { changes: 1 } };
          },
        };
      },
    };
    const agentsWorker = { fetch: async () => new Response("{}") };
    const req = await signedWebhookReq(
      lsSubscriptionPayload("subscription_created", { spaceId: "biz-1", kind: "business_subscription", plan_id: "pro", product_space_id: "prod-root" }),
      "whsec_real"
    );
    const res = await billingWorker.fetch(
      req,
      makeEnv({ PLATFORM_DB: db, AGENTS_WORKER: agentsWorker, LEMON_SQUEEZY_WEBHOOK_SECRET: "whsec_real" }) as never,
      execCtx
    );
    expect(res.status).toBe(200);
    expect(inserts).toHaveLength(1);
    // args: id, business_space_id, product_space_id, plan_id, status, ls_subscription_id, ls_customer_id, current_period_end, provider_event_at, updated_at, event type
    expect(inserts[0]!.args[1]).toBe("biz-1");
    expect(inserts[0]!.args[2]).toBe("prod-root");
    expect(inserts[0]!.args[3]).toBe("pro");
    expect(inserts[0]!.args[4]).toBe("active");
    expect(inserts[0]!.sql).toContain("excluded.provider_event_at > business_subscriptions.provider_event_at");
    expect(inserts[0]!.args.at(-1)).toBe("subscription.created");
  });

  it("maps subscription_cancelled to status=cancelled regardless of the raw LS status field", async () => {
    const inserts: unknown[][] = [];
    const db = {
      prepare(sql: string) {
        let bound: unknown[] = [];
        return {
          bind(...a: unknown[]) { bound = a; return this; },
          async first() {
            if (/FROM spaces WHERE id = \?/.test(sql)) return { tenant_id: "tenant-1" };
            return null;
          },
          async run() {
            if (/INSERT INTO business_subscriptions/.test(sql)) inserts.push(bound);
            return { meta: { changes: 1 } };
          },
        };
      },
    };
    const req = await signedWebhookReq(
      lsSubscriptionPayload("subscription_cancelled", { spaceId: "biz-1", kind: "business_subscription", plan_id: "pro", product_space_id: "prod-root" }, { status: "active" }),
      "whsec_real"
    );
    await billingWorker.fetch(
      req,
      makeEnv({ PLATFORM_DB: db, AGENTS_WORKER: { fetch: async () => new Response("{}") }, LEMON_SQUEEZY_WEBHOOK_SECRET: "whsec_real" }) as never,
      execCtx
    );
    expect(inserts[0]![4]).toBe("cancelled");
  });

  it("does nothing for a subscription event that isn't a business_subscription (e.g. a seat)", async () => {
    const inserts: unknown[] = [];
    const db = {
      prepare(sql: string) {
        return {
          bind() { return this; },
          async first() {
            if (/FROM spaces WHERE id = \?/.test(sql)) return { tenant_id: "tenant-1" };
            return null;
          },
          async run() {
            if (/INSERT INTO business_subscriptions/.test(sql)) inserts.push(1);
            return { meta: { changes: 1 } };
          },
        };
      },
    };
    const req = await signedWebhookReq(lsSubscriptionPayload("subscription_created", { spaceId: "biz-1", kind: "seat" }), "whsec_real");
    await billingWorker.fetch(
      req,
      makeEnv({ PLATFORM_DB: db, AGENTS_WORKER: { fetch: async () => new Response("{}") }, LEMON_SQUEEZY_WEBHOOK_SECRET: "whsec_real" }) as never,
      execCtx
    );
    expect(inserts).toHaveLength(0);
  });

  it("does not create an active business subscription from an initial failed payment", async () => {
    const inserts: unknown[] = [];
    const updates: Array<{ sql: string; args: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        let bound: unknown[] = [];
        return {
          bind(...values: unknown[]) { bound = values; return this; },
          async first() {
            if (/FROM spaces WHERE id = \?/.test(sql)) return { tenant_id: "tenant-1" };
            return null;
          },
          async run() {
            if (/INSERT INTO business_subscriptions/.test(sql)) inserts.push(sql);
            if (/UPDATE business_subscriptions SET status = 'past_due'/.test(sql)) updates.push({ sql, args: bound });
            return { meta: { changes: 1 } };
          },
        };
      },
    };
    const req = await signedWebhookReq(
      lsSubscriptionPayload("subscription_payment_failed", {
        spaceId: "biz-1", kind: "business_subscription", plan_id: "pro", product_space_id: "prod-root",
      }),
      "whsec_real"
    );
    const res = await billingWorker.fetch(
      req,
      makeEnv({ PLATFORM_DB: db, AGENTS_WORKER: { fetch: async () => new Response("{}") }, LEMON_SQUEEZY_WEBHOOK_SECRET: "whsec_real" }) as never,
      execCtx
    );
    expect(res.status).toBe(200);
    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.sql).toContain("ls_subscription_id = ?");
    expect(updates[0]?.args).toEqual([null, expect.any(String), "biz-1", "prod-root", "pro", "sub_123", null, null, null]);
  });

  it("migration-backed lifecycle writes ignore stale replaced-subscription events", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { createFakeD1 } = await import("../stubs/d1-sqlite.js");
    const migration = (file: string) => readFileSync(join(__dirname, "../../infra/migrations/", file), "utf8");
    const db = createFakeD1([
      migration("0004_billing.sql"),
      migration("0062_subscriptions_lemon_squeezy.sql"),
      migration("0067_subscriptions_whop_platform_plan.sql"),
      migration("0049_business_subscriptions.sql"),
      migration("0125_subscription_event_ordering.sql"),
    ]);
    const { recordBusinessSubscription } = await import("../../workers/billing/src/lemon-squeezy.js");
    const event = (type: "subscription.created" | "subscription.expired", subscriptionId: string, providerUpdatedAt: string) => ({
      type, provider: "lemon_squeezy" as const, spaceId: "biz-1", customerId: "cust-1", subscriptionId,
      providerEventId: `${subscriptionId}:${providerUpdatedAt}`, variantOrPriceId: "pro", amountCents: 2900,
      currency: "USD", metadata: { kind: "business_subscription", plan_id: "pro", product_space_id: "prod-root" },
      providerUpdatedAt,
    });
    await recordBusinessSubscription(event("subscription.created", "sub-old", "2026-04-01T00:00:00.000Z"), { PLATFORM_DB: db } as never);
    await recordBusinessSubscription(event("subscription.created", "sub-current", "2026-05-01T00:00:00.000Z"), { PLATFORM_DB: db } as never);
    await recordBusinessSubscription(event("subscription.expired", "sub-old", "2026-04-15T00:00:00.000Z"), { PLATFORM_DB: db } as never);
    const row = await db.prepare("SELECT status, ls_subscription_id, provider_event_at FROM business_subscriptions WHERE business_space_id = ?")
      .bind("biz-1").first();
    expect(row).toMatchObject({ status: "active", ls_subscription_id: "sub-current", provider_event_at: "2026-05-01T00:00:00.000Z" });
  });
});

describe("Lemon Squeezy webhook — credit pack grant", () => {
  it("calls the spaces worker's credit-pack grant route on payment.success with kind=credit_pack", async () => {
    const grantCalls: Array<{ body: { end_user_id: string; credits: number; product_space_id: string; idempotency_key: string } }> = [];
    const db = {
      prepare(sql: string) {
        return {
          bind() { return this; },
          async first() {
            if (/FROM spaces WHERE id = \?/.test(sql)) return { tenant_id: "tenant-1" };
            return null;
          },
          async run() { return { meta: { changes: 1 } }; },
        };
      },
    };
    const spacesWorker = {
      fetch: async (r: Request) => {
        grantCalls.push({ body: await r.json() });
        return new Response(JSON.stringify({ balance_credits: 1000 }), { status: 201 });
      },
    };
    const req = await signedWebhookReq(
      lsOrderPayload("order_created", { spaceId: "biz-1", kind: "credit_pack", pack_id: "pack-1", end_user_id: "alice", credits: "1000", product_space_id: "prod-root" }),
      "whsec_real"
    );
    const res = await billingWorker.fetch(
      req,
      makeEnv({ PLATFORM_DB: db, SPACES_WORKER: spacesWorker, AGENTS_WORKER: { fetch: async () => new Response("{}") }, LEMON_SQUEEZY_WEBHOOK_SECRET: "whsec_real" }) as never,
      execCtx
    );
    expect(res.status).toBe(200);
    expect(grantCalls).toHaveLength(1);
    expect(grantCalls[0]!.body).toMatchObject({ end_user_id: "alice", credits: 1000, product_space_id: "prod-root" });
    expect(grantCalls[0]!.body.idempotency_key).toBeTruthy();
  });

  it("does not call the grant route for an order that isn't a credit pack (e.g. a launchpad product sale)", async () => {
    let grantCalled = false;
    const db = {
      prepare(sql: string) {
        return {
          bind() { return this; },
          async first() {
            if (/FROM spaces WHERE id = \?/.test(sql)) return { tenant_id: "tenant-1" };
            if (/FROM launchpad_products/.test(sql)) return null;
            return null;
          },
          async run() { return { meta: { changes: 1 } }; },
        };
      },
    };
    // Also called (harmlessly) by the unrelated resolveFulfillmentProjectId step every event goes
    // through — only flag the credit-pack grant path specifically, not any SPACES_WORKER call.
    const spacesWorker = {
      fetch: async (r: Request) => {
        if (new URL(r.url).pathname === "/internal/credit-packs/grant") grantCalled = true;
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      },
    };
    const req = await signedWebhookReq(lsOrderPayload("order_created", { spaceId: "biz-1", product_id: "prod-x", fee_bps: "500" }), "whsec_real");
    await billingWorker.fetch(
      req,
      makeEnv({ PLATFORM_DB: db, SPACES_WORKER: spacesWorker, AGENTS_WORKER: { fetch: async () => new Response("{}") }, LEMON_SQUEEZY_WEBHOOK_SECRET: "whsec_real" }) as never,
      execCtx
    );
    expect(grantCalled).toBe(false);
  });

  it("returns retryable failure and releases the event claim when a paid credit pack is missing grant metadata", async () => {
    const writes: string[] = [];
    const db = {
      prepare(sql: string) {
        const stmt = {
          bind() { return stmt; },
          async first() {
            if (/FROM spaces WHERE id = \?/.test(sql)) return { tenant_id: "tenant-1" };
            return null;
          },
          async run() { writes.push(sql); return { meta: { changes: 1 } }; },
        };
        return stmt;
      },
    };
    const req = await signedWebhookReq(
      lsOrderPayload("order_created", { spaceId: "biz-1", kind: "credit_pack", credits: "500" }),
      "whsec_real"
    );
    const res = await billingWorker.fetch(req, makeEnv({
      PLATFORM_DB: db,
      SPACES_WORKER: { fetch: async () => new Response("unexpected") },
      AGENTS_WORKER: { fetch: async () => new Response("{}") },
      LEMON_SQUEEZY_WEBHOOK_SECRET: "whsec_real",
    }) as never, execCtx);
    expect(res.status).toBe(500);
    expect(writes.some((sql) => sql.includes("DELETE FROM processed_webhook_events"))).toBe(true);
  });
});
