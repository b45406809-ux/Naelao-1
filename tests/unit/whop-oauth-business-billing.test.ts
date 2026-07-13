import { describe, it, expect, afterEach } from "vitest";
import billingWorker from "../../workers/billing/src/index.js";
import { mintInternalToken } from "@naelao/http";

// End-user subscriptions/credit-packs settling into a BUSINESS's own connected Whop company (via
// the "Connect with Whop" OAuth flow, AUDIT_TODO.md AI-7) — tried before Lemon Squeezy. A business
// with no Whop OAuth connection falls through unchanged to the existing LS/dev-placeholder path
// (already covered by business-subscriptions-billing.test.ts).

const SECRET = "test-platform-secret";
const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

interface Call { url: string; headers: Record<string, string>; body: unknown }
let calls: Call[] = [];
const realFetch = globalThis.fetch;

function mockWhopApiFetch(responses: Record<string, unknown>) {
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
          if (/FROM spaces WHERE id = \?/.test(sql)) return { tenant_id: "tenant-1" };
          return null;
        },
        async run() { return { meta: { changes: 1 } }; },
      };
      return stmt;
    },
  };
  return { ENVIRONMENT: "test", PLATFORM_SECRET: SECRET, PLATFORM_DB: db, ...overrides };
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

/** A CREDENTIALS_WORKER stub that resolves a vaulted OAuth token blob for WHOP_OAUTH_TOKENS. */
function credentialsWorkerWithWhopOAuth(tokenValue: Record<string, unknown>) {
  return {
    fetch: async (req: Request) => {
      if (new URL(req.url).pathname.includes("/credentials/WHOP_OAUTH_TOKENS/plaintext")) {
        return Response.json({ value: JSON.stringify(tokenValue) });
      }
      return new Response("not found", { status: 404 });
    },
  };
}

const FRESH_TOKEN = { access_token: "biz-access-tok", refresh_token: "biz-refresh-tok", expires_at: Date.now() + 3_600_000 };

describe("POST /internal/business-subscriptions/checkout — Whop OAuth tried first", () => {
  it("uses the business's own connected Whop company when it has a vaulted OAuth token", async () => {
    mockWhopApiFetch({
      "/access_passes": { id: "ap_biz" },
      "/plans": { id: "plan_biz" },
      "/checkout_configurations": { checkout_url: "https://whop.com/checkout/biz-sub" },
    });
    const spacesWorker = {
      fetch: async () =>
        new Response(
          JSON.stringify({ product_space_id: "prod-root", plans: [{ id: "pro", name: "Pro", priceCents: 2900, interval: "month", lsVariantId: "var_pro" }] }),
          { status: 200 }
        ),
    };
    const req = await withToken(internalReq("/internal/business-subscriptions/checkout", { business_space_id: "biz-1", plan_id: "pro" }));
    const res = await billingWorker.fetch(
      req,
      makeEnv({
        SPACES_WORKER: spacesWorker,
        CREDENTIALS_WORKER: credentialsWorkerWithWhopOAuth(FRESH_TOKEN),
        // LS is ALSO configured here to prove Whop wins when both are available.
        LEMON_SQUEEZY_API_KEY: "key", LEMON_SQUEEZY_STORE_ID: "store",
      }) as never,
      execCtx
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { checkout_url: string; provider?: string };
    expect(body.checkout_url).toBe("https://whop.com/checkout/biz-sub");
    expect(body.provider).toBe("whop");
    // Every Whop call used the BUSINESS's own token, never a Naelao master key.
    for (const call of calls) expect(call.headers["authorization"]).toBe("Bearer biz-access-tok");
  });

  it("falls through to LS when CREDENTIALS_WORKER has no Whop OAuth connection for this business", async () => {
    const spacesWorker = {
      fetch: async () =>
        new Response(
          JSON.stringify({ product_space_id: "prod-root", plans: [{ id: "pro", name: "Pro", priceCents: 2900, interval: "month", lsVariantId: "var_pro" }] }),
          { status: 200 }
        ),
    };
    const noConnectionCredentials = { fetch: async () => new Response("not found", { status: 404 }) };
    globalThis.fetch = (async () => Response.json({ data: { attributes: { url: "https://checkout.lemonsqueezy.com/fallback" } } })) as typeof fetch;
    const req = await withToken(internalReq("/internal/business-subscriptions/checkout", { business_space_id: "biz-1", plan_id: "pro" }));
    const res = await billingWorker.fetch(
      req,
      makeEnv({ SPACES_WORKER: spacesWorker, CREDENTIALS_WORKER: noConnectionCredentials, LEMON_SQUEEZY_API_KEY: "key", LEMON_SQUEEZY_STORE_ID: "store" }) as never,
      execCtx
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { checkout_url: string; provider?: string };
    expect(body.checkout_url).toBe("https://checkout.lemonsqueezy.com/fallback");
    expect(body.provider).toBeUndefined();
  });
});

describe("POST /internal/credit-packs/checkout — Whop OAuth tried first", () => {
  it("uses the business's own connected Whop company for a one-time credit pack", async () => {
    mockWhopApiFetch({
      "/access_passes": { id: "ap_biz" },
      "/plans": { id: "plan_pack" },
      "/checkout_configurations": { checkout_url: "https://whop.com/checkout/biz-pack" },
    });
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
    const res = await billingWorker.fetch(
      req,
      makeEnv({ SPACES_WORKER: spacesWorker, CREDENTIALS_WORKER: credentialsWorkerWithWhopOAuth(FRESH_TOKEN) }) as never,
      execCtx
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { checkout_url: string; provider?: string };
    expect(body.checkout_url).toBe("https://whop.com/checkout/biz-pack");
    expect(body.provider).toBe("whop");
    const planBody = calls.find((c) => c.url.includes("/plans"))!.body as { plan_type: string };
    expect(planBody.plan_type).toBe("one_time");
  });
});

describe("getBusinessWhopOAuthToken refresh path (exercised indirectly via checkout)", () => {
  it("proactively refreshes a near-expiry token via the agents worker before using it", async () => {
    const nearExpiry = { access_token: "stale-tok", refresh_token: "refresh-me", expires_at: Date.now() + 60_000 }; // < 5 min buffer
    let refreshCalled = false;
    const agentsWorker = {
      fetch: async (req: Request) => {
        if (new URL(req.url).pathname.includes("/internal/connectors/oauth/refresh")) {
          refreshCalled = true;
          return Response.json({ access_token: "fresh-tok" });
        }
        return new Response("not found", { status: 404 });
      },
    };
    mockWhopApiFetch({
      "/access_passes": { id: "ap_biz" },
      "/plans": { id: "plan_biz" },
      "/checkout_configurations": { checkout_url: "https://whop.com/checkout/refreshed" },
    });
    const spacesWorker = {
      fetch: async () =>
        new Response(
          JSON.stringify({ product_space_id: "prod-root", plans: [{ id: "pro", name: "Pro", priceCents: 2900, interval: "month" }] }),
          { status: 200 }
        ),
    };
    const req = await withToken(internalReq("/internal/business-subscriptions/checkout", { business_space_id: "biz-1", plan_id: "pro" }));
    const res = await billingWorker.fetch(
      req,
      makeEnv({ SPACES_WORKER: spacesWorker, CREDENTIALS_WORKER: credentialsWorkerWithWhopOAuth(nearExpiry), AGENTS_WORKER: agentsWorker }) as never,
      execCtx
    );
    expect(res.status).toBe(200);
    expect(refreshCalled).toBe(true);
    const whopCalls = calls.filter((c) => c.url.includes("api.whop.com"));
    expect(whopCalls[0]!.headers["authorization"]).toBe("Bearer fresh-tok");
  });
});
