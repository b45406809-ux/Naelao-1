import { describe, expect, it, vi } from "vitest";
import { createModalSandbox, reconcileModalSandbox, terminateModalSandbox, type ModalLifecycleHooks, type ModalSandboxClient } from "./modal-lifecycle.js";

const image = `registry.example/sandbox@sha256:${"a".repeat(64)}`;
function setup(actualCredits: number | null = 4) {
  const records = new Map<string, { requestHash: string; record: Awaited<ReturnType<typeof createModalSandbox>> }>();
  const client: ModalSandboxClient = {
    create: vi.fn(async () => ({ id: "sbx_provider_1", state: "running" as const })),
    terminate: vi.fn(async () => undefined),
    inspect: vi.fn(async () => ({ state: "stopped" as const, ...(actualCredits === null ? {} : { actualCredits }) })),
  };
  const hooks: ModalLifecycleHooks = {
    load: vi.fn(async (scope: { tenantId: string; spaceId: string; projectId?: string }, idempotencyKey: string) =>
      records.get(`${scope.tenantId}:${scope.spaceId}:${scope.projectId ?? ""}:${idempotencyKey}`) ?? null),
    claim: vi.fn(async (record) => {
      const key = `${record.tenantId}:${record.spaceId}:${record.projectId ?? ""}:${record.idempotencyKey}`;
      if (records.has(key)) return false;
      records.set(key, { requestHash: record.requestHash, record });
      return true;
    }),
    reserve: vi.fn(async () => undefined), settle: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined), record: vi.fn(async (record) => { records.set(`${record.tenantId}:${record.spaceId}:${record.projectId ?? ""}:${record.idempotencyKey}`, { requestHash: record.requestHash, record }); }),
  };
  return { client, hooks, records };
}

describe("Modal sandbox lifecycle adapter", () => {
  it("reserves a bounded plan allowance and creates only from a pinned image", async () => {
    const { client, hooks } = setup();
    const record = await createModalSandbox({ client, hooks, tenantId: "tenant-1", spaceId: "space-1", projectId: "project-1", actorId: "owner-1", idempotencyKey: "create-1", plan: "growth", image, region: "us-east-1",
      cpu: 1, memoryMb: 4096, timeoutSeconds: 120, maximumCredits: 100, gpu: "L4" });
    expect(record).toMatchObject({ providerId: "sbx_provider_1", state: "running", tenantId: "tenant-1", idempotencyKey: "create-1" });
    expect(client.create).toHaveBeenCalledWith({ image, cpu: 1, memoryMb: 4096, region: "us-east-1", timeoutSeconds: 120, gpu: "L4" });
    expect(hooks.reserve).toHaveBeenCalledWith(record.id, 100);
    expect(hooks.claim).toHaveBeenCalledOnce();
    expect(hooks.record).toHaveBeenCalledTimes(3);
    expect(vi.mocked(hooks.record).mock.calls.map(([saved]) => saved.state)).toEqual(["reserved", "creating", "running"]);
  });

  it("keeps the reservation and records an unknown outcome if provider creation fails", async () => {
    const { client, hooks } = setup();
    vi.mocked(client.create).mockRejectedValueOnce(new Error("provider unavailable"));
    const record = await createModalSandbox({ client, hooks, tenantId: "tenant-1", spaceId: "space-1", projectId: "project-1", actorId: "owner-1", idempotencyKey: "create-unknown", plan: "growth", image, region: "us-east-1",
      cpu: 1, memoryMb: 4096, timeoutSeconds: 120, maximumCredits: 100, gpu: "L4" });
    expect(record).toMatchObject({ state: "unknown", errorCode: "modal_create_outcome_unknown" });
    expect(hooks.release).not.toHaveBeenCalled();
    expect(hooks.record).toHaveBeenCalledTimes(3);
    expect(client.create).toHaveBeenCalledOnce();
    const retried = await createModalSandbox({ client, hooks, tenantId: "tenant-1", spaceId: "space-1", projectId: "project-1", actorId: "owner-1", idempotencyKey: "create-unknown", plan: "growth", image, region: "us-east-1",
      cpu: 1, memoryMb: 4096, timeoutSeconds: 120, maximumCredits: 100, gpu: "L4" });
    expect(retried).toEqual(record);
    expect(client.create).toHaveBeenCalledOnce();
  });

  it("settles one provider usage receipt and rejects a changed receipt", async () => {
    const { client, hooks } = setup(4);
    const record = { id: "modal:1", tenantId: "tenant-1", spaceId: "space-1", projectId: "project-1", actorId: "owner-1", idempotencyKey: "create-1", requestHash: "a".repeat(64),
      providerId: "sbx_provider_1", image, cpu: 1, memoryMb: 4096, region: "us-east-1", timeoutSeconds: 120, gpu: "L4", state: "running" as const, revision: 0, createdAt: 1, updatedAt: 1, reservedCredits: 100 };
    const reconciled = await reconcileModalSandbox(client, hooks, record);
    expect(reconciled.actualCredits).toBe(4);
    expect(hooks.settle).toHaveBeenCalledExactlyOnceWith(record.id, 4);
    await reconcileModalSandbox(client, hooks, reconciled);
    expect(hooks.settle).toHaveBeenCalledOnce();
    vi.mocked(client.inspect).mockResolvedValueOnce({ state: "stopped", actualCredits: 5 });
    await expect(reconcileModalSandbox(client, hooks, reconciled)).rejects.toThrow("modal_usage_receipt_changed_after_settlement");
  });

  it("never treats the full reservation as provider usage during termination", async () => {
    const { client, hooks } = setup(6);
    const record = { id: "modal:2", tenantId: "tenant-1", spaceId: "space-1", projectId: "project-1", actorId: "owner-1", idempotencyKey: "create-2", requestHash: "b".repeat(64),
      providerId: "sbx_provider_2", image, cpu: 1, memoryMb: 4096, region: "us-east-1", timeoutSeconds: 120, gpu: "L4", state: "running" as const, revision: 0, createdAt: 1, updatedAt: 1, reservedCredits: 100 };
    await terminateModalSandbox(client, hooks, record);
    expect(client.terminate).toHaveBeenCalledWith(record.providerId);
    expect(hooks.settle).toHaveBeenCalledExactlyOnceWith(record.id, 6);
  });

  it("does not claim termination is reconciled when the provider has not reported usage", async () => {
    const { client, hooks } = setup(null);
    const record = { id: "modal:4", tenantId: "tenant-1", spaceId: "space-1", projectId: "project-1", actorId: "owner-1", idempotencyKey: "create-4", requestHash: "d".repeat(64),
      providerId: "sbx_provider_4", image, cpu: 1, memoryMb: 4096, region: "us-east-1", timeoutSeconds: 120, gpu: "L4", state: "running" as const, revision: 0, createdAt: 1, updatedAt: 1, reservedCredits: 100 };
    await expect(terminateModalSandbox(client, hooks, record)).rejects.toThrow("modal_usage_receipt_unavailable");
    expect(hooks.settle).not.toHaveBeenCalled();
  });

  it("settles measured over-reservation usage and records the overrun for billing policy", async () => {
    const { client, hooks } = setup(101);
    const record = { id: "modal:3", tenantId: "tenant-1", spaceId: "space-1", projectId: "project-1", actorId: "owner-1", idempotencyKey: "create-3", requestHash: "c".repeat(64),
      providerId: "sbx_provider_3", image, cpu: 1, memoryMb: 4096, region: "us-east-1", timeoutSeconds: 120, gpu: "L4", state: "running" as const, revision: 0, createdAt: 1, updatedAt: 1, reservedCredits: 100 };
    const reconciled = await reconcileModalSandbox(client, hooks, record);
    expect(reconciled).toMatchObject({ actualCredits: 101, overrunCredits: 1 });
    expect(hooks.settle).toHaveBeenCalledExactlyOnceWith(record.id, 101);
  });
});
