import { describe, expect, it } from "vitest";
import {
  formatWorkerOutput,
  parseWorkerMergeResult,
} from "./worker-merge-result";

describe("worker merge result presentation", () => {
  it("parses bounded conflict reports and validates their hashes and paths", () => {
    const hash = "A".repeat(64);
    const serialized = JSON.stringify({
      workerOutput: { summary: "worker result" },
      modifiedFiles: ["src/file-0.ts", "../private.txt", "/absolute/path", "src/file-0.ts"],
      workspaceMerge: {
        status: "unapplied",
        omitted: 0,
        conflicts: Array.from({ length: 52 }, (_, index) => ({
          path: `src/file-${index}.ts`,
          ...(index === 0 ? { otherPath: "SRC/file-0.ts" } : {}),
          reason: index === 0 ? "case_collision" : "overlapping_change",
          baseHash: hash,
          targetHash: "not-a-hash",
          sourceHash: hash,
        })),
      },
    });
    const report = parseWorkerMergeResult(serialized);
    expect(report?.workerOutput).toEqual({ summary: "worker result" });
    expect(report?.modifiedFiles).toEqual(["src/file-0.ts"]);
    expect(report?.workspaceMerge).toMatchObject({
      status: "unapplied",
      omitted: 2,
    });
    expect(report?.workspaceMerge.conflicts).toHaveLength(50);
    expect(report?.workspaceMerge.conflicts[0]).toMatchObject({
      path: "src/file-0.ts",
      otherPath: "SRC/file-0.ts",
      reason: "case_collision",
      baseHash: hash.toLowerCase(),
      targetHash: null,
      sourceHash: hash.toLowerCase(),
    });
  });

  it("ignores malformed envelopes and formats non-text worker output safely", () => {
    expect(parseWorkerMergeResult("not json")).toBeNull();
    expect(
      parseWorkerMergeResult(
        JSON.stringify({
          workspaceMerge: { status: "published", conflicts: [] },
        })
      )
    ).toBeNull();
    expect(parseWorkerMergeResult("{".repeat(128 * 1024 + 1))).toBeNull();
    expect(formatWorkerOutput({ summary: "done" })).toContain(
      '"summary": "done"'
    );
    expect(formatWorkerOutput("plain result")).toBe("plain result");
    expect(formatWorkerOutput(null)).toBe("");
  });

  it("preserves bounded manual-resolution receipts for resolved worker conflicts", () => {
    const report = parseWorkerMergeResult(
      JSON.stringify({
        workerOutput: "original output",
        modifiedFiles: ["src/app.ts", "src/../secret.ts"],
        workspaceMerge: {
          status: "partially_resolved",
          conflicts: [
            {
              path: "src/app.ts",
              reason: "overlapping_change",
              targetHash: "b".repeat(64),
            },
          ],
          manualResolutions: [
            {
              path: "src/app.ts",
              status: "published",
              revision: 12,
              reviewBranch: "manual/abc123",
              completedAt: "2026-11-15T00:00:00.000Z",
            },
          ],
        },
      })
    );
    expect(report?.workspaceMerge).toMatchObject({
      status: "partially_resolved",
      manualResolutions: [
        {
          path: "src/app.ts",
          status: "published",
          revision: 12,
          reviewBranch: "manual/abc123",
        },
      ],
    });
    expect(report?.workerOutput).toBe("original output");
    expect(report?.modifiedFiles).toEqual(["src/app.ts"]);
  });
});
