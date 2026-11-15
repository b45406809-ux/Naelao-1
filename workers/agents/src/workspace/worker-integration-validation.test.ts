import { describe, expect, it, vi } from "vitest";
import {
  parseWorkerValidationConfig,
  runCheckedWorkerIntegration,
  WORKER_VALIDATION_CONFIG_PATH,
  type WorkerIntegrationHead,
  type WorkerIntegrationHost,
} from "./worker-integration-validation.js";

const hash = (character: string) => character.repeat(64);
const commit = (character: string) => character.repeat(40);

function fixture(run: "pass" | "api-schema-fail" | "stale-target" | "target-advanced" | "validator-changed" | "validation-mutated" = "pass", config: string | null = '{"schema_version":1,"command":"pnpm test"}') {
  const target: WorkerIntegrationHead = run === "target-advanced"
    ? { branch: "main", commitId: commit("c"), revision: 3, manifestHash: hash("c") }
    : { branch: "main", commitId: commit("a"), revision: 2, manifestHash: hash("a") };
  const sourceBase = run === "target-advanced"
    ? { parentBranch: "main", revision: 2, manifestHash: hash("a") }
    : { parentBranch: "main", revision: target.revision, manifestHash: target.manifestHash };
  const source: WorkerIntegrationHead = { branch: "workers/api-change", commitId: commit("b"), revision: 3, manifestHash: hash("b"), branchBase: sourceBase };
  const candidateBase: WorkerIntegrationHead = { branch: "race/worker-candidate/op", commitId: target.commitId, revision: target.revision, manifestHash: target.manifestHash,
    branchBase: { parentBranch: "main", revision: target.revision, manifestHash: target.manifestHash } };
  const candidate: WorkerIntegrationHead = { ...candidateBase,
    commitId: run === "target-advanced" ? commit("d") : commit("b"),
    revision: target.revision + 1,
    manifestHash: run === "target-advanced" ? hash("d") : hash("b") };
  const validation: WorkerIntegrationHead = { branch: "race/worker-validation/op", commitId: candidate.commitId, revision: candidate.revision, manifestHash: candidate.manifestHash,
    branchBase: { parentBranch: candidate.branch, revision: candidate.revision, manifestHash: candidate.manifestHash } };
  const heads = new Map<string, WorkerIntegrationHead>([[target.branch, target], [source.branch, source]]);
  const publishCandidate = vi.fn(async () => {
    heads.set(target.branch, { ...candidate, branch: target.branch, revision: target.revision + 1 });
  });
  const saveReceipt = vi.fn(async () => {});
  const mergeCandidate = vi.fn(async () => {
    heads.set(candidate.branch, candidate);
    return {};
  });
  const host: WorkerIntegrationHost = {
    readHead: async branch => heads.get(branch) ?? null,
    readProjectValidationConfig: async branch => run === "validator-changed" && branch === candidate.branch
      ? '{"schema_version":1,"command":"pnpm run test:alternate"}' : config,
    createBranch: async (branch, sourceBranch) => {
      if (branch === candidate.branch) heads.set(branch, candidateBase);
      if (branch === validation.branch) heads.set(branch, validation);
      if (sourceBranch !== "main" && sourceBranch !== candidate.branch) throw new Error("unexpected branch source");
    },
    mergeCandidate,
    runValidation: async () => {
      if (run === "stale-target") heads.set(target.branch, { ...target, revision: 3, manifestHash: hash("c") });
      if (run === "validation-mutated") heads.set(validation.branch, { ...validation, commitId: commit("e"), manifestHash: hash("e"), revision: validation.revision + 1 });
      return run === "pass" || run === "stale-target" || run === "target-advanced"
        ? { status: "passed", exitCode: 0, durationMs: 12 }
        : { status: "failed", exitCode: 1, durationMs: 12, reason: "api_schema_incompatibility" };
    },
    publishCandidate,
    saveReceipt,
  };
  return { host, publishCandidate, saveReceipt, mergeCandidate, target, source, sourceBase };
}

const input = {
  targetBranch: "main",
  sourceBranch: "workers/api-change",
  candidateBranch: "race/worker-candidate/op",
  validationBranch: "race/worker-validation/op",
  executionId: "worker-validation-exec-1",
  runId: "worker-validation-run-1",
};
const pinnedInput = (f: ReturnType<typeof fixture>) => ({ ...input, pinnedTarget: f.target, pinnedSource: f.source, expectedSourceBase: f.sourceBase });

describe("checked worker integration", () => {
  it("parses only the bounded, versioned project-owned check contract", () => {
    expect(parseWorkerValidationConfig('{"schema_version":1,"command":"pnpm test"}')).toEqual({ command: "pnpm test" });
    expect(parseWorkerValidationConfig('{"schema_version":1,"command":"pnpm test","target":"main"}')).toBeNull();
    expect(parseWorkerValidationConfig('{"schema_version":2,"command":"pnpm test"}')).toBeNull();
    expect(parseWorkerValidationConfig('{"schema_version":1,"command":"bash -c rm"}')).toBeNull();
    expect(parseWorkerValidationConfig(" ".repeat(4097))).toBeNull();
    expect(WORKER_VALIDATION_CONFIG_PATH).toBe("naelao-worker-validation.json");
  });

  it("does not publish when an API/schema incompatibility fixture fails the integrated project check", async () => {
    const f = fixture("api-schema-fail");
    const result = await runCheckedWorkerIntegration(pinnedInput(f), f.host);
    expect(result.status).toBe("blocked");
    expect(result.receipt).toMatchObject({ status: "failed", exitCode: 1, reason: "api_schema_incompatibility", publicationStatus: "not_published" });
    expect(f.publishCandidate).not.toHaveBeenCalled();
    expect(f.saveReceipt).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", path: WORKER_VALIDATION_CONFIG_PATH }));
  });

  it("publishes only after the exact validation branch passes", async () => {
    const f = fixture();
    const result = await runCheckedWorkerIntegration(pinnedInput(f), f.host);
    expect(result.status).toBe("published");
    expect(result.receipt).toMatchObject({ status: "passed", publicationStatus: "published", branch: input.validationBranch });
    expect(f.publishCandidate).toHaveBeenCalledWith(expect.objectContaining({
      targetBranch: "main", candidateBranch: input.candidateBranch,
      expectedTarget: expect.objectContaining({ commitId: commit("a"), revision: 2, manifestHash: hash("a") }),
      expectedSourceCommitId: commit("b"),
    }));
  });

  it("integrates a worker from its recorded older base with independently advanced target content", async () => {
    const f = fixture("target-advanced");
    const result = await runCheckedWorkerIntegration(pinnedInput(f), f.host);
    expect(result.status).toBe("published");
    expect(result.receipt).toMatchObject({ status: "passed", candidateCommitId: commit("d"), targetCommitId: commit("c"), publicationStatus: "published" });
    expect(f.publishCandidate).toHaveBeenCalledWith(expect.objectContaining({ expectedSourceCommitId: commit("d") }));
  });

  it("blocks a worker whose immutable fork base differs from the recorded task base", async () => {
    const f = fixture();
    const result = await runCheckedWorkerIntegration({ ...pinnedInput(f), expectedSourceBase: { ...f.sourceBase, manifestHash: hash("c") } }, f.host);
    expect(result.status).toBe("blocked");
    expect(result.receipt.reason).toBe("worker_source_base_mismatch");
    expect(f.mergeCandidate).not.toHaveBeenCalled();
    expect(f.publishCandidate).not.toHaveBeenCalled();
  });

  it("requires the published candidate to retain the target-owned validation command", async () => {
    const f = fixture("validator-changed");
    const result = await runCheckedWorkerIntegration(pinnedInput(f), f.host);
    expect(result.status).toBe("blocked");
    expect(result.receipt.reason).toBe("validation_contract_changed_requires_review");
    expect(f.publishCandidate).not.toHaveBeenCalled();
  });

  it("rejects validation runs that changed their isolated workspace branch", async () => {
    const f = fixture("validation-mutated");
    const result = await runCheckedWorkerIntegration(pinnedInput(f), f.host);
    expect(result.status).toBe("blocked");
    expect(result.receipt.reason).toBe("integration_head_changed_or_validation_modified_workspace");
    expect(f.publishCandidate).not.toHaveBeenCalled();
  });

  it("leaves a concurrently changed target untouched by candidate publication", async () => {
    const f = fixture("stale-target");
    const result = await runCheckedWorkerIntegration(pinnedInput(f), f.host);
    expect(result.status).toBe("blocked");
    expect(result.receipt.reason).toBe("integration_head_changed_or_validation_modified_workspace");
    expect(f.publishCandidate).not.toHaveBeenCalled();
  });

  it("retains worker output and refuses to create a candidate without a valid project check", async () => {
    const f = fixture("pass", null);
    const result = await runCheckedWorkerIntegration(pinnedInput(f), f.host);
    expect(result.status).toBe("blocked");
    expect(result.receipt.reason).toBe("project_validation_not_configured");
    expect(result.conflicts).toEqual([{ path: WORKER_VALIDATION_CONFIG_PATH, reason: "project_validation_not_configured" }]);
    expect(f.publishCandidate).not.toHaveBeenCalled();
  });
});
