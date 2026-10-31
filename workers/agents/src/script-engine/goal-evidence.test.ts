import { describe, expect, it } from "vitest";
import { evaluateGoalEvidence, type GoalEvidence } from "./goal-evidence.js";

describe("independent goal evidence", () => {
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
});
