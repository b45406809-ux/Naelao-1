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
});
