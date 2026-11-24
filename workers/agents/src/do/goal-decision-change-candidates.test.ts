import { describe, expect, it } from "vitest";
import { projectDecisionChangeCandidates } from "./goal-decision-change-candidates.js";

const ref = { id: "decision-api-v1", revision: 3 };

describe("Project decision change review candidates", () => {
  it("flags distinct worker-reported paths under the same exact decision revision as review-only", () => {
    const candidates = projectDecisionChangeCandidates([
      { id: "api", decision_refs: [ref] }, { id: "client", decision_refs: [ref] },
    ], { tasks: {
      api: { status: "completed", workerId: "worker-api", result: { id: "api", ok: true, output: { modifiedFiles: ["src/api.ts"] } } },
      client: { status: "completed", workerId: "worker-client", result: { id: "client", ok: true, output: { modifiedFiles: ["src/client.ts"] } } },
    } });

    expect(candidates).toEqual([{ decision: ref, tasks: [
      { id: "api", reportedPaths: ["src/api.ts"] }, { id: "client", reportedPaths: ["src/client.ts"] },
    ], kind: "shared_decision_distinct_path_reports", evidence: "worker_reported_paths", status: "review_candidate" }]);
  });

  it("does not call overlap, failed work, missing reports, or different revisions a semantic candidate", () => {
    const tasks = [
      { id: "overlap-a", decision_refs: [ref] }, { id: "overlap-b", decision_refs: [ref] },
      { id: "failed", decision_refs: [ref] }, { id: "revision", decision_refs: [{ ...ref, revision: 4 }] },
    ];
    const candidates = projectDecisionChangeCandidates(tasks, { tasks: {
      "overlap-a": { status: "completed", workerId: "a", result: { id: "a", ok: true, output: { modifiedFiles: ["src/shared.ts"] } } },
      "overlap-b": { status: "completed", workerId: "b", result: { id: "b", ok: true, output: { modifiedFiles: ["src/shared.ts"] } } },
      failed: { status: "failed", workerId: "failed", result: { id: "failed", ok: false, output: { modifiedFiles: ["src/failed.ts"] } } },
      revision: { status: "completed", workerId: "revision", result: { id: "revision", ok: true, output: { modifiedFiles: ["src/new.ts"] } } },
    } });
    expect(candidates).toEqual([]);
  });

  it("drops unsafe and malformed paths and bounds the report", () => {
    const candidates = projectDecisionChangeCandidates([
      { id: "a", decision_refs: [ref] }, { id: "b", decision_refs: [ref] },
    ], { tasks: {
      a: { status: "completed", workerId: "a", result: { id: "a", ok: true, output: { modifiedFiles: ["../secret", "/etc/passwd", "src\\secret", "src/a.ts"] } } },
      b: { status: "completed", workerId: "b", result: { id: "b", ok: true, output: { modifiedFiles: ["src/b.ts"] } } },
    } });
    expect(candidates[0]?.tasks[0]?.reportedPaths).toEqual(["src/a.ts"]);
  });
});
