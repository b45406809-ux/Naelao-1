import { describe, expect, it, vi } from "vitest";
import { signJwt } from "@naelao/auth";
import { app, type Env } from "./index";

describe("customer voice routing", () => {
  it("forwards owner telephony requests to the Agents worker with authenticated scope", async () => {
    const secret = "router-test-platform-secret";
    const workerFetch = vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe("/spaces/space-1/customer-voice/numbers");
      expect(request.headers.get("x-naelao-tenant-id")).toBe("tenant-1");
      expect(request.headers.get("x-naelao-user-id")).toBe("owner-1");
      expect(request.headers.get("x-naelao-role")).toBe("owner");
      expect(request.headers.get("x-naelao-internal-token")).toBeTruthy();
      return Response.json({ numbers: [] });
    });
    const token = await signJwt({ sub: "owner-1", tid: "tenant-1", email: "owner@example.test", role: "owner", scopes: [] }, secret);
    const env = {
      ENVIRONMENT: "test", JWT_SECRET: secret, PLATFORM_SECRET: secret,
      AGENTS_WORKER: { fetch: workerFetch },
      SPACES_WORKER: { fetch: vi.fn(() => Response.json({ wrong_worker: true })) },
    } as unknown as Env;

    const response = await app.request("/v1/spaces/space-1/customer-voice/numbers", {
      headers: { authorization: `Bearer ${token}` },
    }, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ numbers: [] });
    expect(workerFetch).toHaveBeenCalledTimes(1);
    expect(env.SPACES_WORKER.fetch).not.toHaveBeenCalled();
  });
});
