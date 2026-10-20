import { describe, expect, it } from "vitest";
import { WorkflowJournal, type WorkflowJournalRecord, type WorkflowJournalStorage } from "./workflow-state.js";

function storageFixture() {
  const values = new Map<string, unknown>();
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
  values.set("run", { usedCredits: 0, activeEffects: [], usageUncertain: false } as WorkflowJournalRecord);
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
});
