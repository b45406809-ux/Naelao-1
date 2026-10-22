import { describe, it, expect } from "vitest";
import billingWorker from "../../workers/billing/src/index.js";
import { mintInternalToken } from "@naelao/http";

// F20 / A1.16.8: workers/billing/wrangler.toml never set workers_dev = false, and three
// money-in routes were gated only by a forgeable static x-naelao-internal header —
// /internal/commerce/checkout ("commerce-script"), /internal/seats/checkout
// ("commerce-script"|"portal"), /internal/products/ls-variant ("publish"). A1.16.8 replaced
// this exact pattern with requireInternalHmac everywhere else in the platform; billing was
// missed. This mirrors tests/unit/layer3-backstop-routes.test.ts: prove the real worker
// handlers now reject a forged static header and accept a properly minted token.

const SECRET = "test-platform-secret";
const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function makeEnv(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const db = {
    prepare(sql: string) {
      const stmt = {
        bind() { return stmt; },
        async first() {
          if (/FROM launchpad_products WHERE/.test(sql)) return null; // product not found -> 404, not 403
          if (/FROM spaces WHERE/.test(sql)) return null; // space not found -> 404, not 403
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

describe("billing worker — /internal/commerce/checkout requires a verified internal token", () => {
  it("rejects the old forged static header (the OLD check this replaces)", async () => {
    const res = await billingWorker.fetch(
      new Request("https://billing.naelao.com/internal/commerce/checkout", {
        method: "POST",
        headers: { "content-type": "application/json", "x-naelao-internal": "commerce-script" },
        body: JSON.stringify({ space_id: "space-1", product_id: "prod-1" }),
      }),
      makeEnv() as never,
      execCtx
    );
    expect(res.status).toBe(403);
  });

  it("rejects with no header at all", async () => {
    const res = await billingWorker.fetch(
      new Request("https://billing.naelao.com/internal/commerce/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ space_id: "space-1", product_id: "prod-1" }),
      }),
      makeEnv() as never,
      execCtx
    );
    expect(res.status).toBe(403);
  });

  it("accepts a properly minted token", async () => {
    const token = await mintInternalToken(SECRET, "tenant-1");
    const res = await billingWorker.fetch(
      new Request("https://billing.naelao.com/internal/commerce/checkout", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-naelao-tenant-id": "tenant-1",
          "x-naelao-internal-token": token,
        },
        body: JSON.stringify({ space_id: "space-1", product_id: "prod-1" }),
      }),
      makeEnv() as never,
      execCtx
    );
    // No matching product in this minimal DB stub -> 404, not the auth gate's 403.
    expect(res.status).not.toBe(403);
  });
});

describe("billing worker — /internal/seats/checkout requires a verified internal token", () => {
  it("rejects the old forged 'commerce-script' header", async () => {
    const res = await billingWorker.fetch(
      new Request("https://billing.naelao.com/internal/seats/checkout", {
        method: "POST",
        headers: { "content-type": "application/json", "x-naelao-internal": "commerce-script" },
        body: JSON.stringify({ space_id: "space-1", user_id: "user-1" }),
      }),
      makeEnv() as never,
      execCtx
    );
    expect(res.status).toBe(403);
  });

  it("rejects the old forged 'portal' header", async () => {
    const res = await billingWorker.fetch(
      new Request("https://billing.naelao.com/internal/seats/checkout", {
        method: "POST",
        headers: { "content-type": "application/json", "x-naelao-internal": "portal" },
        body: JSON.stringify({ space_id: "space-1" }),
      }),
      makeEnv() as never,
      execCtx
    );
    expect(res.status).toBe(403);
  });

  it("accepts a properly minted token", async () => {
    const token = await mintInternalToken(SECRET, "tenant-1");
    const res = await billingWorker.fetch(
      new Request("https://billing.naelao.com/internal/seats/checkout", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-naelao-tenant-id": "tenant-1",
          "x-naelao-internal-token": token,
        },
        body: JSON.stringify({ space_id: "space-1", user_id: "user-1" }),
      }),
      makeEnv() as never,
      execCtx
    );
    // No matching space in this minimal DB stub -> 404, not the auth gate's 403.
    expect(res.status).not.toBe(403);
  });

  it("requires a Naelao user id before creating a paid seat checkout", async () => {
    const token = await mintInternalToken(SECRET, "tenant-1");
    const res = await billingWorker.fetch(
      new Request("https://billing.naelao.com/internal/seats/checkout", {
        method: "POST",
        headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token },
        body: JSON.stringify({ space_id: "space-1" }),
      }),
      makeEnv() as never,
      execCtx
    );
    expect(res.status).toBe(400);
  });
});

describe("billing worker — /internal/products/ls-variant requires a verified internal token", () => {
  it("rejects the old forged 'publish' header (the OLD check this replaces)", async () => {
    const res = await billingWorker.fetch(
      new Request("https://billing.naelao.com/internal/products/ls-variant", {
        method: "POST",
        headers: { "content-type": "application/json", "x-naelao-internal": "publish" },
        body: JSON.stringify({ name: "Course", price_cents: 1999, kind: "one_time" }),
      }),
      makeEnv() as never,
      execCtx
    );
    expect(res.status).toBe(403);
  });

  it("accepts a properly minted token", async () => {
    const token = await mintInternalToken(SECRET, "tenant-1");
    const res = await billingWorker.fetch(
      new Request("https://billing.naelao.com/internal/products/ls-variant", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-naelao-tenant-id": "tenant-1",
          "x-naelao-internal-token": token,
        },
        body: JSON.stringify({ name: "Course", price_cents: 1999, kind: "one_time" }),
      }),
      makeEnv() as never,
      execCtx
    );
    // No LS credentials in this minimal env -> the dev placeholder path returns 200, not the
    // auth gate's 403.
    expect(res.status).not.toBe(403);
  });
});

describe("billing worker — /webhooks/lemon-squeezy is unaffected (its own signature scheme, not requireInternalHmac)", () => {
  it("still rejects an invalid webhook signature the same way as before this fix", async () => {
    const res = await billingWorker.fetch(
      new Request("https://billing.naelao.com/webhooks/lemon-squeezy", {
        method: "POST",
        headers: { "X-Signature": "not-a-real-signature" },
        body: JSON.stringify({ meta: { event_name: "order_created" }, data: {} }),
      }),
      makeEnv({
        LEMON_SQUEEZY_WEBHOOK_SECRET: "whsec_real",
        AGENTS_WORKER: { fetch: async () => new Response("{}") },
      }) as never,
      execCtx
    );
    expect(res.status).toBe(401);
  });
});
