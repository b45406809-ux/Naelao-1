import { describe, expect, it, vi } from "vitest";
import { handleProvisionQueueMessage } from "./queue-message-handler.js";
import type { ProvisionQueueMessage } from "./queue-message-handler.js";
import type { ProvisionMessage } from "./message-contract.js";

const validMessage: ProvisionMessage = {
  type: "space_provision",
  spaceId: "space-a",
  tenantId: "tenant-a",
  spaceTypeId: "launchpad",
  spaceName: "Acme",
  requestedAt: "2026-10-20T00:00:00.000Z",
};

function queueMessage(body: unknown) {
  const ack = vi.fn();
  const retry = vi.fn();
  return { message: { body, ack, retry } satisfies ProvisionQueueMessage, ack, retry };
}

describe("provision queue dispatch", () => {
  it("acknowledges malformed or unknown messages without invoking side effects", async () => {
    const entry = queueMessage({ ...validMessage, type: "unknown" });
    const handlers = { provision: vi.fn(), deprovision: vi.fn() };
    await handleProvisionQueueMessage(entry.message, handlers);
    expect(entry.ack).toHaveBeenCalledOnce();
    expect(entry.retry).not.toHaveBeenCalled();
    expect(handlers.provision).not.toHaveBeenCalled();
    expect(handlers.deprovision).not.toHaveBeenCalled();
  });

  it("acknowledges successfully provisioned and deprovisioned messages once", async () => {
    const provision = queueMessage(validMessage);
    const deprovision = queueMessage({ ...validMessage, type: "space_deprovision" });
    const handlers = { provision: vi.fn(async () => undefined), deprovision: vi.fn(async () => undefined) };
    await handleProvisionQueueMessage(provision.message, handlers);
    await handleProvisionQueueMessage(deprovision.message, handlers);
    expect(handlers.provision).toHaveBeenCalledOnce();
    expect(handlers.deprovision).toHaveBeenCalledOnce();
    expect(provision.ack).toHaveBeenCalledOnce();
    expect(deprovision.ack).toHaveBeenCalledOnce();
    expect(provision.retry).not.toHaveBeenCalled();
    expect(deprovision.retry).not.toHaveBeenCalled();
  });

  it("retries valid messages when the side-effect handler fails", async () => {
    const entry = queueMessage(validMessage);
    const handlers = { provision: vi.fn(async () => { throw new Error("transient D1 failure"); }), deprovision: vi.fn(async () => undefined) };
    await handleProvisionQueueMessage(entry.message, handlers);
    expect(entry.retry).toHaveBeenCalledOnce();
    expect(entry.ack).not.toHaveBeenCalled();
  });
});
