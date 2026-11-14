import { describe, expect, it, vi } from "vitest";
import { signJwt } from "@naelao/auth";
import { app, type Env } from "./index";

describe("project managed-runtime routing", () => {
  it("routes project runtime profiles, transfer receipts and retention to Agents before the Spaces catch-all", async () => {
    const secret = "router-managed-runtime-test-secret";
    const paths: string[] = [];
    const agentsFetch = vi.fn(async (request: Request) => {
      paths.push(`${request.method} ${new URL(request.url).pathname}`);
      expect(request.headers.get("x-naelao-user-id")).toBe("owner-1");
      expect(request.headers.get("x-naelao-internal-token")).toBeTruthy();
      return Response.json({ reached: "agents" });
    });
    const spacesFetch = vi.fn(async () => Response.json({ reached: "spaces" }));
    const token = await signJwt({ sub: "owner-1", tid: "tenant-1", email: "owner@example.test", role: "owner", scopes: [] }, secret);
    const PLATFORM_DB = {
      prepare: () => ({ bind: () => ({ first: async () => ({ status: "active", reseller_status: "active" }) }) }),
    } as unknown as D1Database;
    const env = { ENVIRONMENT: "test", JWT_SECRET: secret, PLATFORM_SECRET: secret,
      PLATFORM_DB, AGENTS_WORKER: { fetch: agentsFetch }, SPACES_WORKER: { fetch: spacesFetch } } as unknown as Env;
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const base = "/v1/spaces/space-1/projects/project-1";
    const responses = await Promise.all([
      app.request(`${base}/main-runtime-profile`, { headers }, env),
      app.request(`${base}/runtime-installations/install-1/containers/web/profile`, { headers }, env),
      app.request(`${base}/runtime-installations/install-1/containers/web/profile/reset`, { method: "POST", headers, body: "{}" }, env),
      app.request(`${base}/runtime-installations/install-1/containers/web/execution-profile`, { method: "PUT", headers, body: JSON.stringify({ max_execution_seconds: 30, expected_version: 0 }) }, env),
      app.request(`${base}/runtime-installations/install-1/containers/web/artifact-transfers`, { headers }, env),
      app.request(`${base}/workspace-retention`, { headers }, env),
    ]);
    expect(responses.map(response => response.status)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(paths.sort()).toEqual([
      "GET /spaces/space-1/projects/project-1/runtime-installations/install-1/containers/web/profile",
      "POST /spaces/space-1/projects/project-1/runtime-installations/install-1/containers/web/profile/reset",
      "PUT /spaces/space-1/projects/project-1/runtime-installations/install-1/containers/web/execution-profile",
      "GET /spaces/space-1/projects/project-1/runtime-installations/install-1/containers/web/artifact-transfers",
      "GET /spaces/space-1/projects/project-1/main-runtime-profile",
      "GET /spaces/space-1/projects/project-1/workspace-retention",
    ].sort());
    expect(agentsFetch).toHaveBeenCalledTimes(6);
    expect(spacesFetch).not.toHaveBeenCalled();
  });
});
