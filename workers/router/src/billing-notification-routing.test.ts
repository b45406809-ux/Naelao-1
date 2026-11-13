import { describe, expect, it, vi } from "vitest";
import { signJwt } from "@naelao/auth";
import { app, type Env } from "./index.js";

describe("billing dunning status forwarding", () => {
  it("forwards the exact route with tenant and role from the verified owner token", async () => {
    const secret = "billing-router-test-secret";
    const forwarded = vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe("/billing/dunning-notifications");
      expect(request.headers.get("x-naelao-tenant-id")).toBe("owner-tenant");
      expect(request.headers.get("x-naelao-role")).toBe("owner");
      expect(request.headers.get("x-naelao-user-id")).toBe("owner-user");
      return Response.json({ data: [] });
    });
    const token = await signJwt({ sub: "owner-user", tid: "owner-tenant", email: "owner@example.test", role: "owner", scopes: [] }, secret);
    const env = {
      ENVIRONMENT: "test", JWT_SECRET: secret, PLATFORM_SECRET: secret,
      PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ status: "active", reseller_status: "active" }) }) }) },
      BILLING_WORKER: { fetch: forwarded },
    } as unknown as Env;
    const response = await app.request("/v1/billing/dunning-notifications", {
      headers: {
        authorization: `Bearer ${token}`,
        "x-naelao-tenant-id": "attacker-tenant",
        "x-naelao-role": "member",
      },
    }, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [] });
    expect(forwarded).toHaveBeenCalledOnce();
  });

  it("forwards general notification status through the owner billing boundary", async () => {
    const secret = "billing-router-test-secret";
    const forwarded = vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe("/billing/notification-deliveries");
      expect(request.headers.get("x-naelao-tenant-id")).toBe("owner-tenant");
      expect(request.headers.get("x-naelao-role")).toBe("owner");
      return Response.json({ data: [] });
    });
    const token = await signJwt({ sub: "owner-user", tid: "owner-tenant", email: "owner@example.test", role: "owner", scopes: [] }, secret);
    const env = {
      ENVIRONMENT: "test", JWT_SECRET: secret, PLATFORM_SECRET: secret,
      PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ status: "active", reseller_status: "active" }) }) }) },
      BILLING_WORKER: { fetch: forwarded },
    } as unknown as Env;
    const response = await app.request("/v1/billing/notification-deliveries", {
      headers: { authorization: `Bearer ${token}` },
    }, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [] });
    expect(forwarded).toHaveBeenCalledOnce();
  });
});
