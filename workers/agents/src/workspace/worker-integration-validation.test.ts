import { describe, expect, it, vi } from "vitest";
import {
  parseWorkerValidationConfig,
  runCheckedWorkerIntegration,
  writeWorkerIntegrationMetric,
  WORKER_VALIDATION_CONFIG_PATH,
  type WorkerIntegrationHead,
  type WorkerIntegrationHost,
} from "./worker-integration-validation.js";

const hash = (character: string) => character.repeat(64);
const commit = (character: string) => character.repeat(40);

function fixture(run: "pass" | "api-schema-fail" | "stale-target" | "target-advanced" | "validator-changed" | "validation-mutated" | "cancel-during-validation" | "cancel-before-publication-permit" | "cancel-after-publication-permit" | "cancel-during-publication" | "publication-outcome-unknown" = "pass", config: string | null = '{"schema_version":1,"command":"pnpm test"}') {
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
  const timeline: string[] = [];
  let signalPublicationStarted!: () => void;
  let releasePublication!: () => void;
  const publicationStarted = new Promise<void>(resolve => { signalPublicationStarted = resolve; });
  const publicationGate = new Promise<void>(resolve => { releasePublication = resolve; });
  const publishCandidate = vi.fn(async () => {
    if (run === "cancel-after-publication-permit") active = false;
    if (run === "cancel-during-publication") {
      timeline.push("coordinator-requested");
      signalPublicationStarted();
      await publicationGate;
      timeline.push("coordinator-accepted");
    }
    if (run === "publication-outcome-unknown") {
      heads.set(target.branch, { ...target, commitId: commit("d"), revision: target.revision + 1, manifestHash: hash("d") });
      throw new Error("response outcome unavailable");
    }
    heads.set(target.branch, { ...candidate, branch: target.branch, revision: target.revision + 1 });
  });
  const saveReceipt = vi.fn(async () => {});
  let active = true;
  const authorizePublication = vi.fn(async () => {
    timeline.push("permit-authorized");
    if (run === "cancel-before-publication-permit") active = false;
    if (!active) throw new Error("worker_cancelled");
  });
  const mergeCandidate = vi.fn(async () => {
    heads.set(candidate.branch, candidate);
    return {};
  });
  const host: WorkerIntegrationHost = {
    isActive: async () => active,
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
      if (run === "cancel-during-validation") active = false;
      if (run === "stale-target") heads.set(target.branch, { ...target, revision: 3, manifestHash: hash("c") });
      if (run === "validation-mutated") heads.set(validation.branch, { ...validation, commitId: commit("e"), manifestHash: hash("e"), revision: validation.revision + 1 });
      return run === "pass" || run === "stale-target" || run === "target-advanced" || run === "cancel-before-publication-permit" || run === "cancel-after-publication-permit" || run === "cancel-during-publication" || run === "publication-outcome-unknown"
        ? { status: "passed", exitCode: 0, durationMs: 12 }
        : { status: "failed", exitCode: 1, durationMs: 12, reason: "api_schema_incompatibility" };
    },
    authorizePublication,
    publishCandidate,
    readPublicationHead: async branch => heads.get(branch) ?? null,
    saveReceipt,
  };
  return { host, authorizePublication, publishCandidate, saveReceipt, mergeCandidate, target, source, sourceBase, timeline,
    publicationStarted, releasePublication: () => releasePublication(), cancel: () => { timeline.push("cancel-requested"); active = false; } };
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
    const recordMetric = vi.fn();
    f.host.recordMetric = recordMetric;
    const result = await runCheckedWorkerIntegration(pinnedInput(f), f.host);
    expect(result.status).toBe("published");
    expect(result.receipt).toMatchObject({ status: "passed", publicationStatus: "published", branch: input.validationBranch });
    expect(recordMetric).toHaveBeenCalledWith({ outcome: "published", validationStatus: "passed", durationMs: 12 });
    expect(f.publishCandidate).toHaveBeenCalledWith(expect.objectContaining({
      targetBranch: "main", candidateBranch: input.candidateBranch,
      expectedTarget: expect.objectContaining({ commitId: commit("a"), revision: 2, manifestHash: hash("a") }),
      expectedSourceCommitId: commit("b"),
    }));
  });

  it("does not publish or save a success receipt when cancellation lands during validation", async () => {
    const f = fixture("cancel-during-validation");
    await expect(runCheckedWorkerIntegration(pinnedInput(f), f.host)).rejects.toThrow("worker_cancelled");
    expect(f.publishCandidate).not.toHaveBeenCalled();
    expect(f.saveReceipt).not.toHaveBeenCalled();
  });

  it("fences cancellation before the durable publication permit", async () => {
    const f = fixture("cancel-before-publication-permit");
    await expect(runCheckedWorkerIntegration(pinnedInput(f), f.host)).rejects.toThrow("worker_cancelled");
    expect(f.authorizePublication).toHaveBeenCalledOnce();
    expect(f.publishCandidate).not.toHaveBeenCalled();
    expect(f.saveReceipt).toHaveBeenCalledTimes(1); // the passed, not-yet-published validation receipt
  });

  it("records an accepted publication after cancellation without requiring worker completion", async () => {
    const f = fixture("cancel-after-publication-permit");
    const result = await runCheckedWorkerIntegration(pinnedInput(f), f.host);
    expect(f.authorizePublication).toHaveBeenCalledOnce();
    expect(f.publishCandidate).toHaveBeenCalledOnce();
    expect(result.status).toBe("published");
    expect(result.receipt).toMatchObject({ status: "passed", publicationStatus: "published" });
    expect(f.saveReceipt).toHaveBeenLastCalledWith(expect.objectContaining({ status: "passed", publicationStatus: "published" }));
  });

  it("records the Coordinator outcome when cancellation arrives during an authorized publication request", async () => {
    const f = fixture("cancel-during-publication");
    const pending = runCheckedWorkerIntegration(pinnedInput(f), f.host);
    await f.publicationStarted;
    expect(f.authorizePublication).toHaveBeenCalledOnce();
    expect(f.publishCandidate).toHaveBeenCalledOnce();

    f.cancel();
    f.releasePublication();
    const result = await pending;

    expect(f.timeline).toEqual(["permit-authorized", "coordinator-requested", "cancel-requested", "coordinator-accepted"]);
    expect(result.status).toBe("published");
    expect(result.receipt).toMatchObject({ status: "passed", publicationStatus: "published" });
    expect(f.saveReceipt).toHaveBeenLastCalledWith(expect.objectContaining({ status: "passed", publicationStatus: "published" }));
  });

  it("keeps a passed check distinct from an uncertain target publication", async () => {
    const f = fixture("publication-outcome-unknown");
    const result = await runCheckedWorkerIntegration(pinnedInput(f), f.host);
    expect(result.status).toBe("uncertain");
    expect(result.receipt).toMatchObject({ status: "passed", publicationStatus: "uncertain", reason: "target_publication_outcome_uncertain" });
    expect(f.saveReceipt).toHaveBeenLastCalledWith(expect.objectContaining({ status: "passed", publicationStatus: "uncertain" }));
  });

  it("emits bounded validation metrics with only fixed categories and duration", () => {
    const points: Array<{ blobs: string[]; doubles: number[] }> = [];
    writeWorkerIntegrationMetric({ writeDataPoint: point => points.push(point) } as unknown as Pick<AnalyticsEngineDataset, "writeDataPoint">,
      { outcome: "uncertain", validationStatus: "failed", durationMs: 900_000_001 });
    expect(points).toEqual([{ blobs: ["workspace.ops.worker_validation", "automated", "phase12", "uncertain", "failed", "", "", "", "worker-ops-v1"], doubles: [600_000, 1] }]);
    expect(() => writeWorkerIntegrationMetric({ writeDataPoint: () => { throw new Error("analytics unavailable"); } } as unknown as Pick<AnalyticsEngineDataset, "writeDataPoint">,
      { outcome: "published", validationStatus: "passed", durationMs: Number.NaN })).not.toThrow();
  });

  it("keeps durable success and publication intact when host telemetry throws", async () => {
    const f = fixture();
    f.host.recordMetric = () => { throw new Error("analytics unavailable"); };
    const result = await runCheckedWorkerIntegration(pinnedInput(f), f.host);
    expect(result.status).toBe("published");
    expect(f.saveReceipt).toHaveBeenCalledWith(expect.objectContaining({ status: "passed", publicationStatus: "published" }));
    expect(f.publishCandidate).toHaveBeenCalledOnce();
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
