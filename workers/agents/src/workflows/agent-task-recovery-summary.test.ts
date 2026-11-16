import { describe, expect, it } from "vitest";
import { agentTaskRecoverySummary } from "./agent-task-recovery-summary.js";
import type { WorkflowJournalRecord } from "./workflow-state.js";

const record = {
  identity: { tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a", runId: "task-a" },
  status: "running", updatedAt: 200, checkpoints: [{ sequence: 2, stepName: "fetch-source", recordedAt: 100,
    pointer: { r2_key: "private/object-key", sha256: "a".repeat(64), bytes: 42 } }],
} as unknown as WorkflowJournalRecord;

describe("AgentTask recovery summary", () => {
  it("returns only a scope-matched, content-free durable checkpoint receipt", () => {
    expect(agentTaskRecoverySummary(record, { tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a", taskId: "task-a" }))
      .toEqual({ state: "checkpoint_available", workflow_status: "running", checkpoint: {
        sequence: 2, step_name: "fetch-source", recorded_at: 100, artifact_sha256_prefix: "aaaaaaaaaaaa", artifact_bytes: 42, stale: true,
      }, limitations: ["unsaved_process_memory_is_not_recoverable", "runtime_isolation_is_not_proven"] });
  });
  it("denies a journal from another scope and identifies a missing checkpoint", () => {
    expect(agentTaskRecoverySummary(record, { tenantId: "tenant-b", spaceId: "space-a", projectId: "project-a", taskId: "task-a" }).state).toBe("scope_mismatch");
    expect(agentTaskRecoverySummary({ ...record, checkpoints: [] }, { tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a", taskId: "task-a" }).state)
      .toBe("no_durable_checkpoint");
    expect(agentTaskRecoverySummary(null, { tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a", taskId: "task-a" }).state)
      .toBe("no_durable_checkpoint");
  });
});
