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

  it("passes a validated resource_ref through publish and broadcast", async () => {
    const fetch = vi.fn(async () => Response.json({ messages: [], untrusted: true }));
    const ctx = { env: { tenantId: "tenant-a", spaceId: "root", agentId: "assistant:space:dept-a", platformSecret: "secret", spacesWorker: { fetch } } } as unknown as PrebuiltOpContext;
    const resource_ref = { document_id: "doc-1", type: "knowledge_document", target_space_id: "dept-a" };
    await subspaceBlackboard.operations["subspace.blackboard.publish"]!({ subspace_id: "dept-a", route_id: "r1", id: "m1", kind: "artifact", text: "Doc", resource_ref }, ctx);
    expect(await (fetch.mock.calls[0]![0] as Request).json()).toEqual({ id: "m1", kind: "artifact", text: "Doc",
      resource_ref: { type: "knowledge_document", target_space_id: "dept-a", document_id: "doc-1" } });
    await subspaceBlackboard.operations["subspace.blackboard.broadcast"]!({ subspace_id: "dept-a", id: "b1", route_ids: ["r1", "r2"], kind: "artifact", text: "Doc", resource_ref }, ctx);
    expect(await (fetch.mock.calls[1]![0] as Request).json()).toMatchObject({ resource_ref: { document_id: "doc-1" } });
    for (const bad of [{ ...resource_ref, type: "file" }, { ...resource_ref, document_id: "bad id" }, { ...resource_ref, extra: 1 }, "doc-1"])
      expect(() => subspaceBlackboard.operations["subspace.blackboard.publish"]!({ subspace_id: "dept-a", route_id: "r1", id: "m2", kind: "artifact", text: "Doc", resource_ref: bad }, ctx))
        .toThrow("subspace_blackboard_resource_ref_invalid");
    expect(() => subspaceBlackboard.operations["subspace.blackboard.publish"]!({ subspace_id: "dept-a", route_id: "r1", id: "m3", kind: "finding", text: "Doc", resource_ref }, ctx))
      .toThrow("subspace_blackboard_resource_ref_invalid");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
