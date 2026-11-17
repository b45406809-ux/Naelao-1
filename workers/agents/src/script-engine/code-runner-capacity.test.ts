import { describe, expect, it, vi } from "vitest";
import { buildCodeRunner } from "./code-runner.js";

describe("durable container capacity retry", () => {
  it("retries a persisted wait with the same authorized scope and request body", async () => {
    const requests: Array<{ scope: string | null; body: string }> = [];
    const fetch = vi.fn(async (request: Request) => {
      if (new URL(request.url).pathname === "/cancel") return Response.json({ cancelled: true });
      requests.push({ scope: request.headers.get("x-naelao-container-scope"), body: await request.clone().text() });
      if (requests.length === 1) return Response.json({ ok: false, status: "waiting_for_capacity", admission_id: "run-execution" },
        { status: 429, headers: { "retry-after": "0" } });
      return Response.json({ ok: true, result: "dispatched" });
    });
    const authorizeContainer = vi.fn(async () => true);
    const runner = buildCodeRunner({
      platformSecret: "capacity-test-secret",
      toolSandbox: { idFromName: (name: string) => name, get: () => ({ fetch }) } as never,
      authorizeContainer,
      containerTimeoutMs: 5_000,
    });
    const result = await runner.run({
      name: "container.execute", code: "printf safe", args: {}, tier: 6, maxTier: 6,
      tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a", userId: "owner-a", agentId: "agent-a", runId: "run-a",
      executionId: "run-execution",
    } as never);
    expect(result).toMatchObject({ ok: true, output: "dispatched" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(authorizeContainer).toHaveBeenCalledTimes(2);
    expect(requests[1]).toEqual(requests[0]);
  });

  it("cancels a waiting admission if the live container grant was revoked", async () => {
    const paths: string[] = [];
    const fetch = vi.fn(async (request: Request) => {
      paths.push(new URL(request.url).pathname);
      return new URL(request.url).pathname === "/cancel"
        ? Response.json({ cancelled: true })
        : Response.json({ ok: false, status: "waiting_for_capacity", admission_id: "revoked-execution" },
          { status: 429, headers: { "retry-after": "0" } });
    });
    const authorizeContainer = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const runner = buildCodeRunner({
      platformSecret: "capacity-test-secret",
      toolSandbox: { idFromName: (name: string) => name, get: () => ({ fetch }) } as never,
      authorizeContainer,
      containerTimeoutMs: 5_000,
    });
    const result = await runner.run({ name: "container.execute", code: "printf safe", args: {}, tier: 6, maxTier: 6,
      tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a", userId: "owner-a", agentId: "agent-a", runId: "run-a",
      executionId: "revoked-execution" } as never);
    expect(result).toMatchObject({ ok: false, error: "container_execution_denied" });
    expect(authorizeContainer).toHaveBeenCalledTimes(2);
    expect(paths).toEqual(["/exec", "/cancel"]);
  });

  it("binds the signed runtime scope to the monotonic authorization revision and cancels after revision drift", async () => {
    const paths: string[] = [];
    const scopes: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      paths.push(path);
      if (path === "/cancel") return Response.json({ cancelled: true });
      scopes.push(JSON.parse(request.headers.get("x-naelao-container-scope") ?? "{}"));
      return Response.json({ ok: false, status: "waiting_for_capacity", admission_id: "revision-execution" },
        { status: 429, headers: { "retry-after": "0" } });
    });
    const authorizeContainer = vi.fn().mockResolvedValueOnce("space:2.project:4").mockResolvedValueOnce("space:3.project:4");
    const runner = buildCodeRunner({ platformSecret: "capacity-test-secret",
      toolSandbox: { idFromName: (name: string) => name, get: () => ({ fetch }) } as never,
      authorizeContainer, containerTimeoutMs: 5_000 });
    const result = await runner.run({ name: "container.execute", code: "printf safe", args: {}, tier: 6, maxTier: 6,
      tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a", userId: "owner-a", agentId: "agent-a", runId: "run-a",
      executionId: "revision-execution" } as never);
    expect(result).toMatchObject({ ok: false, error: "container_execution_denied" });
    expect(scopes[0]?.authorizationRevision).toBe("space:2.project:4");
    expect(paths).toEqual(["/exec", "/cancel"]);
  });
});
