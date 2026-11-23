import { describe, expect, it } from "vitest";
import { encodeWorkerCheckpoint } from "./worker-checkpoint.js";
import { projectGoalWorkspaceLineage } from "./goal-workspace-lineage.js";

const workerBranch = "workers/goal-worker-1";
const parentBranch = "task/parent-run";
const hash = "a".repeat(64);
const commit = "b".repeat(40);

describe("goal workspace lineage projection", () => {
  it("returns bounded branch, base, recorded checkpoint and checked integration metadata", () => {
    const projected = projectGoalWorkspaceLineage({
      branch: workerBranch,
      attempt: 2,
      branchOrigin: { branch: workerBranch, parentBranch, revision: 7, manifestHash: hash },
      checkpointJson: encodeWorkerCheckpoint({ private: "worker output must not be projected" }, {
        attempt: 2,
        savedAt: 1_800_000_000_000,
        workspacePin: { branch: workerBranch, revision: 11, manifestHash: "c".repeat(64) },
      }),
      validationReceipts: [{
        status: "passed", branch: "race/validation-1", revision: 3, manifestHash: "d".repeat(64),
        targetRevision: 8, targetManifestHash: "e".repeat(64), commandHash: "f".repeat(64),
        executionId: "internal-execution-id", runId: "internal-run-id", durationMs: 1200,
        completedAt: "2026-11-23T00:00:00.000Z", candidateBranch: "race/candidate-1", candidateCommitId: commit,
        sourceBranch: workerBranch, sourceCommitId: commit, targetBranch: "main", targetCommitId: commit,
        publicationStatus: "published", reason: "internal detail must not be projected",
      }],
      publicationAttempts: [{ attempt: 2, targetBranch: "main", targetRevision: 8, status: "outcome_unknown", updatedAt: "2026-11-23T00:00:00.000Z" }],
    });

    expect(projected).toEqual({
      branch: workerBranch,
      attempt: 2,
      base: { parentBranch, revision: 7, manifestHash: hash },
      lastCheckpoint: { attempt: 2, savedAt: 1_800_000_000_000, revision: 11, manifestHash: "c".repeat(64), freshness: "recorded_not_rechecked" },
      validationReceipts: [{
        status: "passed", branch: "race/validation-1", revision: 3, manifestHash: "d".repeat(64),
        targetRevision: 8, targetManifestHash: "e".repeat(64), commandHash: "f".repeat(64), durationMs: 1200,
        completedAt: "2026-11-23T00:00:00.000Z", candidateBranch: "race/candidate-1", candidateCommitId: commit,
        sourceBranch: workerBranch, sourceCommitId: commit, targetBranch: "main", targetCommitId: commit,
        publicationStatus: "published",
      }],
      publicationAttempts: [{ attempt: 2, targetBranch: "main", targetRevision: 8, status: "outcome_unknown", updatedAt: "2026-11-23T00:00:00.000Z" }],
    });
    expect(JSON.stringify(projected)).not.toContain("private worker output");
    expect(JSON.stringify(projected)).not.toContain("internal detail");
    expect(JSON.stringify(projected)).not.toContain("internal-execution-id");
  });

  it("omits invalid base, checkpoint and receipt metadata and rejects non-worker branches", () => {
    const projected = projectGoalWorkspaceLineage({
      branch: workerBranch,
      attempt: 1,
      branchOrigin: { branch: "workers/other", parentBranch, revision: 0, manifestHash: "bad" },
      checkpointJson: JSON.stringify({ format: "naelao.worker-checkpoint", schema_version: 2 }),
      validationReceipts: [{ status: "passed", branch: "../../private", revision: 1 }],
      publicationAttempts: [{ attempt: 1, targetBranch: "../private", targetRevision: 1, status: "published", updatedAt: "bad" }],
    });
    expect(projected).toEqual({ branch: workerBranch, attempt: 1, validationReceipts: [], publicationAttempts: [] });
    expect(projectGoalWorkspaceLineage({ branch: "private/branch", attempt: 1, branchOrigin: null,
      checkpointJson: null, validationReceipts: [], publicationAttempts: [] })).toBeUndefined();
  });
});
