import { describe, expect, it, vi } from "vitest";
import { signJwt } from "@naelao/auth";
import { app, PRODUCT_END_USER_PATH_PATTERNS, type Env } from "./index";

describe("Project Journal decision review routing", () => {
  it("routes register and review calls to Agents and exposes only the exact review paths to product sessions", async () => {
    const secret = "project-journal-router-test-secret";
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
    const env = { ENVIRONMENT: "test", JWT_SECRET: secret, PLATFORM_SECRET: secret, PLATFORM_DB,
      AGENTS_WORKER: { fetch: agentsFetch }, SPACES_WORKER: { fetch: spacesFetch } } as unknown as Env;
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const base = "/v1/spaces/space-1/projects/project-1/assistant/project-journal/decisions";
    const [read, review] = await Promise.all([
      app.request(base, { headers }, env),
      app.request(`${base}/decision-1/review`, { method: "POST", headers, body: JSON.stringify({ expected_revision: 1, outcome: "reject" }) }, env),
    ]);

    expect(read.status).toBe(200);
    expect(review.status).toBe(200);
    expect(paths.sort()).toEqual([
      "GET /spaces/space-1/projects/project-1/assistant/project-journal/decisions",
      "POST /spaces/space-1/projects/project-1/assistant/project-journal/decisions/decision-1/review",
    ]);
    expect(agentsFetch).toHaveBeenCalledTimes(2);
    expect(spacesFetch).not.toHaveBeenCalled();
    expect(PRODUCT_END_USER_PATH_PATTERNS.some(pattern => pattern.test("/spaces/space-1/projects/project-1/assistant/project-journal/decisions"))).toBe(true);
    expect(PRODUCT_END_USER_PATH_PATTERNS.some(pattern => pattern.test("/spaces/space-1/projects/project-1/assistant/project-journal/decisions/decision-1/review"))).toBe(true);
    expect(PRODUCT_END_USER_PATH_PATTERNS.some(pattern => pattern.test("/spaces/space-1/projects/project-1/assistant/project-journal/decisions/decision-1/delete"))).toBe(false);
  });
});
