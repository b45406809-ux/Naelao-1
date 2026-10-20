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
  values.set("run", { usedCredits: 0 } as WorkflowJournalRecord);
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
});
