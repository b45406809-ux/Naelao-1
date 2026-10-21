import { describe, expect, it, vi } from "vitest";
import { queue } from "./queue-consumer.js";

function message(body: Record<string, unknown>) {
  return { id: "message-1", body, ack: vi.fn(), retry: vi.fn() };
}

describe("KB ingestion queue dispatch", () => {
  it("starts the workflow with its tenant scope and access policy", async () => {
    const msg = message({
      type: "kb.ingest", docId: "doc-a", spaceId: "space-a", tenantId: "tenant-a", projectId: "project-a",
      r2Key: "staging/tenant-a/space-a/project-a/doc-a/original", title: "Guide", contentType: "text",
      requiredRoleRank: 30, allowedUserIds: ["user-a"],
    });
    const create = vi.fn(async () => undefined);
    await queue({ messages: [msg] } as never, { KB_INGESTION: { create } } as never);
    expect(create).toHaveBeenCalledWith({ id: "message-1", params: msg.body });
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it("retries malformed scope or ACL messages rather than creating a workflow", async () => {
    for (const body of [
      { type: "kb.ingest", docId: "doc-a", spaceId: "space-a", tenantId: "tenant-a", projectId: "project-a" },
      { type: "kb.ingest", docId: "doc-a", spaceId: "space-a", tenantId: "tenant-a", projectId: "project-a",
        r2Key: "staging/x", title: "Guide", contentType: "text", requiredRoleRank: 51 },
    ]) {
      const msg = message(body);
      const create = vi.fn(async () => undefined);
      await queue({ messages: [msg] } as never, { KB_INGESTION: { create } } as never);
      expect(create).not.toHaveBeenCalled();
      expect(msg.retry).toHaveBeenCalledTimes(1);
      expect(msg.ack).not.toHaveBeenCalled();
    }
  });
});
