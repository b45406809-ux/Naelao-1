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
