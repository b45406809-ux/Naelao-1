import { writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  type ArtifactReadPort,
  type WorkerArtifactManifest,
  captureWorkerArtifactManifest,
  collectGoalEvidence,
  evaluateGoalEvidence,
  validateGoalEvidenceChecks,
  verifyWorkerArtifact,
} from "./goal-evidence.js";

type Stored = { bytes: Uint8Array; etag: string; deleted?: boolean };
const encoder = new TextEncoder();

function scoped(path: string) {
  return {
    tenantId: "tenant-matrix",
    spaceId: "space-matrix",
    projectId: "project-matrix",
    parentRunId: "run-matrix",
    workerId: "worker-matrix",
    attempt: 3,
    branch: "task/matrix-branch",
    paths: [path],
  };
}

function portFor(
  objects: Map<string, Stored>,
  counts = { head: 0, read: 0 }
): ArtifactReadPort {
  return {
    head: async (path) => {
      counts.head++;
      const value = objects.get(path);
      return value
        ? { size: value.bytes.length, etag: value.etag, deleted: value.deleted }
        : null;
    },
    read: async (path, maximumBytes) => {
      counts.read++;
      const value = objects.get(path);
      return value && value.bytes.length <= maximumBytes
        ? { bytes: value.bytes.slice(), etag: value.etag }
        : null;
    },
  };
}

describe("generated host evidence matrix", () => {
  it("evaluates 100 valid artifacts and rejects 300 scoped, mutated, or path-confusion negatives", async () => {
    const startedAt = performance.now();
    const metrics = {
      seed: "evidence-matrix-v1-fixed",
      evidenceClass: "unit-deterministic-host-verifier",
      validCases: 0,
      negativeScopeCases: 0,
      negativeMutationCases: 0,
      negativePathCases: 0,
      falseAcceptances: 0,
      falseRejections: 0,
      scopeMismatchStorageReads: 0,
      invalidPathHostCalls: 0,
      invalidPathManifestPortCalls: 0,
    };
    const criterion = "The exact worker artifact was captured";

    for (let index = 0; index < 100; index++) {
      const path = `matrix/valid-${index}.txt`;
      const bytes = encoder.encode(`valid artifact ${index}`);
      const objects = new Map<string, Stored>([
        [path, { bytes, etag: `valid-v${index}` }],
      ]);
      const scope = scoped(path);
      const port = portFor(objects);
      const manifest = await captureWorkerArtifactManifest(
        scope,
        port,
        1_800_000_000_000 + index
      );
      const evidence = await collectGoalEvidence(
        [criterion],
        [{ criterion, operation: `workspace.sha256:${path}` }],
        async (operation) => {
          const checkedPath = operation.slice("workspace.sha256:".length);
          return verifyWorkerArtifact(manifest, checkedPath, port, scope);
        }
      );
      const result = evaluateGoalEvidence([criterion], evidence);
      if (result.outcome !== "passed") metrics.falseRejections++;
      else metrics.validCases++;
    }

    const scopePath = "matrix/scope-bound.txt";
    const scopeBytes = encoder.encode("scope-bound artifact");
    const scope = scoped(scopePath);
    const scopeObjects = new Map<string, Stored>([
      [scopePath, { bytes: scopeBytes, etag: "scope-v1" }],
    ]);
    const scopeCounts = { head: 0, read: 0 };
    const scopePort = portFor(scopeObjects, scopeCounts);
    const scopeManifest = await captureWorkerArtifactManifest(scope, scopePort);
    const scopeMutations: Array<
      [keyof typeof scope, (index: number) => unknown]
    > = [
      ["tenantId", (i) => `foreign-tenant-${i}`],
      ["spaceId", (i) => `foreign-space-${i}`],
      ["projectId", (i) => (i % 2 ? null : `foreign-project-${i}`)],
      ["parentRunId", (i) => `foreign-run-${i}`],
      ["workerId", (i) => `foreign-worker-${i}`],
      ["attempt", (i) => scope.attempt + i + 1],
      ["branch", (i) => `task/foreign-branch-${i}`],
    ];
    for (let index = 0; index < 100; index++) {
      const mutation = scopeMutations[index % scopeMutations.length];
      if (!mutation) throw new Error("scope mutation fixture missing");
      const [field, mutate] = mutation;
      const expected = { ...scope, [field]: mutate(index) } as typeof scope;
      const result = await verifyWorkerArtifact(
        scopeManifest,
        scopePath,
        scopePort,
        expected
      );
      if (
        result.outcome !== "uncertain" ||
        result.reference !== "manifest_scope_mismatch"
      )
        metrics.falseAcceptances++;
      else metrics.negativeScopeCases++;
    }
    metrics.scopeMismatchStorageReads = scopeCounts.head + scopeCounts.read - 3;

    for (let index = 0; index < 100; index++) {
      const path = `matrix/mutated-${index}.txt`;
      const initial = encoder.encode(`before ${index}`);
      const objects = new Map<string, Stored>([
        [path, { bytes: initial, etag: `v1-${index}` }],
      ]);
      const itemScope = scoped(path);
      const manifest = await captureWorkerArtifactManifest(
        itemScope,
        portFor(objects)
      );
      const mode = index % 5;
      if (mode === 0)
        objects.set(path, { bytes: initial, etag: `changed-${index}` });
      else if (mode === 1)
        objects.set(path, {
          bytes: encoder.encode(`after ${index}`),
          etag: `v1-${index}`,
        });
      else if (mode === 2) objects.delete(path);
      else if (mode === 3)
        objects.set(path, {
          bytes: encoder.encode(`size changed ${index}`),
          etag: `v1-${index}`,
        });
      else
        objects.set(path, {
          bytes: initial,
          etag: `v1-${index}`,
          deleted: true,
        });
      const result = await verifyWorkerArtifact(
        manifest,
        path,
        portFor(objects),
        itemScope
      );
      if (result.outcome !== "uncertain") metrics.falseAcceptances++;
      else metrics.negativeMutationCases++;
    }

    const attacks = [
      "../../outside-{i}/secret.txt",
      "/etc/passwd-{i}",
      "reports\\..\\secret-{i}",
      "reports//secret-{i}",
      "reports/./secret-{i}",
      "reports/a\u0000b-{i}",
    ];
    const invalidPaths = Array.from({ length: 100 }, (_, index) => {
      const attack = attacks[index % attacks.length];
      if (!attack) throw new Error("path attack fixture missing");
      return attack.replace("{i}", String(index));
    });
    for (const path of invalidPaths) {
      const checks = [{ criterion, operation: `workspace.exists:${path}` }];
      try {
        validateGoalEvidenceChecks([criterion], checks);
        metrics.falseAcceptances++;
      } catch {
        metrics.negativePathCases++;
      }
      await expect(
        collectGoalEvidence([criterion], checks, async () => {
          metrics.invalidPathHostCalls++;
          return { outcome: "passed", reference: "must-not-run" };
        })
      ).rejects.toThrow("invalid_goal_evidence_checks");
    }
    // Invalid paths are rejected before capture can consult storage. This separate spy
    // verifies the path guard, independent of the existence of any matching object.
    const pathProbe = vi.fn(async () => null);
    const pathProbePort: ArtifactReadPort = {
      head: pathProbe,
      read: async () => null,
    };
    for (const path of invalidPaths) {
      await expect(captureWorkerArtifactManifest(scoped(path), pathProbePort)).rejects.toThrow("invalid_worker_artifact_path");
    }
    metrics.invalidPathManifestPortCalls = pathProbe.mock.calls.length;

    const report = {
      ...metrics,
      totalCases:
        metrics.validCases +
        metrics.negativeScopeCases +
        metrics.negativeMutationCases +
        metrics.negativePathCases,
      durationMs: Number((performance.now() - startedAt).toFixed(2)),
    };
    const reportPath = process.env.NAELAO_EVIDENCE_MATRIX_REPORT;
    if (reportPath)
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`goal_evidence_matrix=${JSON.stringify(report)}`);

    expect(report.totalCases).toBe(400);
    expect(metrics.validCases).toBe(100);
    expect(metrics.negativeScopeCases).toBe(100);
    expect(metrics.negativeMutationCases).toBe(100);
    expect(metrics.negativePathCases).toBe(100);
    expect(metrics.falseAcceptances).toBe(0);
    expect(metrics.falseRejections).toBe(0);
    expect(metrics.scopeMismatchStorageReads).toBe(0);
    expect(metrics.invalidPathHostCalls).toBe(0);
    expect(metrics.invalidPathManifestPortCalls).toBe(0);
  });
});
