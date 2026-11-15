import { describe, expect, it, vi } from "vitest";
import { signJwt } from "@naelao/auth";
import { app, type Env } from "./index";

describe("project workspace cleanup status routing", () => {
  it("forwards the authenticated owner status request to Spaces with identity headers", async () => {
    const secret = "router-cleanup-status-test-secret";
    const spacesFetch = vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe("/spaces/space-1/workspace-cleanup-status");
      expect(request.method).toBe("POST");
      expect(request.headers.get("x-naelao-tenant-id")).toBe("tenant-1");
      expect(request.headers.get("x-naelao-user-id")).toBe("owner-1");
      expect(request.headers.get("x-naelao-role")).toBe("owner");
      expect(request.headers.get("x-naelao-internal-token")).toBeTruthy();
      return Response.json({ items: [] });
    });
    const token = await signJwt({ sub: "owner-1", tid: "tenant-1", email: "owner@example.test", role: "owner", scopes: [] }, secret);
    const PLATFORM_DB = { prepare: () => ({ bind: () => ({ first: async () => ({ status: "active", reseller_status: "active" }) }) }) } as unknown as D1Database;
    const env = { ENVIRONMENT: "test", JWT_SECRET: secret, PLATFORM_SECRET: secret, PLATFORM_DB,
      SPACES_WORKER: { fetch: spacesFetch } } as unknown as Env;

    const response = await app.request("/v1/spaces/space-1/workspace-cleanup-status", {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ projectIds: ["generated-a"] }),
    }, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [] });
    expect(spacesFetch).toHaveBeenCalledOnce();
  });
});
