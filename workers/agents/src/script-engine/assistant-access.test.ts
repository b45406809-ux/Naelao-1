import { describe, expect, it } from "vitest";
import { restrictAutonomousServiceApprovalPlan } from "./assistant-access.js";

describe("scheduled service approval policy", () => {
  it("keeps only explicitly read-safe enabled actions out of the owner approval gate", () => {
    const result = restrictAutonomousServiceApprovalPlan(
      { approvalMode: "gate_listed", requiresApprovalFor: [] }, true,
      ["project.list", "knowledge.search", "project.update", "mcp.call", "Read", "Read"],
    );
    expect(result).toEqual({ approvalMode: "gate_unless_listed", requiresApprovalFor: ["Read", "knowledge.search", "project.list"] });
  });

  it("leaves interactive callers' configured policy unchanged", () => {
    const plan = { approvalMode: "gate_listed" as const, requiresApprovalFor: ["project.update"] };
    expect(restrictAutonomousServiceApprovalPlan(plan, false, ["Read"])).toBe(plan);
  });

  it("restricts autonomous connector polls independently of the Space yolo policy", () => {
    const plan = { approvalMode: "gate_unless_listed" as const, requiresApprovalFor: [] };
    expect(restrictAutonomousServiceApprovalPlan(plan, true, ["Read", "Write", "Dangerous"])).toEqual({
      approvalMode: "gate_unless_listed",
      requiresApprovalFor: ["Read"],
    });
  });
});
