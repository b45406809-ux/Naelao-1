import { describe, expect, it } from "vitest";
import { MAX_WORKFLOW_EFFECTS, WorkflowJournal, type WorkflowJournalRecord, type WorkflowJournalStorage } from "./workflow-state.js";

function storageFixture() {
  const values = new Map<string, unknown>();
  const input = { schema: 1 as const, r2_key: "workflow-artifacts/tenant/space/run/input.json", sha256: "b".repeat(64), bytes: 2 };
  let transactionTail: Promise<unknown> = Promise.resolve();
  const storage: WorkflowJournalStorage = {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async <T>(key: string, value: T) => { values.set(key, structuredClone(value)); },
    transaction: async <T>(callback: (storage: WorkflowJournalStorage) => Promise<T>) => {
      const result = transactionTail.then(() => callback(storage));
      transactionTail = result.catch(() => undefined);
      return result;
    },
  };
  values.set("run", { usedCredits: 0, activeEffects: [], usageUncertain: false, input, artifactKeys: [input.r2_key], artifactBytes: input.bytes, effectCount: 0, cleanupPending: false, status: "running" } as WorkflowJournalRecord);
  return { storage, values };
}

describe("WorkflowJournal usage accounting", () => {
  it("atomically accumulates concurrent credit measurements", async () => {
    const fixture = storageFixture();
    const journal = new WorkflowJournal(fixture.storage);
    const increments = await Promise.all([
      journal.addUsedCredits(0.25),
      journal.addUsedCredits(1.5),
      journal.addUsedCredits(2.25),
      journal.addUsedCredits(0.75),
    ]);
    expect(increments.at(-1)).toBe(4.75);
    expect((fixture.values.get("run") as { usedCredits: number }).usedCredits).toBe(4.75);
  });

  it("rejects invalid usage increments without changing the journal", async () => {
    const fixture = storageFixture();
    const journal = new WorkflowJournal(fixture.storage);
    await expect(journal.addUsedCredits(-1)).rejects.toThrow("workflow_usage_invalid");
    await expect(journal.addUsedCredits(Number.POSITIVE_INFINITY)).rejects.toThrow("workflow_usage_invalid");
    expect((fixture.values.get("run") as { usedCredits: number }).usedCredits).toBe(0);
  });

  it("commits an effect receipt and its measured credits together", async () => {
    const fixture = storageFixture();
    const journal = new WorkflowJournal(fixture.storage);
    const { effect } = await journal.prepareExternalEffect("effect-a", "agent.run", "digest-a");
    const result = { schema: 1 as const, r2_key: "result", sha256: "a".repeat(64), bytes: 2 };
    await journal.commitEffect(effect, result, 1.75);
    await journal.commitEffect(effect, result, 1.75);
    expect(fixture.values.get("effect:effect-a")).toMatchObject({ status: "committed", result: { r2_key: "result" } });
    expect((fixture.values.get("run") as { usedCredits: number }).usedCredits).toBe(1.75);
    expect((fixture.values.get("run") as WorkflowJournalRecord).activeEffects).toEqual([]);
  });

  it("does not commit an effect receipt when its usage increment is invalid", async () => {
    const fixture = storageFixture();
    const journal = new WorkflowJournal(fixture.storage);
    const { effect } = await journal.prepareExternalEffect("effect-a", "agent.run", "digest-a");
    await expect(journal.commitEffect(effect, { schema: 1, r2_key: "result", sha256: "a".repeat(64), bytes: 2 }, Number.NaN)).rejects.toThrow("workflow_usage_invalid");
    expect(fixture.values.get("effect:effect-a")).toMatchObject({ status: "prepared" });
    expect((fixture.values.get("run") as { usedCredits: number }).usedCredits).toBe(0);
  });

  it("prevents new effects after terminal cleanup begins and expires stale in-flight receipts", async () => {
    const fixture = storageFixture();
    const journal = new WorkflowJournal(fixture.storage);
    const run = fixture.values.get("run") as WorkflowJournalRecord;
    Object.assign(run, { status: "running", cleanupPending: false, identity: { expiresAt: Date.now() + 60_000 } });
    fixture.values.set("run", run);
    const { effect } = await journal.prepareExternalEffect("effect-a", "agent.run", "digest-a");
    expect((await journal.read()).activeEffects).toEqual(["effect-a"]);
    Object.assign(fixture.values.get("run") as WorkflowJournalRecord, { status: "cancelled", cleanupPending: true });
    await expect(journal.prepareExternalEffect("effect-b", "agent.run", "digest-b")).rejects.toThrow("workflow_already_terminal");
    await journal.expireStaleEffects(Date.now() + 1);
    expect(fixture.values.get("effect:effect-a")).toMatchObject({ status: "indeterminate" });
    expect((await journal.read()).activeEffects).toEqual([]);
    expect((await journal.read()).usageUncertain).toBe(true);
    await journal.markIndeterminate(effect);
    expect((await journal.read()).usageUncertain).toBe(true);
  });

  it("caps cumulative artifact count and bytes while treating identical artifacts idempotently", async () => {
    const fixture = storageFixture();
    const journal = new WorkflowJournal(fixture.storage);
    const pointer = (index: number, bytes = 1) => ({ schema: 1 as const, r2_key: `workflow-artifacts/tenant/space/run/${index}.json`, sha256: "a".repeat(64), bytes });
    await journal.reserveArtifact(pointer(1));
    await journal.reserveArtifact(pointer(1));
    expect((await journal.read()).artifactKeys).toHaveLength(2);
    await expect(journal.reserveArtifact(pointer(2, 64 * 1024 * 1024))).rejects.toThrow("workflow_artifact_budget_exceeded");
    for (let index = 2; index < 256; index++) await journal.reserveArtifact(pointer(index));
    await expect(journal.reserveArtifact(pointer(256))).rejects.toThrow("workflow_artifact_budget_exceeded");
  });

  it("caps total effect receipts without breaking idempotent replay of existing keys", async () => {
    const fixture = storageFixture();
    const journal = new WorkflowJournal(fixture.storage);
    const first = await journal.prepareEffect("effect-a", "agent.run", "digest-a");
    Object.assign(fixture.values.get("run") as WorkflowJournalRecord, { effectCount: MAX_WORKFLOW_EFFECTS });
    await expect(journal.prepareEffect("effect-a", "agent.run", "digest-a")).resolves.toMatchObject({ created: false });
    await expect(journal.prepareEffect("effect-b", "agent.run", "digest-b")).rejects.toThrow("workflow_effect_budget_exceeded");
    expect(first.created).toBe(true);
  });
});
