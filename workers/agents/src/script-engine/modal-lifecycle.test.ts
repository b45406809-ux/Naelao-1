import { describe, expect, it, vi } from "vitest";
import { createModalSandbox, reconcileModalSandbox, terminateModalSandbox, type ModalLifecycleHooks, type ModalSandboxClient } from "./modal-lifecycle.js";

const image = `registry.example/sandbox@sha256:${"a".repeat(64)}`;
function setup(actualCredits: number | null = 4) {
  const client: ModalSandboxClient = {
    create: vi.fn(async () => ({ id: "sbx_provider_1" })),
    terminate: vi.fn(async () => undefined),
    inspect: vi.fn(async () => ({ state: "stopped" as const, ...(actualCredits === null ? {} : { actualCredits }) })),
  };
  const hooks: ModalLifecycleHooks = {
    reserve: vi.fn(async () => undefined), settle: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined), record: vi.fn(async () => undefined),
  };
  return { client, hooks };
}

describe("Modal sandbox lifecycle adapter", () => {
  it("reserves a bounded plan allowance and creates only from a pinned image", async () => {
    const { client, hooks } = setup();
    const record = await createModalSandbox({ client, hooks, tenantId: "tenant-1", plan: "growth", image,
      cpu: 1, memoryMb: 4096, timeoutSeconds: 120, maximumCredits: 100 });
    expect(record.providerId).toBe("sbx_provider_1");
    expect(client.create).toHaveBeenCalledWith({ image, cpu: 1, memoryMb: 4096, timeoutSeconds: 120 });
    expect(hooks.reserve).toHaveBeenCalledWith(record.id, 100);
    expect(hooks.record).toHaveBeenCalledWith(record);
  });

  it("releases the reservation if provider creation fails", async () => {
    const { client, hooks } = setup();
    vi.mocked(client.create).mockRejectedValueOnce(new Error("provider unavailable"));
    await expect(createModalSandbox({ client, hooks, tenantId: "tenant-1", plan: "growth", image,
      cpu: 1, memoryMb: 4096, timeoutSeconds: 120, maximumCredits: 100 })).rejects.toThrow("provider unavailable");
    expect(hooks.release).toHaveBeenCalledOnce();
    expect(hooks.record).not.toHaveBeenCalled();
  });

  it("settles one provider usage receipt and rejects a changed receipt", async () => {
    const { client, hooks } = setup(4);
    const record = { id: "modal:1", providerId: "sbx_provider_1", image, state: "running" as const,
      createdAt: 1, updatedAt: 1, reservedCredits: 100 };
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
    const record = { id: "modal:2", providerId: "sbx_provider_2", image, state: "running" as const,
      createdAt: 1, updatedAt: 1, reservedCredits: 100 };
    await terminateModalSandbox(client, hooks, record);
    expect(client.terminate).toHaveBeenCalledWith(record.providerId);
    expect(hooks.settle).toHaveBeenCalledExactlyOnceWith(record.id, 6);
  });

  it("does not claim termination is reconciled when the provider has not reported usage", async () => {
    const { client, hooks } = setup(null);
    const record = { id: "modal:4", providerId: "sbx_provider_4", image, state: "running" as const,
      createdAt: 1, updatedAt: 1, reservedCredits: 100 };
    await expect(terminateModalSandbox(client, hooks, record)).rejects.toThrow("modal_usage_receipt_unavailable");
    expect(hooks.settle).not.toHaveBeenCalled();
  });

  it("settles measured over-reservation usage and records the overrun for billing policy", async () => {
    const { client, hooks } = setup(101);
    const record = { id: "modal:3", providerId: "sbx_provider_3", image, state: "running" as const,
      createdAt: 1, updatedAt: 1, reservedCredits: 100 };
    const reconciled = await reconcileModalSandbox(client, hooks, record);
    expect(reconciled).toMatchObject({ actualCredits: 101, overrunCredits: 1 });
    expect(hooks.settle).toHaveBeenCalledExactlyOnceWith(record.id, 101);
  });
});
