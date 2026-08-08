import { describe, it, expect } from "vitest";
import { commerce } from "../../workers/agents/src/script-engine/prebuilt/commerce.js";
import { verifyInternalToken } from "@naelao/http";
import type { ScriptEngineEnv } from "../../workers/agents/src/script-engine/types.js";

// F20 / A1.16.8: the commerce prebuilt used to send billing worker's now-gated /internal/*
// routes a forgeable static `x-naelao-internal: "commerce-script"` header. Proves the caller
// side of the fix — commerce.checkout/commerce.seat_checkout now mint a real, verifiable
// requireInternalHmac token instead.

const PLATFORM_SECRET = "test-platform-secret";

function makeEnv(capture: { headers?: Record<string, string>; body?: unknown }): ScriptEngineEnv {
  const billingWorker = {
    async fetch(reqInput: Request | string, init?: RequestInit) {
      const req = typeof reqInput === "string" ? new Request(reqInput, init) : reqInput;
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => { headers[k] = v; });
      capture.headers = headers;
      capture.body = await req.clone().json().catch(() => null);
      return Response.json({ checkout_url: "https://checkout.example/x" });
    },
  };
  return {
    scriptsBucket: {} as never,
    spaceId: "space-1",
    tenantId: "tenant-1",
    platformSecret: PLATFORM_SECRET,
    billingWorker: billingWorker as unknown as Fetcher,
  } as unknown as ScriptEngineEnv;
}

const noopRun = async () => ({});

describe("commerce prebuilt — mints a verified internal token instead of a static header", () => {
  it("commerce.checkout sends a token verifiable against the caller's tenant, not a static string", async () => {
    const capture: { headers?: Record<string, string>; body?: unknown } = {};
    const env = makeEnv(capture);
    await commerce.operations["commerce.checkout"]!({ product_id: "prod-1" }, { env, run: noopRun });

    expect(capture.headers?.["x-naelao-internal"]).toBeUndefined(); // old forgeable header gone
    expect(capture.headers?.["x-naelao-tenant-id"]).toBe("tenant-1");
    const token = capture.headers?.["x-naelao-internal-token"];
    expect(token).toBeTruthy();
    expect(await verifyInternalToken(token, "tenant-1", PLATFORM_SECRET)).toBe(true);
    expect(await verifyInternalToken(token, "some-other-tenant", PLATFORM_SECRET)).toBe(false);
  });

  it("commerce.seat_checkout sends a token verifiable against the caller's tenant, not a static string", async () => {
    const capture: { headers?: Record<string, string>; body?: unknown } = {};
    const env = makeEnv(capture);
    await commerce.operations["commerce.seat_checkout"]!({ user_id: "user-1" }, { env, run: noopRun });

    expect(capture.headers?.["x-naelao-internal"]).toBeUndefined();
    const token = capture.headers?.["x-naelao-internal-token"];
    expect(token).toBeTruthy();
    expect(await verifyInternalToken(token, "tenant-1", PLATFORM_SECRET)).toBe(true);
  });
});

describe("commerce can actually put something up for sale", () => {
  /**
   * This capability did not exist, and its absence produced the worst failure this platform can
   * have. Asked to create a product, the assistant had no operation for it, did not say so, and
   * reported a detailed success instead — name, price, "now live on your storefront at
   * shop-…naelao.com". `launchpad_products` was empty; none of it was real. An owner acting on
   * that believes they are selling something they are not. The storefront UI has always had these
   * routes; the agent was simply never given them, so "run a business" stopped at reading.
   */
  function makeSpacesEnv(capture: { url?: string; method?: string; body?: unknown; headers?: Record<string, string> }, response: unknown = { id: "prod-1" }) {
    const spacesWorker = {
      async fetch(reqInput: Request | string, init?: RequestInit) {
        const req = typeof reqInput === "string" ? new Request(reqInput, init) : reqInput;
        capture.url = new URL(req.url).pathname;
        capture.method = req.method;
        const h: Record<string, string> = {};
        req.headers.forEach((v, k) => { h[k] = v; });
        capture.headers = h;
        capture.body = await req.clone().json().catch(() => null);
        return Response.json(response as Record<string, unknown>);
      },
    };
    return {
      scriptsBucket: {} as never,
      spaceId: "space-1",
      tenantId: "tenant-1",
      platformSecret: PLATFORM_SECRET,
      spacesWorker: spacesWorker as unknown as Fetcher,
    } as unknown as ScriptEngineEnv;
  }

  it("creates a product against the same route the storefront UI uses", async () => {
    const capture: { url?: string; method?: string; body?: unknown; headers?: Record<string, string> } = {};
    const env = makeSpacesEnv(capture);
    const out = await commerce.operations["commerce.create_product"]!(
      { name: "Standard Website Package", description: "Up to 5 pages", price_cents: 2000 },
      { env, run: noopRun } as never
    );

    expect(capture.method).toBe("POST");
    expect(capture.url).toBe("/spaces/space-1/products");
    expect(capture.body).toMatchObject({ name: "Standard Website Package", price_cents: 2000 });
    expect(out).toMatchObject({ id: "prod-1" });
    // Internal routes are HMAC-gated; a static header would be forgeable.
    const token = capture.headers?.["x-naelao-internal-token"] ?? "";
    expect(await verifyInternalToken(token, "tenant-1", PLATFORM_SECRET)).toBe(true);
  });

  it("publishing is its own explicit step, not a side effect of drafting", async () => {
    const capture: { url?: string; method?: string; body?: unknown } = {};
    const env = makeSpacesEnv(capture);
    await commerce.operations["commerce.update_product"]!(
      { product_id: "prod-1", status: "published" },
      { env, run: noopRun } as never
    );
    expect(capture.method).toBe("PATCH");
    expect(capture.url).toBe("/spaces/space-1/products/prod-1");
    expect(capture.body).toMatchObject({ status: "published" });
  });

  it("surfaces the upstream error text rather than a bare status", async () => {
    // An agent told only "failed: 403" cannot tell the owner anything useful. It has to be able to
    // say WHAT went wrong — which is the difference between a real report and a fabricated one.
    const env = {
      scriptsBucket: {} as never,
      spaceId: "space-1",
      tenantId: "tenant-1",
      platformSecret: PLATFORM_SECRET,
      spacesWorker: {
        async fetch() {
          return new Response('{"error_code":"commerce_disabled"}', { status: 403 });
        },
      } as unknown as Fetcher,
    } as unknown as ScriptEngineEnv;

    await expect(
      commerce.operations["commerce.create_product"]!({ name: "x" }, { env, run: noopRun } as never)
    ).rejects.toThrow(/403.*commerce_disabled/s);
  });
});
