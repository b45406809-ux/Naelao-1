import { assertExecutionPlanResources } from "@naelao/entitlements";

export interface ModalSandboxClient {
  create(input: { image: string; cpu: number; memoryMb: number; gpu?: string; region: string; timeoutSeconds: number }): Promise<{ id: string; state: "running" | "stopped" }>;
  terminate(id: string): Promise<void>;
  inspect(id: string): Promise<{ state: "running" | "stopped" | "unknown"; actualCredits?: number }>;
}
export interface ModalLifecycleHooks {
  /** Stable by owner and idempotency key. A prior intent is returned instead of re-dispatching. */
  load(scope: Pick<ModalSandboxRecord, "tenantId" | "spaceId" | "projectId">, idempotencyKey: string): Promise<{ requestHash: string; record: ModalSandboxRecord } | null>;
  /** Atomically claim a new idempotency identity before reservation or provider effects. */
  claim(record: ModalSandboxRecord): Promise<boolean>;
  reserve(id: string, credits: number): Promise<void>;
  /** Must be durable and idempotent by reservation id; replayed equal usage settles once. */
  settle(id: string, actualCredits: number): Promise<void>;
  release(id: string): Promise<void>;
  /** Persist each state transition before the next external effect. */
  record(record: ModalSandboxRecord): Promise<void>;
}
export interface ModalSandboxRecord {
  id: string; tenantId: string; spaceId: string; projectId: string; actorId: string; idempotencyKey: string;
  requestHash: string; providerId?: string; image: string; cpu: number; memoryMb: number; region: string; timeoutSeconds: number;
  gpu: string;
  state: "pending" | "reserved" | "creating" | "running" | "stopping" | "stopped" | "unknown" | "failed";
  revision: number; errorCode?: string; createdAt: number; updatedAt: number; reservedCredits: number; actualCredits?: number; overrunCredits?: number;
}
const PIN = /^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
async function sha256(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
export async function createModalSandbox(input: {
  client: ModalSandboxClient; hooks: ModalLifecycleHooks; tenantId: string; spaceId: string; projectId: string; actorId: string;
  idempotencyKey: string; plan: string; image: string; region: string;
  cpu: number; memoryMb: number; timeoutSeconds: number; maximumCredits: number; gpu: string;
}): Promise<ModalSandboxRecord> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(input.tenantId) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(input.spaceId)
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(input.projectId)
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(input.actorId) || !IDEMPOTENCY_KEY.test(input.idempotencyKey)
    || !PIN.test(input.image) || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(input.region)
    || !Number.isSafeInteger(input.timeoutSeconds) || input.timeoutSeconds < 1 || input.timeoutSeconds > 3600
    || !Number.isSafeInteger(input.maximumCredits) || input.maximumCredits < 1 || input.maximumCredits > 1_000_000
    || !/^[A-Za-z0-9._-]{1,64}$/.test(input.gpu)) throw new Error("modal_sandbox_request_invalid");
  assertExecutionPlanResources(input.plan, { cpuCores: input.cpu, memoryMb: input.memoryMb });
  const requestHash = await sha256(JSON.stringify([input.image,input.cpu,input.memoryMb,input.region,input.timeoutSeconds,input.maximumCredits,input.gpu]));
  const scope = { tenantId: input.tenantId, spaceId: input.spaceId, projectId: input.projectId };
  const prior = await input.hooks.load(scope, input.idempotencyKey);
  if (prior) {
    if (prior.record.requestHash !== requestHash) throw new Error("modal_sandbox_idempotency_conflict");
    return prior.record;
  }
  const id = `modal:${(await sha256(`${input.tenantId}\0${input.spaceId}\0${input.projectId ?? ""}\0${input.idempotencyKey}`)).slice(0, 40)}`;
  let record: ModalSandboxRecord = { id, tenantId: input.tenantId, spaceId: input.spaceId, projectId: input.projectId,
    actorId: input.actorId, idempotencyKey: input.idempotencyKey, requestHash,
    image: input.image, cpu: input.cpu, memoryMb: input.memoryMb, region: input.region, timeoutSeconds: input.timeoutSeconds,
    gpu: input.gpu,
    state: "pending", revision: 0, createdAt: Date.now(), updatedAt: Date.now(), reservedCredits: input.maximumCredits };
  if (!await input.hooks.claim(record)) {
    const raced = await input.hooks.load(scope, input.idempotencyKey);
    if (!raced || raced.requestHash !== requestHash) throw new Error("modal_sandbox_idempotency_conflict");
    return raced.record;
  }
  try {
    await input.hooks.reserve(id, input.maximumCredits);
  } catch {
    record = { ...record, state: "unknown", revision: record.revision + 1, errorCode: "modal_credit_reservation_outcome_unknown", updatedAt: Date.now() };
    await input.hooks.record(record).catch(() => undefined);
    return record;
  }
  record = { ...record, state: "reserved", revision: record.revision + 1, updatedAt: Date.now() };
  await input.hooks.record(record);
  record = { ...record, state: "creating", revision: record.revision + 1, updatedAt: Date.now() };
  await input.hooks.record(record);
  try {
    const created = await input.client.create({ image: input.image, cpu: input.cpu, memoryMb: input.memoryMb, region: input.region,
      timeoutSeconds: input.timeoutSeconds, gpu: input.gpu });
    if (!created.id || created.id.length > 256 || /[\r\n\0]/.test(created.id)
      || created.state !== "running" && created.state !== "stopped") {
      record = { ...record, state: "unknown", revision: record.revision + 1, errorCode: "modal_provider_receipt_invalid", updatedAt: Date.now() };
      await input.hooks.record(record).catch(() => undefined);
      return record;
    }
    record = { ...record, providerId: created.id, state: created.state, revision: record.revision + 1, updatedAt: Date.now() };
    await input.hooks.record(record);
    return record;
  } catch {
    // The provider may have accepted the create before the response was lost. Keep the
    // reservation and require read-only reconciliation; never replay or release blindly.
    record = { ...record, state: "unknown", revision: record.revision + 1, errorCode: "modal_create_outcome_unknown", updatedAt: Date.now() };
    await input.hooks.record(record).catch(() => undefined);
    return record;
  }
}
export async function reconcileModalSandbox(client: ModalSandboxClient, hooks: ModalLifecycleHooks, record: ModalSandboxRecord): Promise<ModalSandboxRecord> {
  if (!record.providerId) throw new Error("modal_provider_identity_unavailable");
  const receipt = await client.inspect(record.providerId);
  const updated: ModalSandboxRecord = { ...record, state: receipt.state, revision: record.revision + 1, updatedAt: Date.now() };
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
  if (!record.providerId || record.state !== "running") throw new Error("modal_sandbox_not_terminable");
  const stopping = { ...record, state: "stopping" as const, revision: record.revision + 1, updatedAt: Date.now() };
  await hooks.record(stopping);
  try { await client.terminate(record.providerId); }
  catch {
    await hooks.record({ ...stopping, state: "unknown", revision: stopping.revision + 1, errorCode: "modal_termination_outcome_unknown", updatedAt: Date.now() }).catch(() => undefined);
    throw new Error("modal_termination_outcome_unknown");
  }
  // Provider billing is authoritative. Never charge the full reservation merely because
  // termination was requested; reconcile only after a provider usage receipt is available.
  const stopped = await reconcileModalSandbox(client, hooks, { ...stopping, state: "stopped" });
  if (stopped.state !== "stopped") throw new Error("modal_sandbox_termination_unconfirmed");
  if (stopped.actualCredits === undefined) throw new Error("modal_usage_receipt_unavailable");
}
