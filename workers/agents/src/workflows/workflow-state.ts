import { isTerminalWorkflow, transitionWorkflow, type DurableWorkflowIdentity, type DurableWorkflowRecord, type DurableEffectRecord,
  type DurableResourceOperationReceipt, type WorkflowCheckpointPointer } from "@naelao/agent-sdk";
import { calculateResourceCredits } from "@naelao/billing-core";

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
  installationBudgetCredits?: number;
  installationBudgetRevision?: number;
  usedCredits: number;
  artifactKeys: string[];
  artifactBytes: number;
  effectCount: number;
  activeEffects: string[];
  usageUncertain: boolean;
  uncertainEffects?: string[];
  launched: boolean;
  cleanupPending: boolean;
}

export const MAX_WORKFLOW_ARTIFACTS = 256;
export const MAX_WORKFLOW_ARTIFACT_BYTES = 64 * 1024 * 1024;
export const MAX_WORKFLOW_EFFECTS = 1024;
const EXTENSION_EFFECT_CREDITS = calculateResourceCredits("workflow_step", 1);

/** The journal is persisted by WorkflowRunDO. No memory-only replay protection. */
export class WorkflowJournal {
  constructor(private readonly storage: WorkflowJournalStorage) {}
  async read(): Promise<WorkflowJournalRecord> {
    const record = await this.storage.get<WorkflowJournalRecord>("run");
    if (!record) throw new Error("workflow_not_found");
    return record;
  }
  async initialize(identity: DurableWorkflowIdentity, input: WorkflowCheckpointPointer, budget: { budgetKey?: string; budgetCredits?: number;
    installationBudgetCredits?: number; installationBudgetRevision?: number }): Promise<WorkflowJournalRecord> {
    return this.storage.transaction(async (storage) => {
      const existing = await storage.get<WorkflowJournalRecord>("run");
      if (existing) {
        const { expiresAt: oldExpiry, ...oldIdentity } = existing.identity;
        const { expiresAt: newExpiry, ...newIdentity } = identity;
        if (JSON.stringify(oldIdentity) !== JSON.stringify(newIdentity) || existing.inputDigest !== input.sha256) throw new Error("workflow_start_key_conflict");
        return existing;
      }
      const record: WorkflowJournalRecord = { identity, input, inputDigest: input.sha256, ...budget, usedCredits: 0, artifactKeys: [input.r2_key], artifactBytes: input.bytes, effectCount: 0, activeEffects: [], uncertainEffects: [], usageUncertain: false, status: "queued", attempt: 1, updatedAt: Date.now(), launched: false, cleanupPending: false };
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
  async prepareExternalEffect(key: string, operation: string, inputDigest: string, resourceReceipt?: DurableResourceOperationReceipt): Promise<{ effect: DurableEffectRecord; created: boolean }> {
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
      const extensionEffect = run.identity?.workflowClass === "vertical_extension" && resourceReceipt !== undefined;
      let reservedCredits: number | undefined;
      if (extensionEffect) {
        if (!Number.isSafeInteger(run.budgetCredits) || (run.budgetCredits ?? 0) <= 0)
          throw new Error("workflow_extension_budget_required");
        let inFlightCredits = 0;
        for (const activeKey of activeEffects) {
          const active = await storage.get<DurableEffectRecord>("effect:" + activeKey);
          // Old prepared records predate effect-level holds. Treat their possible cost as the
          // entire remaining run budget until the existing uncertain-effect reconciliation runs.
          inFlightCredits += active?.reservedCredits ?? run.budgetCredits!;
        }
        reservedCredits = EXTENSION_EFFECT_CREDITS;
        if (run.usedCredits + inFlightCredits + reservedCredits > run.budgetCredits!)
          throw new Error("workflow_extension_budget_exhausted");
      }
      const effect = { key, operation, inputDigest, status: "prepared" as const, startedAt: Date.now(),
        ...(reservedCredits !== undefined ? { reservedCredits } : {}), ...(resourceReceipt ? { resourceReceipt } : {}) };
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
      if (current.reservedCredits !== undefined && credits > current.reservedCredits)
        throw new Error("workflow_effect_budget_exceeded");
      const activeEffects = (run.activeEffects ?? []).filter((key) => key !== effect.key);
      if (activeEffects.length === (run.activeEffects ?? []).length) throw new Error("workflow_effect_receipt_conflict");
      const usedCredits = run.usedCredits + credits;
      if (!Number.isFinite(usedCredits)) throw new Error("workflow_usage_overflow");
      const resourceReceipt = effect.resourceReceipt ? { ...effect.resourceReceipt, status: "completed" as const,
        responseSha256: result.sha256, responseBytes: result.bytes, meteredCredits: credits, completedAt: Date.now() } : undefined;
      const uncertainEffects = (run.uncertainEffects ?? []).filter((key) => key !== effect.key);
      const preserveLegacyUncertainty = run.usageUncertain === true && run.uncertainEffects === undefined;
      await storage.put("effect:" + effect.key, { ...effect, status: "committed", result, usageCredits: credits,
        ...(resourceReceipt ? { resourceReceipt } : {}) });
      await storage.put("run", { ...run, activeEffects, uncertainEffects,
        usageUncertain: preserveLegacyUncertainty || uncertainEffects.length > 0, usedCredits, updatedAt: Date.now() });
    });
  }
  async markIndeterminate(effect: DurableEffectRecord): Promise<void> {
    await this.storage.transaction(async (storage) => {
      const current = await storage.get<DurableEffectRecord>("effect:" + effect.key);
      const run = await storage.get<WorkflowJournalRecord>("run");
      if (!current || !run || current.status !== "prepared") return;
      await storage.put("effect:" + effect.key, { ...current, status: "indeterminate",
        ...(current.resourceReceipt ? { resourceReceipt: { ...current.resourceReceipt, status: "unknown" as const, uncertainAt: Date.now() } } : {}) });
      const uncertainEffects = [...new Set([...(run.uncertainEffects ?? []), effect.key])];
      await storage.put("run", { ...run, activeEffects: (run.activeEffects ?? []).filter((key) => key !== effect.key),
        uncertainEffects, usageUncertain: true, updatedAt: Date.now() });
    });
  }
  /** Reopen only brokered jobs, whose host ledger deduplicates the exact run/step idempotency key. */
  async reopenIdempotentJobEffect(effect: DurableEffectRecord): Promise<DurableEffectRecord> {
    if (effect.operation !== "extension.resource.jobs" || effect.resourceReceipt?.kind !== "jobs")
      throw new Error("workflow_effect_reconciliation_required:" + effect.key);
    return this.storage.transaction(async (storage) => {
      const current = await storage.get<DurableEffectRecord>("effect:" + effect.key);
      const run = await storage.get<WorkflowJournalRecord>("run");
      if (!current || !run || current.operation !== effect.operation || current.inputDigest !== effect.inputDigest
        || current.resourceReceipt?.kind !== "jobs" || !["prepared", "indeterminate"].includes(current.status)
        || isTerminalWorkflow(run.status) || run.cleanupPending)
        throw new Error("workflow_effect_reconciliation_required:" + effect.key);
      const activeEffects = run.activeEffects ?? [];
      if (!activeEffects.includes(effect.key) && activeEffects.length >= 128) throw new Error("workflow_effect_concurrency_limit");
      const reopened: DurableEffectRecord & { startedAt: number } = { ...current, status: "prepared", startedAt: Date.now(),
        resourceReceipt: { ...current.resourceReceipt, status: "prepared", preparedAt: Date.now() } };
      await storage.put("effect:" + effect.key, reopened);
      if (!activeEffects.includes(effect.key)) await storage.put("run", { ...run, activeEffects: [...activeEffects, effect.key], updatedAt: Date.now() });
      return reopened;
    });
  }
  async expireStaleEffects(before: number): Promise<void> {
    await this.storage.transaction(async (storage) => {
      const run = await storage.get<WorkflowJournalRecord>("run");
      if (!run) throw new Error("workflow_not_found");
      const remaining: string[] = [];
      const uncertainEffects = [...(run.uncertainEffects ?? [])];
      for (const key of run.activeEffects ?? []) {
        const effect = await storage.get<DurableEffectRecord & { startedAt?: number }>("effect:" + key);
        if (effect?.status === "prepared" && typeof effect.startedAt === "number" && effect.startedAt <= before) {
          await storage.put("effect:" + key, { ...effect, status: "indeterminate",
            ...(effect.resourceReceipt ? { resourceReceipt: { ...effect.resourceReceipt, status: "unknown" as const, uncertainAt: Date.now() } } : {}) });
          if (!uncertainEffects.includes(key)) uncertainEffects.push(key);
        } else if (effect?.status === "prepared") remaining.push(key);
      }
      const preserveLegacyUncertainty = run.usageUncertain === true && run.uncertainEffects === undefined;
      await storage.put("run", { ...run, activeEffects: remaining, uncertainEffects,
        usageUncertain: preserveLegacyUncertainty || uncertainEffects.length > 0, updatedAt: Date.now() });
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
