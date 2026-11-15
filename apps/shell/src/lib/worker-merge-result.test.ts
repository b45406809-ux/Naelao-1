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
              otherPath: "src/legacy-app.ts",
              reason: "case_collision",
              targetHash: "b".repeat(64),
            },
          ],
          manualResolutions: [
            {
              path: "src/app.ts",
              paths: ["src/app.ts", "src/legacy-app.ts"],
              deletedPaths: ["src/legacy-app.ts"],
              copiedVersions: [{ path: "src/app.ts", from: "worker", hash: "f".repeat(64) }],
              status: "published",
              revision: 12,
              reviewBranch: "manual/abc123",
              completedAt: "2026-11-15T00:00:00.000Z",
              validation: { path: "src/app.ts", paths: ["src/app.ts", "src/legacy-app.ts"], status: "passed", branch: "race/manual-validation/abc123", revision: 12,
                manifestHash: "c".repeat(64), targetRevision: 9, targetManifestHash: "e".repeat(64),
                commandHash: "d".repeat(64), durationMs: 231, completedAt: "2026-11-15T00:00:00.000Z" },
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
          paths: ["src/app.ts", "src/legacy-app.ts"],
          deletedPaths: ["src/legacy-app.ts"],
          copiedVersions: [{ path: "src/app.ts", from: "worker", hash: "f".repeat(64) }],
          status: "published",
          revision: 12,
          reviewBranch: "manual/abc123",
          validation: { status: "passed", paths: ["src/app.ts", "src/legacy-app.ts"], revision: 12, targetRevision: 9, targetManifestHash: "e".repeat(64) },
        },
      ],
    });
    expect(report?.workerOutput).toBe("original output");
    expect(report?.modifiedFiles).toEqual(["src/app.ts"]);
  });

  it("shows a passed candidate check for an integrated worker result without conflicts", () => {
    const report = parseWorkerMergeResult(JSON.stringify({
      workerOutput: "integrated output",
      workspaceMerge: {
        status: "integrated",
        conflicts: [],
        validationReceipts: [{ path: "naelao-worker-validation.json", paths: ["naelao-worker-validation.json"],
          status: "passed", branch: "race/worker-validation/abc", revision: 8, manifestHash: "a".repeat(64),
          targetRevision: 4, targetManifestHash: "b".repeat(64), commandHash: "c".repeat(64),
          executionId: "worker-integration-exec-1", runId: "worker-integration-run-1", durationMs: 120,
          completedAt: "2026-11-15T00:00:00.000Z", publicationStatus: "published" }],
      },
    }));
    expect(report?.workspaceMerge).toMatchObject({ status: "integrated", conflicts: [], validationReceipts: [{
      status: "passed", branch: "race/worker-validation/abc", revision: 8, targetRevision: 4, publicationStatus: "published",
    }] });
  });
});
