import { isTerminalWorkflow, transitionWorkflow, type DurableWorkflowIdentity, type DurableWorkflowRecord, type DurableEffectRecord, type WorkflowCheckpointPointer } from "@naelao/agent-sdk";

export interface WorkflowJournalStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  transaction<T>(callback: (storage: WorkflowJournalStorage) => Promise<T>): Promise<T>;
}
export interface WorkflowJournalRecord extends DurableWorkflowRecord {
  input: WorkflowCheckpointPointer;
  inputDigest: string;
  budgetKey?: string;
  budgetCredits?: number;
  usedCredits: number;
  launched: boolean;
  cleanupPending: boolean;
}

/** The journal is persisted by WorkflowRunDO. No memory-only replay protection. */
export class WorkflowJournal {
  constructor(private readonly storage: WorkflowJournalStorage) {}
  async read(): Promise<WorkflowJournalRecord> {
    const record = await this.storage.get<WorkflowJournalRecord>("run");
    if (!record) throw new Error("workflow_not_found");
    return record;
  }
  async initialize(identity: DurableWorkflowIdentity, input: WorkflowCheckpointPointer, budget: { budgetKey?: string; budgetCredits?: number }): Promise<WorkflowJournalRecord> {
    return this.storage.transaction(async (storage) => {
      const existing = await storage.get<WorkflowJournalRecord>("run");
      if (existing) {
        const { expiresAt: oldExpiry, ...oldIdentity } = existing.identity;
        const { expiresAt: newExpiry, ...newIdentity } = identity;
        if (JSON.stringify(oldIdentity) !== JSON.stringify(newIdentity) || existing.inputDigest !== input.sha256) throw new Error("workflow_start_key_conflict");
        return existing;
      }
      const record: WorkflowJournalRecord = { identity, input, inputDigest: input.sha256, ...budget, usedCredits: 0, status: "queued", attempt: 1, updatedAt: Date.now(), launched: false, cleanupPending: false };
      await storage.put("run", record);
      return record;
    });
  }
  async patch(patch: Partial<Pick<WorkflowJournalRecord, "launched" | "cleanupPending">>): Promise<void> {
    await this.storage.transaction(async (storage) => { const record = await storage.get<WorkflowJournalRecord>("run"); if (!record) throw new Error("workflow_not_found"); await storage.put("run", { ...record, ...patch, updatedAt: Date.now() }); });
  }
  async addUsedCredits(credits: number): Promise<number> {
    if (!Number.isFinite(credits) || credits < 0) throw new Error("workflow_usage_invalid");
    return this.storage.transaction(async (storage) => {
      const record = await storage.get<WorkflowJournalRecord>("run");
      if (!record) throw new Error("workflow_not_found");
      const usedCredits = record.usedCredits + credits;
      if (!Number.isFinite(usedCredits)) throw new Error("workflow_usage_overflow");
      await storage.put("run", { ...record, usedCredits, updatedAt: Date.now() });
      return usedCredits;
    });
  }
  async transition(status: WorkflowJournalRecord["status"], result?: WorkflowCheckpointPointer, error?: string): Promise<WorkflowJournalRecord> {
    return this.storage.transaction(async (storage) => {
      const record = await storage.get<WorkflowJournalRecord>("run");
      if (!record) throw new Error("workflow_not_found");
      const updated = { ...transitionWorkflow(record, status), ...(result ? { result } : {}), ...(error ? { error } : {}) } as WorkflowJournalRecord;
      if (isTerminalWorkflow(updated.status)) updated.cleanupPending = true;
      await storage.put("run", updated);
      return updated;
    });
  }
  async prepareEffect(key: string, operation: string, inputDigest: string): Promise<{ effect: DurableEffectRecord; created: boolean }> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(key)) throw new Error("workflow_effect_key_invalid");
    return this.storage.transaction(async (storage) => {
      const existing = await storage.get<DurableEffectRecord>("effect:" + key);
      if (existing) {
        if (existing.operation !== operation || existing.inputDigest !== inputDigest) throw new Error("workflow_effect_key_conflict");
        return { effect: existing, created: false };
      }
      const record: DurableEffectRecord = { key, operation, inputDigest, status: "prepared" };
      await storage.put("effect:" + key, record);
      return { effect: record, created: true };
    });
  }
  async commitEffect(effect: DurableEffectRecord, result: WorkflowCheckpointPointer): Promise<void> {
    await this.storage.put("effect:" + effect.key, { ...effect, status: "committed", result });
  }
  async markIndeterminate(effect: DurableEffectRecord): Promise<void> { await this.storage.put("effect:" + effect.key, { ...effect, status: "indeterminate" }); }
  async retry(maxAttempts: number): Promise<WorkflowJournalRecord> {
    return this.storage.transaction(async (storage) => {
      const record = await storage.get<WorkflowJournalRecord>("run");
      if (!record || record.status !== "failed" || record.attempt >= maxAttempts || record.identity.expiresAt <= Date.now()) throw new Error("workflow_retry_not_allowed");
      // External-effect records deliberately survive an explicit provider restart.
      const { error: _error, result: _result, ...retained } = record;
      const updated = { ...retained, status: "queued" as const, attempt: record.attempt + 1, launched: false, cleanupPending: false, updatedAt: Date.now() };
      await storage.put("run", updated);
      return updated;
    });
  }
}
