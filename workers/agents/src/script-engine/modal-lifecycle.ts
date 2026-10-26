import { assertExecutionPlanResources } from "@naelao/entitlements";

export interface ModalSandboxClient {
  create(input: { image: string; cpu: number; memoryMb: number; gpu?: string; timeoutSeconds: number; persistentVolume?: string }): Promise<{ id: string }>;
  terminate(id: string): Promise<void>;
  inspect(id: string): Promise<{ state: "running" | "stopped" | "unknown"; actualCredits?: number }>;
}
export interface ModalLifecycleHooks {
  reserve(id: string, credits: number): Promise<void>;
  /** Must be durable and idempotent by reservation id; replayed equal usage settles once. */
  settle(id: string, actualCredits: number): Promise<void>;
  release(id: string): Promise<void>;
  record(record: ModalSandboxRecord): Promise<void>;
}
export interface ModalSandboxRecord {
  id: string; providerId: string; image: string; state: "running" | "stopped" | "unknown";
  createdAt: number; updatedAt: number; reservedCredits: number; actualCredits?: number; overrunCredits?: number;
}
const PIN = /^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/;
export async function createModalSandbox(input: {
  client: ModalSandboxClient; hooks: ModalLifecycleHooks; tenantId: string; plan: string; image: string;
  cpu: number; memoryMb: number; timeoutSeconds: number; maximumCredits: number; gpu?: string; persistentVolume?: string;
}): Promise<ModalSandboxRecord> {
  if (!input.tenantId || !PIN.test(input.image) || !Number.isSafeInteger(input.timeoutSeconds) || input.timeoutSeconds < 1 || input.timeoutSeconds > 3600
    || !Number.isSafeInteger(input.maximumCredits) || input.maximumCredits < 1 || input.maximumCredits > 1_000_000
    || input.gpu !== undefined && !/^[A-Za-z0-9._-]{1,64}$/.test(input.gpu)
    || input.persistentVolume !== undefined && !/^[A-Za-z0-9._-]{1,128}$/.test(input.persistentVolume)) throw new Error("modal_sandbox_request_invalid");
  assertExecutionPlanResources(input.plan, { cpuCores: input.cpu, memoryMb: input.memoryMb });
  const id = `modal:${crypto.randomUUID()}`;
  await input.hooks.reserve(id, input.maximumCredits);
  let providerId: string | undefined;
  try {
    const created = await input.client.create({ image: input.image, cpu: input.cpu, memoryMb: input.memoryMb,
      timeoutSeconds: input.timeoutSeconds, ...(input.gpu ? { gpu: input.gpu } : {}), ...(input.persistentVolume ? { persistentVolume: input.persistentVolume } : {}) });
    if (!created.id || created.id.length > 256) throw new Error("modal_provider_receipt_invalid");
    providerId = created.id;
    const record: ModalSandboxRecord = { id, providerId, image: input.image, state: "running", createdAt: Date.now(), updatedAt: Date.now(), reservedCredits: input.maximumCredits };
    await input.hooks.record(record);
    return record;
  } catch (error) {
    if (providerId) await input.client.terminate(providerId).catch(() => undefined);
    await input.hooks.release(id).catch(() => undefined);
    throw error;
  }
}
export async function reconcileModalSandbox(client: ModalSandboxClient, hooks: ModalLifecycleHooks, record: ModalSandboxRecord): Promise<ModalSandboxRecord> {
  const receipt = await client.inspect(record.providerId);
  const updated: ModalSandboxRecord = { ...record, state: receipt.state, updatedAt: Date.now() };
  if (receipt.actualCredits !== undefined) {
    if (!Number.isSafeInteger(receipt.actualCredits) || receipt.actualCredits < 0) throw new Error("modal_usage_receipt_invalid");
    if (record.actualCredits === undefined) {
      updated.actualCredits = receipt.actualCredits;
      if (receipt.actualCredits > record.reservedCredits) updated.overrunCredits = receipt.actualCredits - record.reservedCredits;
      await hooks.settle(record.id, receipt.actualCredits);
    } else if (record.actualCredits !== receipt.actualCredits) {
      throw new Error("modal_usage_receipt_changed_after_settlement");
    }
  }
  await hooks.record(updated);
  return updated;
}
export async function terminateModalSandbox(client: ModalSandboxClient, hooks: ModalLifecycleHooks, record: ModalSandboxRecord): Promise<void> {
  await client.terminate(record.providerId);
  // Provider billing is authoritative. Never charge the full reservation merely because
  // termination was requested; reconcile only after a provider usage receipt is available.
  const stopped = await reconcileModalSandbox(client, hooks, { ...record, state: "stopped" });
  if (stopped.state !== "stopped") throw new Error("modal_sandbox_termination_unconfirmed");
  if (stopped.actualCredits === undefined) throw new Error("modal_usage_receipt_unavailable");
}
