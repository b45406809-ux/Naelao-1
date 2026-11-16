import type { WorkflowJournalRecord } from "./workflow-state.js";

export interface AgentTaskRecoveryScope {
  tenantId: string;
  spaceId: string;
  taskId: string;
  projectId?: string | null;
}

/** Content-free recovery projection for an already-authorized task caller. Never return R2 keys. */
export function agentTaskRecoverySummary(record: WorkflowJournalRecord | null, scope: AgentTaskRecoveryScope) {
  if (!record) return { state: "no_durable_checkpoint" as const,
    limitations: ["unsaved_process_memory_is_not_recoverable", "runtime_isolation_is_not_proven"] as const };
  const identity = record.identity;
  if (identity.tenantId !== scope.tenantId || identity.spaceId !== scope.spaceId || identity.runId !== scope.taskId
    || (identity.projectId ?? null) !== (scope.projectId ?? null)) {
    return { state: "scope_mismatch" as const,
      limitations: ["unsaved_process_memory_is_not_recoverable", "runtime_isolation_is_not_proven"] as const };
  }
  const checkpoint = [...(record.checkpoints ?? [])].sort((a, b) => b.sequence - a.sequence)[0];
  if (!checkpoint) return { state: "no_durable_checkpoint" as const, workflow_status: record.status,
    limitations: ["unsaved_process_memory_is_not_recoverable", "runtime_isolation_is_not_proven"] as const };
  return {
    state: "checkpoint_available" as const,
    workflow_status: record.status,
    checkpoint: {
      sequence: checkpoint.sequence,
      step_name: checkpoint.stepName,
      recorded_at: checkpoint.recordedAt,
      artifact_sha256_prefix: checkpoint.pointer.sha256.slice(0, 12),
      artifact_bytes: checkpoint.pointer.bytes,
      stale: checkpoint.recordedAt < record.updatedAt,
    },
    limitations: ["unsaved_process_memory_is_not_recoverable", "runtime_isolation_is_not_proven"] as const,
  };
}
