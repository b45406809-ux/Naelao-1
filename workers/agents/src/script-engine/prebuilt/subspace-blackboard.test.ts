import { describe, expect, it, vi } from "vitest";
import type { PrebuiltOpContext } from "./index.js";
import { subspaceBlackboard } from "./subspace-blackboard.js";

describe("subspace blackboard assistant operations", () => {
  it("binds the selected department to the runtime assistant identity", async () => {
    const fetch = vi.fn();
    const ctx = { env: { tenantId: "tenant-a", spaceId: "root", agentId: "assistant:space:dept-a", platformSecret: "secret", spacesWorker: { fetch } } } as unknown as PrebuiltOpContext;
    expect(() => subspaceBlackboard.operations["subspace.blackboard.read"]!({ subspace_id: "dept-b", route_id: "r1" }, ctx))
      .toThrow("subspace_blackboard_assistant_identity_mismatch");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("signs bounded reads and publishes with only the runtime assistant actor", async () => {
    const fetch = vi.fn(async () => Response.json({ messages: [], untrusted: true }));
    const ctx = { env: { tenantId: "tenant-a", spaceId: "root", agentId: "assistant:space:dept-a", platformSecret: "secret", spacesWorker: { fetch } } } as unknown as PrebuiltOpContext;
    await subspaceBlackboard.operations["subspace.blackboard.read"]!({ subspace_id: "dept-a", route_id: "r1" }, ctx);
    const read = fetch.mock.calls[0]![0] as Request;
    expect(new URL(read.url).pathname).toBe("/internal/spaces/root/sub-spaces/dept-a/blackboard");
    expect(new URL(read.url).searchParams.get("route_id")).toBe("r1");
    expect(read.headers.get("x-naelao-agent-id")).toBe("assistant:space:dept-a");
    expect(read.headers.get("x-naelao-internal-token")).toBeTruthy();
    await subspaceBlackboard.operations["subspace.blackboard.publish"]!({ subspace_id: "dept-a", route_id: "r1", id: "m1", kind: "question", text: "Need review" }, ctx);
    const write = fetch.mock.calls[1]![0] as Request;
    expect(await write.json()).toEqual({ id: "m1", kind: "question", text: "Need review" });
  });

  it("sends bounded multi-route broadcasts through the internal actor path", async () => {
    const fetch = vi.fn(async () => Response.json({ messages: [], untrusted: true }));
    const ctx = { env: { tenantId: "tenant-a", spaceId: "root", agentId: "assistant:space:dept-a", platformSecret: "secret", spacesWorker: { fetch } } } as unknown as PrebuiltOpContext;
    await subspaceBlackboard.operations["subspace.blackboard.broadcast"]!({ subspace_id: "dept-a", id: "broadcast-1",
      route_ids: ["route-b", "route-c"], kind: "finding", text: "Validated handoff" }, ctx);
    const request = fetch.mock.calls[0]![0] as Request;
    expect(new URL(request.url).pathname).toBe("/internal/spaces/root/sub-spaces/dept-a/blackboard/broadcast");
    expect(request.headers.get("x-naelao-agent-id")).toBe("assistant:space:dept-a");
    expect(await request.json()).toEqual({ id: "broadcast-1", route_ids: ["route-b", "route-c"], kind: "finding", text: "Validated handoff" });
    await expect(subspaceBlackboard.operations["subspace.blackboard.broadcast"]!({ subspace_id: "dept-a", id: "broadcast-1",
      route_ids: ["route-b"], kind: "finding", text: "Invalid fanout" }, ctx)).rejects.toThrow("subspace_blackboard_broadcast_invalid");
  });

  it("does not expose any route grant or revocation operation", () => {
    expect(Object.keys(subspaceBlackboard.operations).sort()).toEqual(["subspace.blackboard.broadcast", "subspace.blackboard.publish", "subspace.blackboard.read"]);
  });
});
