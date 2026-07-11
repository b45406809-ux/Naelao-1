import { describe, it, expect } from "vitest";
import billingWorker from "../../workers/billing/src/index.js";
import { mintInternalToken } from "@naelao/http";

// Go-live monetization pass: bills a builder-configured cut % of a business's tracked EXTERNAL
// revenue (Whop, via the revenue-tracker prebuilt) as a surcharge — the only mechanism that can
// give the builder/Naelao a cut of a sale that never flows through Naelao's own Lemon Squeezy
// custody. POST /internal/revenue-cut-surcharge/checkout is the entry point (spaces worker mocked
// for pricing-catalog + revenue-tracking); reseller_ledger attribution on the eventual payment is
// exercised end-to-end separately in the money-integrity suites (recordResellerAttribution is
// unconditional for every payment.success — no new code needed there).

const SECRET = "test-platform-secret";
const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

interface Call { url: string; method: string; body: unknown }

function makeEnv(opts: {
  cut?: { enabled: boolean; cutBps: number; lsVariantId?: string } | null;
  snapshots?: Array<{ period: string; revenue_cents: number; billed: boolean; billed_cents?: number; pending_checkout_at?: string | null }>;
  hasLsCreds?: boolean;
} = {}) {
  const { cut = { enabled: true, cutBps: 500, lsVariantId: "variant-surcharge" }, snapshots = [], hasLsCreds = false } = opts;
  const calls: Call[] = [];
  const db = {
    prepare(sql: string) {
      const stmt = {
        bind() { return stmt; },
        async first() {
          if (/FROM spaces WHERE/.test(sql)) return { tenant_id: "tenant-1" };
          return null;
        },
      };
      return stmt;
    },
  };
  const spacesWorker = {
    async fetch(reqInput: Request | string, init?: RequestInit) {
      const req = typeof reqInput === "string" ? new Request(reqInput, init) : reqInput;
      calls.push({ url: req.url, method: req.method, body: null });
      if (req.url.includes("/internal/pricing-catalog")) {
        return Response.json({ product_space_id: "product-root", external_revenue_cut: cut });
      }
      if (req.url.includes("/revenue-tracking")) {
        return Response.json({ snapshots });
      }
      return new Response("not found", { status: 404 });
    },
  };
  const env = {
    ENVIRONMENT: "test",
    PLATFORM_SECRET: SECRET,

    PLATFORM_DB: db,
    SPACES_WORKER: spacesWorker,
    ...(hasLsCreds ? { LEMON_SQUEEZY_API_KEY: "ls_test", LEMON_SQUEEZY_STORE_ID: "store_1" } : {}),
  };
  return { env, calls };
}

async function post(env: unknown, body: unknown): Promise<Response> {
  const token = await mintInternalToken(SECRET, "tenant-1");
  return billingWorker.fetch(
    new Request("https://billing.naelao.com/internal/revenue-cut-surcharge/checkout", {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token },
      body: JSON.stringify(body),
    }),
    env as never, execCtx
  );
}

describe("POST /internal/revenue-cut-surcharge/checkout", () => {
  it("requires a verified internal token", async () => {
    const { env } = makeEnv();
    const res = await billingWorker.fetch(
      new Request("https://billing.naelao.com/internal/revenue-cut-surcharge/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ business_space_id: "space-1" }),
      }),
      env as never, execCtx
    );
    expect(res.status).toBe(403);
  });

  it("sums unbilled periods and computes the surcharge at the configured cut %", async () => {
    const { env } = makeEnv({
      snapshots: [
        { period: "2026-06", revenue_cents: 100_000, billed: false },
        { period: "2026-07", revenue_cents: 50_000, billed: false },
      ],
    });
    const res = await post(env, { business_space_id: "space-1" });
    expect(res.status).toBe(200);
    const body = await res.json() as { surcharge_cents: number; periods: string[]; dev?: boolean };
    // (100000 + 50000) * 500bps / 10000 = 7500
    expect(body.surcharge_cents).toBe(7500);
    expect(body.periods).toEqual(["2026-06", "2026-07"]);
    expect(body.dev).toBe(true); // no LS creds in this test env -> dev fallback
  });

  it("ignores already-billed periods (F-27: delta is zero when billed_cents == cut(revenue))", async () => {
    const { env } = makeEnv({
      snapshots: [
        // Already fully billed: cut = 100000*5% = 5000, billed_cents = 5000 → delta 0.
        { period: "2026-06", revenue_cents: 100_000, billed: true, billed_cents: 5000 },
        { period: "2026-07", revenue_cents: 20_000, billed: false, billed_cents: 0 },
      ],
    });
    const res = await post(env, { business_space_id: "space-1" });
    const body = await res.json() as { surcharge_cents: number; periods: string[] };
    expect(body.surcharge_cents).toBe(1000); // only the unbilled 20000 * 5%
    expect(body.periods).toEqual(["2026-07"]);
  });

  it("F-27: a corrected-UP already-billed period bills only the delta, not the full figure", async () => {
    const { env } = makeEnv({
      // Period was billed at 100k (cut 5000 collected). Revenue corrected up to 120k.
      // Owed now 6000; already 5000 → delta 1000, NOT 6000.
      snapshots: [{ period: "2026-06", revenue_cents: 120_000, billed: true, billed_cents: 5000 }],
    });
    const res = await post(env, { business_space_id: "space-1" });
    const body = await res.json() as { surcharge_cents: number; periods: string[] };
    expect(body.surcharge_cents).toBe(1000);
    expect(body.periods).toEqual(["2026-06"]);
  });

  it("F-31: skips a period with an in-flight (recent) checkout", async () => {
    const { env } = makeEnv({
      snapshots: [{ period: "2026-06", revenue_cents: 100_000, billed: false, billed_cents: 0, pending_checkout_at: new Date().toISOString().replace("T", " ").slice(0, 19) }],
    });
    const res = await post(env, { business_space_id: "space-1" });
    expect(res.status).toBe(404); // the only billable period is pending → nothing to bill
  });

  it("404s when revenue-cut billing is not enabled for this product", async () => {
    const { env } = makeEnv({ cut: { enabled: false, cutBps: 500 } });
    const res = await post(env, { business_space_id: "space-1" });
    expect(res.status).toBe(404);
  });

  it("404s when there is nothing unbilled to charge", async () => {
    const { env } = makeEnv({ snapshots: [{ period: "2026-06", revenue_cents: 5000, billed: true, billed_cents: 250 }] });
    const res = await post(env, { business_space_id: "space-1" });
    expect(res.status).toBe(404);
  });

  it("passes a custom-price override matching the computed surcharge to the LS checkout", async () => {
    const { env } = makeEnv({
      snapshots: [{ period: "2026-06", revenue_cents: 200_000, billed: false }],
      hasLsCreds: true,
    });
    // Real network calls to LS are not exercised in this unit-test harness; assert the request
    // this route builds by intercepting global fetch (LemonSqueezyProvider.createCheckout uses
    // the ambient fetch, not a binding).
    const originalFetch = globalThis.fetch;
    let capturedBody: string | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({ data: { attributes: { url: "https://checkout.lemonsqueezy.com/x" } } }), { status: 200 });
    }) as typeof fetch;
    try {
      const res = await post(env, { business_space_id: "space-1" });
      expect(res.status).toBe(200);
      const body = await res.json() as { surcharge_cents: number; checkout_url: string };
      expect(body.surcharge_cents).toBe(10_000); // 200000 * 5%
      expect(body.checkout_url).toBe("https://checkout.lemonsqueezy.com/x");
      expect(capturedBody).toBeDefined();
      const parsed = JSON.parse(capturedBody!) as { data: { attributes: { checkout_data: { custom_price: number; custom: Record<string, string> } } } };
      expect(parsed.data.attributes.checkout_data.custom_price).toBe(10_000);
      expect(parsed.data.attributes.checkout_data.custom.kind).toBe("revenue_cut_surcharge");
      expect(parsed.data.attributes.checkout_data.custom.periods).toBe("2026-06");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("Lemon Squeezy webhook — revenue-cut surcharge payment marks periods billed", () => {
  it("calls mark-billed with the periods from checkout metadata on payment.success", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { createFakeD1 } = await import("../stubs/d1-sqlite.js");
    const { handleLemonSqueezyWebhook } = await import("../../workers/billing/src/lemon-squeezy.js");

    const SPACES_SQL = `CREATE TABLE spaces (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active');`;
    const RESELLER_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0033_reseller_accounts.sql"), "utf8");
    const COMMERCE_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0035_commerce.sql"), "utf8");
    const WEBHOOK_IDEMPOTENCY_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0050_webhook_idempotency.sql"), "utf8");
    const WEBHOOK_IDEMPOTENCY_EVENT_TYPE_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0052_webhook_idempotency_event_type.sql"), "utf8");
    const fakeDb = createFakeD1([SPACES_SQL, RESELLER_MIGRATION, COMMERCE_MIGRATION, WEBHOOK_IDEMPOTENCY_MIGRATION, WEBHOOK_IDEMPOTENCY_EVENT_TYPE_MIGRATION]);
    await fakeDb.prepare("INSERT INTO spaces (id, tenant_id, status) VALUES (?, ?, 'active')").bind("space-1", "tenant-1").run();

    const markBilledCalls: Array<{ url: string; body: unknown }> = [];
    const spacesWorker = {
      async fetch(reqInput: Request | string, init?: RequestInit) {
        const req = typeof reqInput === "string" ? new Request(reqInput, init) : reqInput;
        if (req.url.includes("mark-billed")) {
          const body = await req.clone().json().catch(() => null);
          markBilledCalls.push({ url: req.url, body });
          return Response.json({ billed_periods: (body as { periods?: string[] })?.periods ?? [] });
        }
        return new Response("not found", { status: 404 });
      },
    };

    const webhookSecret = "whsec_test";
    const rawBody = JSON.stringify({
      meta: {
        event_name: "order_created",
        custom_data: { spaceId: "space-1", kind: "revenue_cut_surcharge", periods: "2026-06,2026-07" },
      },
      data: {
        id: "ord_surcharge_1",
        attributes: {
          total: 7500, currency: "USD", customer_id: "cust_1",
          custom_data: { spaceId: "space-1", kind: "revenue_cut_surcharge", periods: "2026-06,2026-07" },
        },
      },
    });
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(webhookSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
    const sig = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");

    const fullEnv = {
      PLATFORM_SECRET: SECRET,
      PLATFORM_DB: fakeDb,
      LEMON_SQUEEZY_WEBHOOK_SECRET: webhookSecret,
      AGENTS_WORKER: { fetch: async () => new Response("{}") },
      SPACES_WORKER: spacesWorker,
    };
    const res = await handleLemonSqueezyWebhook(
      new Request("https://billing.naelao.com/webhooks/lemon-squeezy", { method: "POST", headers: { "X-Signature": sig }, body: rawBody }),
      fullEnv as never
    );
    expect(res.status).toBe(200);

    expect(markBilledCalls).toHaveLength(1);
    expect(markBilledCalls[0]!.body).toMatchObject({ periods: ["2026-06", "2026-07"] });
  });
});
