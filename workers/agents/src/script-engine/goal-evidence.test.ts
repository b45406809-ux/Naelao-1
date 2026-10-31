import { describe, expect, it } from "vitest";
import { captureWorkerArtifactManifest, collectGoalEvidence, evaluateGoalEvidence, verifyWorkerArtifact, type GoalEvidence, type ArtifactReadPort } from "./goal-evidence.js";

describe("independent goal evidence", () => {
  it("collects only declared checks for known criteria through the host", async () => {
    const run = async (operation: string) => ({ outcome: "passed" as const, reference: `host:${operation}` });
    const evidence = await collectGoalEvidence(["build succeeds"], [{ criterion: "build succeeds", operation: "workspace.sha256:src/build.log" }], run);
    expect(evaluateGoalEvidence(["build succeeds"], evidence).outcome).toBe("passed");
    await expect(collectGoalEvidence(["build succeeds"], [{ criterion: "other", operation: "workspace.sha256:src/build.log" }], run)).rejects.toThrow("invalid_goal_evidence_checks");
    await expect(collectGoalEvidence(["build succeeds"], [{ criterion: "build succeeds", operation: "rm -rf /" }], run)).rejects.toThrow("invalid_goal_evidence_checks");
  });
  const passed: GoalEvidence = { criterion: "build succeeds", source: "host_check", outcome: "passed", reference: "check:123" };
  it("passes only when every criterion has host evidence", () => {
    expect(evaluateGoalEvidence(["build succeeds"], [passed]).outcome).toBe("passed");
    expect(evaluateGoalEvidence(["build succeeds", "review complete"], [passed]).outcome).toBe("uncertain");
  });
  it("rejects ambiguous criteria and evidence without a reference", () => {
    expect(evaluateGoalEvidence(["build succeeds", "build succeeds"], [passed]).outcome).toBe("uncertain");
    expect(evaluateGoalEvidence(["build succeeds"], [{ ...passed, reference: "" }]).outcome).toBe("uncertain");
  });
  it("does not let a passing check hide failed or uncertain evidence", () => {
    expect(evaluateGoalEvidence(["build succeeds"], [passed, { ...passed, outcome: "failed" }]).outcome).toBe("failed");
    expect(evaluateGoalEvidence(["build succeeds"], [passed, { ...passed, outcome: "uncertain" }]).outcome).toBe("uncertain");
  });
  it("binds captured evidence to worker, branch, parent and attempt, and detects later mutation", async () => {
    let bytes = new TextEncoder().encode("before"), etag = "v1";
    const port: ArtifactReadPort = { head: async () => ({ size: bytes.length, etag }), read: async () => ({ bytes: bytes.slice(), etag }) };
    const scope = { tenantId: "t", spaceId: "s", projectId: "p", parentRunId: "run", workerId: "worker", attempt: 2, branch: "workers/worker", paths: ["src/a.ts"] };
    const manifest = await captureWorkerArtifactManifest(scope, port);
    expect((await verifyWorkerArtifact(manifest, "src/a.ts", port, scope)).outcome).toBe("passed");
    bytes = new TextEncoder().encode("after"); etag = "v2";
    expect((await verifyWorkerArtifact(manifest, "src/a.ts", port, scope)).outcome).toBe("uncertain");
    expect((await verifyWorkerArtifact(manifest, "src/a.ts", port, { ...scope, attempt: 3 })).outcome).toBe("uncertain");
  });
  it("rejects duplicate and conflicting evidence specifications", async () => {
    const run = async () => ({ outcome: "passed" as const, reference: "host:stable" });
    const duplicate = [{ criterion: "build succeeds", operation: "workspace.sha256:src/build.log" }, { criterion: "build succeeds", operation: "workspace.exists:src/build.log" }];
    await expect(collectGoalEvidence(["build succeeds"], duplicate, run)).rejects.toThrow("invalid_goal_evidence_checks");
    expect(evaluateGoalEvidence(["build succeeds"], [passed, { ...passed, reference: "host:conflict", outcome: "uncertain" }]).outcome).toBe("uncertain");
  });
  it("records missing, too-large and unavailable artifacts without treating them as evidence", async () => {
    const port: ArtifactReadPort = { head: async path => path === "missing" ? null : ({ size: path === "large" ? 2_000_000 : 1, etag: "v1" }), read: async path => path === "race" ? null : ({ bytes: new Uint8Array([1]), etag: "v1" }) };
    const manifest = await captureWorkerArtifactManifest({ tenantId: "t", spaceId: "s", projectId: null, parentRunId: "r", workerId: "w", attempt: 1, branch: "workers/w", paths: ["missing", "large", "race"] }, port);
    expect(manifest.artifacts.map(item => item.status)).toEqual(["missing", "too_large", "unavailable"]);
  });
});
