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
  artifactKeys: string[];
  artifactBytes: number;
  effectCount: number;
  activeEffects: string[];
  usageUncertain: boolean;
  launched: boolean;
  cleanupPending: boolean;
}

export const MAX_WORKFLOW_ARTIFACTS = 256;
export const MAX_WORKFLOW_ARTIFACT_BYTES = 64 * 1024 * 1024;
export const MAX_WORKFLOW_EFFECTS = 1024;

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
      const record: WorkflowJournalRecord = { identity, input, inputDigest: input.sha256, ...budget, usedCredits: 0, artifactKeys: [input.r2_key], artifactBytes: input.bytes, effectCount: 0, activeEffects: [], usageUncertain: false, status: "queued", attempt: 1, updatedAt: Date.now(), launched: false, cleanupPending: false };
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
  async reserveArtifact(pointer: WorkflowCheckpointPointer): Promise<void> {
    if (!pointer || typeof pointer.r2_key !== "string" || !Number.isSafeInteger(pointer.bytes) || pointer.bytes < 0) throw new Error("workflow_artifact_pointer_invalid");
    await this.storage.transaction(async (storage) => {
      const run = await storage.get<WorkflowJournalRecord>("run");
      if (!run) throw new Error("workflow_not_found");
      if (isTerminalWorkflow(run.status) || run.cleanupPending) throw new Error("workflow_already_terminal");
      const keys = run.artifactKeys ?? [run.input.r2_key];
      if (keys.includes(pointer.r2_key)) return;
      const bytes = (run.artifactBytes ?? run.input.bytes) + pointer.bytes;
      if (keys.length >= MAX_WORKFLOW_ARTIFACTS || !Number.isSafeInteger(bytes) || bytes > MAX_WORKFLOW_ARTIFACT_BYTES) throw new Error("workflow_artifact_budget_exceeded");
      await storage.put("run", { ...run, artifactKeys: [...keys, pointer.r2_key], artifactBytes: bytes, updatedAt: Date.now() });
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
      const run = await storage.get<WorkflowJournalRecord>("run");
      if (!run) throw new Error("workflow_not_found");
      const existing = await storage.get<DurableEffectRecord>("effect:" + key);
      if (existing) {
        if (existing.operation !== operation || existing.inputDigest !== inputDigest) throw new Error("workflow_effect_key_conflict");
        return { effect: existing, created: false };
      }
      if ((run.effectCount ?? 0) >= MAX_WORKFLOW_EFFECTS) throw new Error("workflow_effect_budget_exceeded");
      const record: DurableEffectRecord = { key, operation, inputDigest, status: "prepared" };
      await storage.put("effect:" + key, record);
      await storage.put("run", { ...run, effectCount: (run.effectCount ?? 0) + 1, updatedAt: Date.now() });
      return { effect: record, created: true };
    });
  }
  async prepareExternalEffect(key: string, operation: string, inputDigest: string): Promise<{ effect: DurableEffectRecord; created: boolean }> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(key)) throw new Error("workflow_effect_key_invalid");
    return this.storage.transaction(async (storage) => {
      const run = await storage.get<WorkflowJournalRecord>("run");
      if (!run) throw new Error("workflow_not_found");
      if (isTerminalWorkflow(run.status) || run.cleanupPending) throw new Error("workflow_already_terminal");
      const existing = await storage.get<DurableEffectRecord & { startedAt?: number }>("effect:" + key);
      if (existing) {
        if (existing.operation !== operation || existing.inputDigest !== inputDigest) throw new Error("workflow_effect_key_conflict");
        return { effect: existing, created: false };
      }
      if ((run.effectCount ?? 0) >= MAX_WORKFLOW_EFFECTS) throw new Error("workflow_effect_budget_exceeded");
      const activeEffects = run.activeEffects ?? [];
      if (activeEffects.length >= 128) throw new Error("workflow_effect_concurrency_limit");
      const effect = { key, operation, inputDigest, status: "prepared" as const, startedAt: Date.now() };
      await storage.put("effect:" + key, effect);
      await storage.put("run", { ...run, effectCount: (run.effectCount ?? 0) + 1, activeEffects: [...activeEffects, key], updatedAt: Date.now() });
      return { effect, created: true };
    });
  }
  async commitEffect(effect: DurableEffectRecord, result: WorkflowCheckpointPointer, credits: number): Promise<void> {
    if (!Number.isFinite(credits) || credits < 0) throw new Error("workflow_usage_invalid");
    await this.storage.transaction(async (storage) => {
      const run = await storage.get<WorkflowJournalRecord>("run");
      if (!run) throw new Error("workflow_not_found");
      const current = await storage.get<DurableEffectRecord & { usageCredits?: number; startedAt?: number }>("effect:" + effect.key);
      if (!current || current.operation !== effect.operation || current.inputDigest !== effect.inputDigest) throw new Error("workflow_effect_receipt_conflict");
      if (current.status === "committed") {
        if (current.usageCredits !== credits || JSON.stringify(current.result) !== JSON.stringify(result)) throw new Error("workflow_effect_receipt_conflict");
        return;
      }
      if (current.status !== "prepared") throw new Error("workflow_effect_receipt_conflict");
      const activeEffects = (run.activeEffects ?? []).filter((key) => key !== effect.key);
      if (activeEffects.length === (run.activeEffects ?? []).length) throw new Error("workflow_effect_receipt_conflict");
      const usedCredits = run.usedCredits + credits;
      if (!Number.isFinite(usedCredits)) throw new Error("workflow_usage_overflow");
      await storage.put("effect:" + effect.key, { ...effect, status: "committed", result, usageCredits: credits });
      await storage.put("run", { ...run, activeEffects, usedCredits, updatedAt: Date.now() });
    });
  }
  async markIndeterminate(effect: DurableEffectRecord): Promise<void> {
    await this.storage.transaction(async (storage) => {
      const current = await storage.get<DurableEffectRecord>("effect:" + effect.key);
      const run = await storage.get<WorkflowJournalRecord>("run");
      if (!current || !run || current.status !== "prepared") return;
      await storage.put("effect:" + effect.key, { ...current, status: "indeterminate" });
      await storage.put("run", { ...run, activeEffects: (run.activeEffects ?? []).filter((key) => key !== effect.key), usageUncertain: true, updatedAt: Date.now() });
    });
  }
  async expireStaleEffects(before: number): Promise<void> {
    await this.storage.transaction(async (storage) => {
      const run = await storage.get<WorkflowJournalRecord>("run");
      if (!run) throw new Error("workflow_not_found");
      const remaining: string[] = [];
      let usageUncertain = run.usageUncertain ?? false;
      for (const key of run.activeEffects ?? []) {
        const effect = await storage.get<DurableEffectRecord & { startedAt?: number }>("effect:" + key);
        if (effect?.status === "prepared" && typeof effect.startedAt === "number" && effect.startedAt <= before) {
          await storage.put("effect:" + key, { ...effect, status: "indeterminate" });
          usageUncertain = true;
        } else if (effect?.status === "prepared") remaining.push(key);
      }
      await storage.put("run", { ...run, activeEffects: remaining, usageUncertain, updatedAt: Date.now() });
    });
  }
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
