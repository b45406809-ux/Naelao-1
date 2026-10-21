import { signJwt } from "@naelao/auth";
import { describe, expect, it, vi } from "vitest";
import { type Env, app } from "./index.js";

function platformDb() {
  return {
    prepare: () => ({
      bind: () => ({
        first: async () => ({ status: "active", reseller_status: "active" }),
      }),
    }),
  } as unknown as D1Database;
}

describe("portal domain management routing", () => {
  it("forwards owner requests with verified identity and the original /v1 path", async () => {
    const secret = "portal-router-test-secret";
    const fetch = vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe("/v1/domains");
      expect(request.headers.get("x-naelao-tenant-id")).toBe("tenant-1");
      expect(request.headers.get("x-naelao-user-id")).toBe("owner-1");
      expect(request.headers.get("x-naelao-internal-token")).toBeTruthy();
      return Response.json({ domain: "shop.example.com" }, { status: 201 });
    });
    const token = await signJwt(
      {
        sub: "owner-1",
        tid: "tenant-1",
        email: "owner@example.test",
        role: "owner",
        scopes: [],
      },
      secret
    );
    const env = {
      ENVIRONMENT: "test",
      JWT_SECRET: secret,
      PLATFORM_SECRET: secret,
      PLATFORM_DB: platformDb(),
      PORTAL_ROUTER: { fetch },
    } as unknown as Env;

    const response = await app.request(
      "/v1/domains",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-naelao-tenant-id": "forged-tenant",
        },
        body: JSON.stringify({
          domain: "shop.example.com",
          space_id: "space-1",
        }),
      },
      env
    );

    expect(response.status).toBe(201);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not let editors manage portal domains", async () => {
    const secret = "portal-router-test-secret";
    const fetch = vi.fn(async () => Response.json({ unexpected: true }));
    const token = await signJwt(
      {
        sub: "editor-1",
        tid: "tenant-1",
        email: "editor@example.test",
        role: "editor",
        scopes: [],
      },
      secret
    );
    const env = {
      ENVIRONMENT: "test",
      JWT_SECRET: secret,
      PLATFORM_SECRET: secret,
      PLATFORM_DB: platformDb(),
      PORTAL_ROUTER: { fetch },
    } as unknown as Env;
    const response = await app.request(
      "/v1/subdomains",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ subdomain: "myshop", space_id: "space-1" }),
      },
      env
    );
    expect(response.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });
});
