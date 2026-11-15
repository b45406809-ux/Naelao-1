import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createFakeD1 } from "../../../../tests/stubs/d1-sqlite.js";
import { createModalSandboxD1Hooks, listModalSandboxOperationStatus } from "./modal-sandbox-journal.js";
import type { ModalSandboxRecord } from "./modal-lifecycle.js";

const record: ModalSandboxRecord = {
  id: "modal:operation-1", tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a", actorId: "owner-a",
  idempotencyKey: "create-1", requestHash: "a".repeat(64), image: `registry.example/sandbox@sha256:${"b".repeat(64)}`,
  cpu: 2, memoryMb: 8192, region: "us-east-1", timeoutSeconds: 300, gpu: "L4", state: "pending", revision: 0, createdAt: 1_794_600_000_000,
  updatedAt: 1_794_600_000_000, reservedCredits: 500,
};

function setup() {
  const db = createFakeD1([readFileSync(new URL("../../../../infra/migrations/0256_modal_sandbox_operation_journal.sql", import.meta.url), "utf8")]);
  const billing = { reserve: vi.fn(async () => undefined), settle: vi.fn(async () => undefined), release: vi.fn(async () => undefined) };
  return { db, billing, hooks: createModalSandboxD1Hooks(db, billing) };
}

describe("Modal operation journal", () => {
  it("atomically claims a scoped idempotency key before external work and returns its durable state", async () => {
    const { db, hooks } = setup();
    await expect(hooks.load({ tenantId: record.tenantId, spaceId: record.spaceId, projectId: record.projectId }, record.idempotencyKey)).resolves.toBeNull();
    await expect(hooks.claim(record)).resolves.toBe(true);
    await expect(hooks.claim(record)).resolves.toBe(false);
    await expect(hooks.load({ tenantId: record.tenantId, spaceId: record.spaceId, projectId: record.projectId }, record.idempotencyKey))
      .resolves.toEqual({ requestHash: record.requestHash, record });
    expect(await db.prepare("SELECT state,reserved_credits,request_json FROM modal_sandbox_operations").first())
      .toMatchObject({ state: "pending", reserved_credits: 500 });
    expect(await db.prepare("SELECT COUNT(*) AS count FROM modal_sandbox_operation_events").first()).toEqual({ count: 1 });
  });

  it("records state transitions and keeps a bounded actor-attributed event history", async () => {
    const { db, hooks } = setup();
    await hooks.claim(record);
    await hooks.record({ ...record, state: "reserved", revision: 1, updatedAt: record.updatedAt + 1000 });
    await hooks.record({ ...record, providerId: "sbx_abc123", state: "running", revision: 2, updatedAt: record.updatedAt + 2000 });
    await expect(hooks.load({ tenantId: record.tenantId, spaceId: record.spaceId, projectId: record.projectId }, record.idempotencyKey))
      .resolves.toMatchObject({ requestHash: record.requestHash, record: { providerId: "sbx_abc123", state: "running" } });
    expect(await db.prepare("SELECT state,provider_id,record_json FROM modal_sandbox_operations").first())
      .toMatchObject({ state: "running", provider_id: "sbx_abc123" });
    expect(await db.prepare("SELECT COUNT(*) AS count FROM modal_sandbox_operation_events").first()).toEqual({ count: 3 });
  });

  it("rejects stale concurrent state writes instead of overwriting a newer provider state", async () => {
    const { hooks } = setup();
    await hooks.claim(record);
    const accepted = { ...record, state: "reserved" as const, revision: 1, updatedAt: record.updatedAt + 1000 };
    await hooks.record(accepted);
    await expect(hooks.record({ ...accepted, state: "creating", updatedAt: record.updatedAt + 2000 }))
      .rejects.toThrow("modal_operation_journal_write_failed");
  });

  it("rejects reusing an idempotency key with a changed request and isolates projects", async () => {
    const { hooks } = setup();
    await hooks.claim(record);
    await expect(hooks.claim({ ...record, requestHash: "c".repeat(64), image: `registry.example/other@sha256:${"d".repeat(64)}` }))
      .rejects.toThrow("modal_sandbox_idempotency_conflict");
    await expect(hooks.load({ tenantId: record.tenantId, spaceId: record.spaceId, projectId: "other-project" }, record.idempotencyKey))
      .resolves.toBeNull();
  });

  it("returns only safe status fields for the exact tenant, Space and Project", async () => {
    const { db, hooks } = setup();
    await hooks.claim(record);
    await hooks.record({ ...record, providerId: "provider-secret", state: "running", revision: 1,
      actualCredits: 620, overrunCredits: 120, updatedAt: record.updatedAt + 1000 });
    await hooks.claim({ ...record, id: "modal:other-project", tenantId: "tenant-a", spaceId: "space-a", projectId: "project-b",
      actorId: "owner-b", idempotencyKey: "other-project-key" });
    await hooks.claim({ ...record, id: "modal:other-tenant", tenantId: "tenant-b", spaceId: "space-a", projectId: "project-a",
      actorId: "owner-c", idempotencyKey: "other-tenant-key" });

    const status = await listModalSandboxOperationStatus(db, { tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a" });
    expect(status).toEqual([{
      operationId: record.id, state: "running", region: record.region, revision: 1, reservedCredits: 500,
      actualCredits: 620, overrunCredits: 120, errorCode: null,
      createdAt: new Date(record.createdAt).toISOString(), updatedAt: new Date(record.updatedAt + 1000).toISOString(),
    }]);
    expect(JSON.stringify(status)).not.toContain("provider-secret");
    expect(status[0]).not.toHaveProperty("idempotencyKey");
    expect(status[0]).not.toHaveProperty("actorId");
    expect(status[0]).not.toHaveProperty("request");
  });

  it("bounds history to 25 rows in deterministic newest-first order", async () => {
    const { db, hooks } = setup();
    for (let index = 0; index < 30; index++) {
      const suffix = String(index).padStart(2, "0");
      await hooks.claim({ ...record, id: `modal:operation-${suffix}`, idempotencyKey: `create-${suffix}`,
        createdAt: record.createdAt + index * 1000, updatedAt: record.updatedAt + index * 1000 });
    }
    const status = await listModalSandboxOperationStatus(db, { tenantId: record.tenantId, spaceId: record.spaceId, projectId: record.projectId });
    expect(status).toHaveLength(25);
    expect(status[0]?.operationId).toBe("modal:operation-29");
    expect(status.at(-1)?.operationId).toBe("modal:operation-05");
  });
});
