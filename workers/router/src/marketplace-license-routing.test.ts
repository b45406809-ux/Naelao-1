import { describe, expect, it, vi } from "vitest";
import { signJwt } from "@naelao/auth";
import { app, type Env } from "./index.js";

describe("marketplace license route forwarding", () => {
  it.each([
    ["GET", "/v1/marketplace/listing-a/license-status"],
    ["GET", "/v1/marketplace/listing-a/refund-cases"],
    ["POST", "/v1/marketplace/listing-a/license-checkout"],
    ["POST", "/v1/marketplace/listing-a/fork"],
  ] as const)("forwards %s %s to the authenticated Marketplace Worker", async (method, path) => {
    const secret = "marketplace-router-test-secret";
    const forwarded = vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe(path);
      expect(request.headers.get("x-naelao-tenant-id")).toBe("buyer-tenant");
      expect(request.headers.get("x-naelao-user-id")).toBe("buyer-user");
      expect(request.headers.get("x-naelao-internal-token")).toBeTruthy();
      return Response.json({ routed: true });
    });
    const token = await signJwt({ sub: "buyer-user", tid: "buyer-tenant", email: "buyer@example.test", role: "owner", scopes: [] }, secret);
    const env = {
      ENVIRONMENT: "test", JWT_SECRET: secret, PLATFORM_SECRET: secret,
      PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ status: "active", reseller_status: "active" }) }) }) },
      MARKETPLACE_WORKER: { fetch: forwarded },
    } as unknown as Env;
    const response = await app.request(path, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(method === "POST" ? { "content-type": "application/json" } : {}) },
      ...(method === "POST" ? { body: "{}" } : {}),
    }, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ routed: true });
    expect(forwarded).toHaveBeenCalledOnce();
  });
});
