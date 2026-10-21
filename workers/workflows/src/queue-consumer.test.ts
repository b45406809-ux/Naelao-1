import { describe, expect, it, vi } from "vitest";
import { queue } from "./queue-consumer.js";

function message(body: Record<string, unknown>) {
  return { id: "message-1", body, ack: vi.fn(), retry: vi.fn() };
}

function activeDb() {
  return { prepare: () => ({ bind: () => ({ first: async () => ({ id: "space-a" }) }) }) };
}

describe("KB ingestion queue dispatch", () => {
  it("starts the workflow with its tenant scope and access policy", async () => {
    const msg = message({
      type: "kb.ingest", docId: "doc-a", spaceId: "space-a", tenantId: "tenant-a", projectId: "project-a",
      r2Key: "staging/tenant-a/space-a/project-a/doc-a/original", title: "Guide", contentType: "text",
      requiredRoleRank: 30, allowedUserIds: ["user-a"],
    });
    const create = vi.fn(async () => undefined);
    await queue({ messages: [msg] } as never, { PLATFORM_DB: activeDb(), KB_INGESTION: { create } } as never);
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
      await queue({ messages: [msg] } as never, { PLATFORM_DB: activeDb(), KB_INGESTION: { create } } as never);
      expect(create).not.toHaveBeenCalled();
      expect(msg.retry).toHaveBeenCalledTimes(1);
      expect(msg.ack).not.toHaveBeenCalled();
    }
  });

  it("acks at-least-once redelivery when the deterministic workflow already exists", async () => {
    const msg = message({
      type: "kb.ingest", docId: "doc-a", spaceId: "space-a", tenantId: "tenant-a", projectId: "project-a",
      r2Key: "staging/tenant-a/space-a/project-a/doc-a/original", title: "Guide", contentType: "text",
    });
    const create = vi.fn(async () => { throw new Error("workflow instance already exists"); });
    const get = vi.fn(async () => ({ id: msg.id }));
    await queue({ messages: [msg] } as never, { PLATFORM_DB: activeDb(), KB_INGESTION: { create, get } } as never);
    expect(create).toHaveBeenCalledWith({ id: "message-1", params: msg.body });
    expect(get).toHaveBeenCalledWith("message-1");
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it("retries workflow creation errors when no existing instance can be confirmed", async () => {
    const msg = message({ type: "space.provision", spaceId: "space-a" });
    const create = vi.fn(async () => { throw new Error("temporary control plane error"); });
    const get = vi.fn(async () => { throw new Error("not found"); });
    await queue({ messages: [msg] } as never, { SPACE_PROVISIONING: { create, get } } as never);
    expect(msg.ack).not.toHaveBeenCalled();
    expect(msg.retry).toHaveBeenCalledTimes(1);
  });

  it("acks a stale KB ingestion for a suspended tenant without starting a workflow", async () => {
    const msg = message({
      type: "kb.ingest", docId: "doc-a", spaceId: "space-a", tenantId: "tenant-a", projectId: "project-a",
      r2Key: "staging/tenant-a/space-a/project-a/doc-a/original", title: "Guide", contentType: "text",
    });
    const create = vi.fn(async () => undefined);
    const db = { prepare: () => ({ bind: () => ({ first: async () => null }) }) };

    await queue({ messages: [msg] } as never, { PLATFORM_DB: db, KB_INGESTION: { create } } as never);

    expect(create).not.toHaveBeenCalled();
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it("retries KB ingestion when tenant status lookup fails", async () => {
    const msg = message({
      type: "kb.ingest", docId: "doc-a", spaceId: "space-a", tenantId: "tenant-a", projectId: "project-a",
      r2Key: "staging/tenant-a/space-a/project-a/doc-a/original", title: "Guide", contentType: "text",
    });
    const create = vi.fn(async () => undefined);
    const db = { prepare: () => { throw new Error("D1 unavailable"); } };

    await queue({ messages: [msg] } as never, { PLATFORM_DB: db, KB_INGESTION: { create } } as never);

    expect(create).not.toHaveBeenCalled();
    expect(msg.ack).not.toHaveBeenCalled();
    expect(msg.retry).toHaveBeenCalledOnce();
  });
});
