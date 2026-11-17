import { describe, expect, it, vi } from "vitest";
import { buildCodeRunner } from "./code-runner.js";

describe("durable container capacity retry", () => {
  it("retries a persisted wait with the same authorized scope and request body", async () => {
    const requests: Array<{ scope: string | null; body: string }> = [];
    const fetch = vi.fn(async (request: Request) => {
      requests.push({ scope: request.headers.get("x-naelao-container-scope"), body: await request.clone().text() });
      if (requests.length === 1) return Response.json({ ok: false, status: "waiting_for_capacity", admission_id: "run-execution" },
        { status: 429, headers: { "retry-after": "0" } });
      return Response.json({ ok: true, result: "dispatched" });
    });
    const runner = buildCodeRunner({
      platformSecret: "capacity-test-secret",
      toolSandbox: { idFromName: (name: string) => name, get: () => ({ fetch }) } as never,
      authorizeContainer: async () => true,
      containerTimeoutMs: 5_000,
    });
    const result = await runner.run({
      name: "container.execute", code: "printf safe", args: {}, tier: 6, maxTier: 6,
      tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a", userId: "owner-a", agentId: "agent-a", runId: "run-a",
      executionId: "run-execution",
    } as never);
    expect(result).toMatchObject({ ok: true, output: "dispatched" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(requests[1]).toEqual(requests[0]);
  });
});
