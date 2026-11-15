import { describe, expect, it } from "vitest";
import { withWorkerMergeConflicts } from "./worker-merge-report.js";

describe("worker merge conflict report", () => {
  it("preserves the original worker result and exposes bounded structured conflicts", () => {
    const hash = "a".repeat(64);
    const report = withWorkerMergeConflicts(
      { summary: "work completed" },
      Array.from({ length: 52 }, (_, index) => ({
        path: `src/file-${index}.ts`,
        ...(index === 0 ? { otherPath: "SRC/file-0.ts" } : {}),
        reason: index === 0 ? "case_collision" : "overlapping_change",
        baseHash: hash,
        targetHash: "invalid",
        sourceHash: hash.toUpperCase(),
      }))
    );

    expect(report.workerOutput).toEqual({ summary: "work completed" });
    expect(report.workspaceMerge).toMatchObject({
      status: "unapplied",
      omitted: 2,
    });
    expect(report.workspaceMerge.conflicts[0]).toMatchObject({
      path: "src/file-0.ts",
      otherPath: "SRC/file-0.ts",
      reason: "case_collision",
      baseHash: hash,
      targetHash: null,
      sourceHash: hash,
    });
    expect(report.guidance).toContain("checked workspace coordinator");
    expect(report.workspaceMerge.conflicts).toHaveLength(50);
  });

  it("keeps a content-free check receipt on a successful integrated result with no conflicts", () => {
    const receipt = { path: "naelao-worker-validation.json", paths: ["naelao-worker-validation.json"], status: "passed" as const,
      branch: "race/worker-validation/abc", revision: 8, manifestHash: "a".repeat(64), targetRevision: 4,
      targetManifestHash: "b".repeat(64), commandHash: "c".repeat(64), executionId: "worker-integration-exec-1",
      runId: "worker-integration-run-1", durationMs: 120, completedAt: "2026-11-15T00:00:00.000Z",
      publicationStatus: "published" as const };
    const report = withWorkerMergeConflicts({ summary: "completed" }, [], { validationReceipts: [receipt], published: true });
    expect(report.workspaceMerge).toMatchObject({ status: "integrated", conflicts: [], validationReceipts: [receipt] });
    expect(report.guidance).toContain("project-owned check passed");
  });
});
