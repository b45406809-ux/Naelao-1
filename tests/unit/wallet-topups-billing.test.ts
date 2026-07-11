import { describe, it, expect } from "vitest";
import billingWorker from "../../workers/billing/src/index.js";
import { mintInternalToken } from "@naelao/http";

// Launchpad Wallet (user-directed feature): a business topping up its OWN wallet_ledger balance
// via a fixed-price Lemon Squeezy checkout — same shape as credit-packs/business-subscriptions
// checkout, but the proceeds fund the business's wallet project, not an individual end user.

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

describe("POST /internal/wallet-topups/checkout", () => {
  it("requires business_space_id, project_id, and topup_id", async () => {
    const req = await withToken(internalReq("/internal/wallet-topups/checkout", { business_space_id: "biz-1" }));
    const res = await billingWorker.fetch(req, makeEnv() as never, execCtx);
    expect(res.status).toBe(400);
  });

  it("returns the dev placeholder when the topup has no lsVariantId / no LS creds", async () => {
    const spacesWorker = {
      fetch: async () =>
        new Response(
          JSON.stringify({ product_space_id: "prod-root", wallet_topups: [{ id: "topup-25", name: "$25", priceCents: 2500 }] }),
          { status: 200 }
        ),
    };
    const req = await withToken(
      internalReq("/internal/wallet-topups/checkout", { business_space_id: "biz-1", project_id: "proj-1", topup_id: "topup-25" })
    );
    const res = await billingWorker.fetch(req, makeEnv({ SPACES_WORKER: spacesWorker }) as never, execCtx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { checkout_url: string; dev: boolean; topup: { id: string; price_cents: number } };
    expect(body.dev).toBe(true);
    expect(body.topup.id).toBe("topup-25");
    expect(body.topup.price_cents).toBe(2500);
  });

  it("404s when the topup id doesn't exist in the catalog", async () => {
    const spacesWorker = {
      fetch: async () => new Response(JSON.stringify({ product_space_id: "prod-root", wallet_topups: [] }), { status: 200 }),
    };
    const req = await withToken(
      internalReq("/internal/wallet-topups/checkout", { business_space_id: "biz-1", project_id: "proj-1", topup_id: "nonexistent" })
    );
    const res = await billingWorker.fetch(req, makeEnv({ SPACES_WORKER: spacesWorker }) as never, execCtx);
    expect(res.status).toBe(404);
  });

  it("creates a real LS checkout carrying kind=wallet_topup + project_id + cents in metadata", async () => {
    const spacesWorker = {
      fetch: async () =>
        new Response(
          JSON.stringify({ product_space_id: "prod-root", wallet_topups: [{ id: "topup-25", name: "$25", priceCents: 2500, lsVariantId: "var_topup25" }] }),
          { status: 200 }
        ),
    };
    const originalFetch = globalThis.fetch;
    let capturedBody: { data: { attributes: { checkout_data: { custom: Record<string, string> } } } } | null = null;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init!.body as string);
      return new Response(JSON.stringify({ data: { attributes: { url: "https://checkout.lemonsqueezy.com/wallet" } } }), { status: 200 });
    }) as typeof fetch;
    try {
      const req = await withToken(
        internalReq("/internal/wallet-topups/checkout", { business_space_id: "biz-1", project_id: "proj-1", topup_id: "topup-25" })
      );
      const res = await billingWorker.fetch(
        req,
        makeEnv({ SPACES_WORKER: spacesWorker, LEMON_SQUEEZY_API_KEY: "key", LEMON_SQUEEZY_STORE_ID: "store" }) as never,
        execCtx
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { checkout_url: string; dev?: boolean };
      expect(body.checkout_url).toBe("https://checkout.lemonsqueezy.com/wallet");
      expect(body.dev).toBeUndefined();
      expect(capturedBody!.data.attributes.checkout_data.custom).toMatchObject({
        kind: "wallet_topup",
        topup_id: "topup-25",
        cents: "2500",
        project_id: "proj-1",
        product_space_id: "prod-root",
        spaceId: "biz-1",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ── Webhook-side handling (wallet-topup grant) ────────────────────────────────────────────────

function lsOrderPayload(eventName: string, custom: Record<string, string>) {
  return JSON.stringify({
    meta: { event_name: eventName, custom_data: custom },
    data: { id: "order_123", attributes: { total: "2500", currency: "USD", customer_id: "cust_1" } },
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

describe("Lemon Squeezy webhook — wallet top-up grant", () => {
  it("calls the spaces worker's wallet-topups grant route on payment.success with kind=wallet_topup", async () => {
    const grantCalls: Array<{ body: { business_space_id: string; project_id: string; cents: number; idempotency_key: string } }> = [];
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
        if (new URL(r.url).pathname === "/internal/wallet-topups/grant") {
          grantCalls.push({ body: await r.json() });
          return new Response(JSON.stringify({ balance_cents: 2500 }), { status: 201 });
        }
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      },
    };
    const req = await signedWebhookReq(
      lsOrderPayload("order_created", { spaceId: "biz-1", kind: "wallet_topup", topup_id: "topup-25", cents: "2500", project_id: "proj-1", product_space_id: "prod-root" }),
      "whsec_real"
    );
    const res = await billingWorker.fetch(
      req,
      makeEnv({ PLATFORM_DB: db, SPACES_WORKER: spacesWorker, AGENTS_WORKER: { fetch: async () => new Response("{}") }, LEMON_SQUEEZY_WEBHOOK_SECRET: "whsec_real" }) as never,
      execCtx
    );
    expect(res.status).toBe(200);
    expect(grantCalls).toHaveLength(1);
    expect(grantCalls[0]!.body).toMatchObject({ business_space_id: "biz-1", project_id: "proj-1", cents: 2500 });
    expect(grantCalls[0]!.body.idempotency_key).toBeTruthy();
  });

  it("does not call the wallet-topup grant route for an order that isn't a wallet top-up (e.g. a launchpad product sale)", async () => {
    let walletGrantCalled = false;
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
    const spacesWorker = {
      fetch: async (r: Request) => {
        if (new URL(r.url).pathname === "/internal/wallet-topups/grant") walletGrantCalled = true;
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      },
    };
    const req = await signedWebhookReq(lsOrderPayload("order_created", { spaceId: "biz-1", product_id: "prod-x", fee_bps: "500" }), "whsec_real");
    await billingWorker.fetch(
      req,
      makeEnv({ PLATFORM_DB: db, SPACES_WORKER: spacesWorker, AGENTS_WORKER: { fetch: async () => new Response("{}") }, LEMON_SQUEEZY_WEBHOOK_SECRET: "whsec_real" }) as never,
      execCtx
    );
    expect(walletGrantCalled).toBe(false);
  });
});
