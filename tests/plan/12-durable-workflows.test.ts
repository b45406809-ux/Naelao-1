import { describe, expect, it } from "vitest";
import { durableWorkflowRunId, serializeWorkflowCheckpoint, transitionWorkflow, validateDurableWorkflowIdentity, validateWorkflowPointer,
  type DurableWorkflowIdentity, type DurableWorkflowRecord } from "../../packages/agent-sdk/src/workflow-taxonomy.js";
import { compileWorkflowEntrypoint } from "../../workers/agents/src/workflows/workflow-compiler.js";
import { WorkflowJournal, type WorkflowJournalStorage } from "../../workers/agents/src/workflows/workflow-state.js";

class PersistedStorage implements WorkflowJournalStorage {
  data = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> { return structuredClone(this.data.get(key)) as T | undefined; }
  async put<T>(key: string, value: T): Promise<void> { this.data.set(key, structuredClone(value)); }
  async transaction<T>(callback: (storage: WorkflowJournalStorage) => Promise<T>): Promise<T> { return callback(this); }
}

const identity: DurableWorkflowIdentity = {
  schema: 1, runId: "wf-123", tenantId: "tenant-one", spaceId: "space-one", projectId: "project-one",
  actorId: "user-one", agentId: "worker-one", grantVersion: "v1", codeDigest: "a".repeat(64),
  codeKey: "workflow-code/tenant-one/space-one/" + "a".repeat(64), startKey: "request-one",
  expiresAt: 2_000_000_000_000, workflowClass: "ephemeral_task", capabilities: ["project.read"],
};
async function initializedJournal(storage: PersistedStorage): Promise<WorkflowJournal> {
  const journal = new WorkflowJournal(storage);
  await journal.initialize(identity, {
    schema: 1,
    r2_key: "workflow-artifacts/tenant-one/space-one/wf-123/input.json",
    sha256: "e".repeat(64),
    bytes: 2,
  }, {});
  return journal;
}
describe("Step 12 durable workflow contracts", () => {
  it("deduplicates starts within an actor and isolates tenant keys", async () => {
    expect(await durableWorkflowRunId(identity, "request-one")).toBe(await durableWorkflowRunId(identity, "request-one"));
    expect(await durableWorkflowRunId(identity, "request-one")).not.toBe(await durableWorkflowRunId({ ...identity, tenantId: "tenant-two" }, "request-one"));
  });
  it("rejects non-JSON, secrets and oversized inline checkpoints", () => {
    expect(() => serializeWorkflowCheckpoint(new Request("https://example.com"))).toThrow("not_json");
    expect(() => serializeWorkflowCheckpoint({ api_key: "secret" })).toThrow("secret");
    expect(() => serializeWorkflowCheckpoint({ body: "x".repeat(1024) })).toThrow("r2_pointer");
  });
  it("checks artifact ownership and pinned code identity", () => {
    expect(() => validateDurableWorkflowIdentity(identity, 1000)).not.toThrow();
    expect(() => validateDurableWorkflowIdentity({ ...identity, codeKey: "workflow-code/another/space/code" }, 1000)).toThrow("scope");
    expect(() => validateWorkflowPointer(identity, { schema: 1, r2_key: "workflow-artifacts/other/space-one/wf-123/result", sha256: "b".repeat(64), bytes: 12 })).toThrow("pointer");
  });
  it("does not resurrect a terminal workflow and expires resumed work", () => {
    const record: DurableWorkflowRecord = { identity, status: "running", updatedAt: 1000, attempt: 1 };
    const cancelled = transitionWorkflow(record, "cancelled", 2000);
    expect(() => transitionWorkflow(cancelled, "running", 3000)).toThrow("terminal");
    expect(transitionWorkflow(record, "running", identity.expiresAt + 1).status).toBe("expired");
  });
  it("compiles typed workflow code without keyword-intent rejection", async () => {
    const compiled = await compileWorkflowEntrypoint('export async function execute(step: any, ctx: any) { const text="threads and channels"; return step.do("first", async()=>text); }');
    expect(compiled.source).toContain("nativeStep.sleep");
    expect(compiled.source).toContain("control.authorize");
    expect(compiled.source).not.toContain('step.do("execute"');
    await expect(compileWorkflowEntrypoint('import fs from "node:fs"; export function execute(step,ctx){}')).rejects.toThrow("import");
  });
  it("reuses a committed effect after a new host instance reconstructs the journal", async () => {
    const storage = new PersistedStorage();
    const firstHost = await initializedJournal(storage);
    const claim = await firstHost.prepareExternalEffect("notify", "notify.send", "b".repeat(64));
    let effects = 0;
    if (claim.created) effects++;
    const pointer = { schema: 1 as const, r2_key: "workflow-artifacts/tenant-one/space-one/wf-123/receipt.json", sha256: "c".repeat(64), bytes: 16 };
    await firstHost.commitEffect(claim.effect, pointer, 0);
    const resumed = await new WorkflowJournal(storage).prepareExternalEffect("notify", "notify.send", "b".repeat(64));
    if (resumed.created) effects++;
    expect(effects).toBe(1);
    expect(resumed.effect.result).toEqual(pointer);
    expect(resumed.effect.status).toBe("committed");
  });
  it("never repeats a prepared effect with an uncertain external outcome", async () => {
    const storage = new PersistedStorage();
    const claim = await (await initializedJournal(storage)).prepareExternalEffect("charge", "payment.charge", "b".repeat(64));
    expect(claim.created).toBe(true);
    const recovered = await new WorkflowJournal(storage).prepareExternalEffect("charge", "payment.charge", "b".repeat(64));
    expect(recovered.created).toBe(false);
    expect(recovered.effect.status).toBe("prepared");
    await expect(new WorkflowJournal(storage).prepareExternalEffect("charge", "payment.charge", "d".repeat(64))).rejects.toThrow("conflict");
  });
  it("keeps sleeping state through reconstruction and cancellation stays terminal", async () => {
    const storage = new PersistedStorage();
    const journal = new WorkflowJournal(storage);
    const pointer = { schema: 1 as const, r2_key: "workflow-artifacts/tenant-one/space-one/wf-123/input", sha256: "e".repeat(64), bytes: 2 };
    await journal.initialize(identity, pointer, {});
    await journal.transition("sleeping");
    expect((await new WorkflowJournal(storage).read()).status).toBe("sleeping");
    await journal.transition("cancelled");
    const recovered = new WorkflowJournal(storage);
    await expect(recovered.transition("running")).rejects.toThrow("terminal");
    expect((await recovered.read()).cleanupPending).toBe(true);
  });
  it("deduplicates persisted start records and rejects changed input for the same key", async () => {
    const journal = new WorkflowJournal(new PersistedStorage());
    const pointer = { schema: 1 as const, r2_key: "workflow-artifacts/tenant-one/space-one/wf-123/input", sha256: "e".repeat(64), bytes: 2 };
    const first = await journal.initialize(identity, pointer, {});
    expect(await journal.initialize(identity, pointer, {})).toEqual(first);
    await expect(journal.initialize(identity, { ...pointer, sha256: "f".repeat(64) }, {})).rejects.toThrow("conflict");
  });
});
