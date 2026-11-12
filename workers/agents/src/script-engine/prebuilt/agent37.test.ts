import { describe, expect, it, vi } from "vitest";
import { mintInternalToken, verifyInternalToken } from "@naelao/http";
import type { Fetcher } from "@cloudflare/workers-types";
import type { PrebuiltOpContext } from "./index.js";
import { agent37 } from "./agent37.js";

function fixture() {
  const requests: Request[] = [];
  const fetch = vi.fn(async (request: Request) => {
    requests.push(request);
    if (new URL(request.url).pathname === "/computers") return Response.json({ computers: [
      { id: "computer-a", scope: { spaceId: "space-a", projectId: "project-a" } },
      { id: "other-project", scope: { spaceId: "space-a", projectId: "project-b" } },
    ] });
    if (new URL(request.url).pathname === "/providers") return Response.json({ providers: [{ id: "agent37", status: "gated" }] });
    return Response.json({ operation: { status: "complete" }, execution: { status: "succeeded" }, transfer: { status: "staged" } });
  });
  const authorizeShell = vi.fn(async () => true);
  const ctx = { env: {
    tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a", agentId: "local-agent", runId: "run-a",
    humanInvokerId: "user-a", effectiveRole: "owner", nativeExecutionAllowed: true, maxTier: 6,
    platformSecret: "platform-secret", sandboxesWorker: { fetch } as unknown as Fetcher,
  }, authorizeShell, run: vi.fn() } as unknown as PrebuiltOpContext;
  return { ctx, requests, fetch, authorizeShell };
}

describe("Agent37 project assistant caller", () => {
  it("lists only the active project and keeps the runtime gate visible", async () => {
    const f = fixture();
    const result = await agent37.operations["agent37.list"]!({}, f.ctx) as { computers: unknown[]; providerGate: unknown };
    expect(result.computers).toHaveLength(1);
    expect(result.providerGate).toMatchObject({ providers: [{ id: "agent37", status: "gated" }] });
  });

  it("uses the same project AgentPort identity and sends only explicit owner-scoped calls", async () => {
    const f = fixture();
    await agent37.operations["agent37.start"]!({ computer_id: "computer-a", request_id: "start-one" }, f.ctx);
    const start = f.requests.at(-1)!;
    const expected = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(["tenant-a", "space-a", "project:project-a"])));
    const expectedAgentId = `naelao_${[...new Uint8Array(expected)].map(value => value.toString(16).padStart(2, "0")).join("")}`;
    expect(start.url).toBe("http://sandboxes/computers/computer-a/start");
    expect(start.headers.get("x-naelao-agentport-agent-id")).toBe(expectedAgentId);
    expect(start.headers.get("x-naelao-user-id")).toBe("user-a");
    expect(start.headers.get("idempotency-key")).toBe("start-one");
    expect(await start.json()).toEqual({ providerBillingConsent: true });

    await agent37.operations["agent37.execute"]!({ computer_id: "computer-a", command: "printf 'ok'", args: [] }, f.ctx);
    expect(f.requests.at(-1)?.url).toBe("http://sandboxes/computers/computer-a/executions");
    expect(f.authorizeShell).toHaveBeenCalledWith({ kind: "command", name: "printf" });
  });

  it("requires path grants for artifact transfers and fails closed outside native owner context", async () => {
    const f = fixture();
    await agent37.operations["agent37.artifact_transfer"]!({ computer_id: "computer-a", direction: "import", paths: ["src/input.txt"] }, f.ctx);
    expect(f.authorizeShell).toHaveBeenCalledWith({ kind: "file", name: "src/input.txt", access: "read" });
    expect(f.requests.at(-1)?.url).toBe("http://sandboxes/computers/computer-a/artifacts");
    const token=f.requests.at(-1)?.headers.get("x-naelao-internal-token");
    expect(token).toBeTruthy();
    expect(await verifyInternalToken(token,"tenant-a","platform-secret")).toBe(true);

    const denied = fixture();
    (denied.ctx.env as { nativeExecutionAllowed?: boolean }).nativeExecutionAllowed = false;
    await expect(agent37.operations["agent37.start"]!({ computer_id: "computer-a" }, denied.ctx))
      .rejects.toThrow("agent37_project_owner_tool_context_required");
    expect(denied.fetch).not.toHaveBeenCalled();
  });
});
