import { describe, expect, it, vi } from "vitest";
import { signJwt } from "@naelao/auth";
import { app, PRODUCT_END_USER_PATH_PATTERNS, type Env } from "./index";

describe("Project task stop routing (MS-07)", () => {
  it("routes POST task-stop to Agents, never to Spaces", async () => {
    const secret = "project-task-stop-router-test-secret";
    const paths: string[] = [];
    const agentsFetch = vi.fn(async (request: Request) => {
      paths.push(`${request.method} ${new URL(request.url).pathname}`);
      expect(request.headers.get("x-naelao-user-id")).toBe("owner-1");
      expect(request.headers.get("x-naelao-internal-token")).toBeTruthy();
      return Response.json({ reached: "agents" });
    });
    const spacesFetch = vi.fn(async () => Response.json({ reached: "spaces" }));
    const token = await signJwt({ sub: "owner-1", tid: "tenant-1", email: "owner@example.test", role: "owner", scopes: [] }, secret);
    const PLATFORM_DB = { prepare: () => ({ bind: () => ({ first: async () => ({ status: "active", reseller_status: "active" }) }) }) } as unknown as D1Database;
    const env = { ENVIRONMENT: "test", JWT_SECRET: secret, PLATFORM_SECRET: secret, PLATFORM_DB,
      AGENTS_WORKER: { fetch: agentsFetch }, SPACES_WORKER: { fetch: spacesFetch } } as unknown as Env;
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const response = await app.request("/v1/spaces/space-1/projects/project-1/task-stop",
      { method: "POST", headers, body: JSON.stringify({ task_id: "task-1" }) }, env);
    expect(response.status).toBe(200);
    expect(paths).toEqual(["POST /spaces/space-1/projects/project-1/task-stop"]);
    expect(spacesFetch).not.toHaveBeenCalled();
  });

  it("does not add the stop path to the product end-user identity allowlist", () => {
    // Product end users do not reach Project task detail through that allowlist today.
    expect(PRODUCT_END_USER_PATH_PATTERNS.some(pattern => pattern.test("/spaces/s/projects/p/task-stop"))).toBe(false);
    expect(PRODUCT_END_USER_PATH_PATTERNS.some(pattern => pattern.test("/spaces/s/tasks/t"))).toBe(false);
  });
});
