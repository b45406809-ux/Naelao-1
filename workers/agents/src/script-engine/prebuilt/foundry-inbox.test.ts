import { describe, expect, it, vi } from "vitest";
import { foundryInbox } from "./foundry-inbox.js";

describe("foundry-inbox", () => {
  it("submits a bounded request through the authenticated Spaces binding with run attribution", async () => {
    const fetch = vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe("/internal/spaces/space-a/foundry/requests");
      expect(request.headers.get("x-naelao-agent-id")).toBe("agent-a");
      expect(request.headers.get("x-naelao-run-id")).toBe("run-a");
      expect(request.headers.get("x-naelao-user-id")).toBe("user-a");
      expect(request.headers.get("x-naelao-internal-token")).toBeTruthy();
      expect(await request.json()).toEqual({ agent_id: "agent-a", run_id: "run-a", user_id: "user-a", title: "Add a review step", problem: "The checklist misses approval.", workflow: "Ask the owner before finalizing.", evidence: ["kb:checklist"] });
      return Response.json({ id: "request-a", status: "open" }, { status: 201 });
    });
    const result = await foundryInbox.operations["foundry.request"]!({
      title: "Add a review step", problem: "The checklist misses approval.", workflow: "Ask the owner before finalizing.", evidence: ["kb:checklist"],
    }, { env: { spacesWorker: { fetch } as never, platformSecret: "secret", tenantId: "tenant-a", spaceId: "space-a", agentId: "agent-a", runId: "run-a", userId: "user-a" } as never, run: vi.fn() });
    expect(result).toEqual({ id: "request-a", status: "open" });
  });

  it("rejects requests without a run identity and bounds evidence", async () => {
    const fetch = vi.fn();
    const ctx = { env: { spacesWorker: { fetch }, platformSecret: "secret", tenantId: "t", spaceId: "s", agentId: "a" } as never, run: vi.fn() };
    await expect(foundryInbox.operations["foundry.request"]!({ title: "x", problem: "y", workflow: "z" }, ctx)).rejects.toThrow("identified agent run");
    expect(fetch).not.toHaveBeenCalled();
  });
});
