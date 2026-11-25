import { describe, expect, it, vi } from "vitest";
import { signJwt } from "@naelao/auth";
import { app, PRODUCT_END_USER_PATH_PATTERNS, type Env } from "./index";

async function setup() {
  const secret = "durable-tasks-router-test-secret";
  const agents: string[] = [];
  const spaces: string[] = [];
  const agentsFetch = vi.fn(async (request: Request) => {
    const url = new URL(request.url);
    agents.push(`${request.method} ${url.pathname}${url.search}`);
    expect(request.headers.get("x-naelao-user-id")).toBe("owner-1");
    expect(request.headers.get("x-naelao-internal-token")).toBeTruthy();
    return Response.json({ reached: "agents" });
  });
  const spacesFetch = vi.fn(async (request: Request) => {
    spaces.push(`${request.method} ${new URL(request.url).pathname}`);
    return Response.json({ reached: "spaces" });
  });
  const token = await signJwt({ sub: "owner-1", tid: "tenant-1", email: "owner@example.test", role: "owner", scopes: [] }, secret);
  const PLATFORM_DB = { prepare: () => ({ bind: () => ({ first: async () => ({ status: "active", reseller_status: "active" }) }) }) } as unknown as D1Database;
  const env = { ENVIRONMENT: "test", JWT_SECRET: secret, PLATFORM_SECRET: secret, PLATFORM_DB,
    AGENTS_WORKER: { fetch: agentsFetch }, SPACES_WORKER: { fetch: spacesFetch } } as unknown as Env;
  return { env, agents, spaces, headers: { authorization: `Bearer ${token}` } };
}

describe("Shell durable task routing (MS-08)", () => {
  it("routes the durable task list to Agents with its query", async () => {
    const { env, agents, spaces, headers } = await setup();
    const response = await app.request("/v1/spaces/space-1/durable-tasks?project_id=project-1&cursor=c1", { headers }, env);
    expect(response.status).toBe(200);
    expect(agents).toEqual(["GET /spaces/space-1/tasks?project_id=project-1&cursor=c1"]);
    expect(spaces).toEqual([]);
  });

  it("routes durable task detail to Agents with its query", async () => {
    const { env, agents, spaces, headers } = await setup();
    const response = await app.request("/v1/spaces/space-1/durable-tasks/task-1?timeout=5", { headers }, env);
    expect(response.status).toBe(200);
    expect(agents).toEqual(["GET /spaces/space-1/tasks/task-1?timeout=5"]);
    expect(spaces).toEqual([]);
  });

  it("still sends /spaces/:id/tasks to Spaces (AVOS task DAG)", async () => {
    const { env, agents, spaces, headers } = await setup();
    const response = await app.request("/v1/spaces/space-1/tasks", { headers }, env);
    expect(response.status).toBe(200);
    expect(spaces).toEqual(["GET /spaces/space-1/tasks"]);
    expect(agents).toEqual([]);
  });

  it("allowlists durable task list and detail for product end users, but not extensions", () => {
    // Agents enforces Project access on both the list and the detail handlers (MS-13).
    for (const path of ["/spaces/s/durable-tasks", "/spaces/s/durable-tasks/t"]) expect(PRODUCT_END_USER_PATH_PATTERNS.some(pattern => pattern.test(path))).toBe(true);
    for (const path of ["/spaces/s/durable-tasks/t/x", "/spaces/s/durable-tasks/"]) expect(PRODUCT_END_USER_PATH_PATTERNS.some(pattern => pattern.test(path))).toBe(false);
  });
});
