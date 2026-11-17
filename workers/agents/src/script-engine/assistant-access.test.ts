import { describe, expect, it } from "vitest";
import { restrictScheduledServiceApprovalPlan } from "./assistant-access.js";

describe("scheduled service approval policy", () => {
  it("keeps only explicitly read-safe enabled actions out of the owner approval gate", () => {
    const result = restrictScheduledServiceApprovalPlan(
      { approvalMode: "gate_listed", requiresApprovalFor: [] }, true,
      ["project.list", "knowledge.search", "project.update", "mcp.call", "Read", "Read"],
    );
    expect(result).toEqual({ approvalMode: "gate_unless_listed", requiresApprovalFor: ["Read", "knowledge.search", "project.list"] });
  });

  it("leaves interactive callers' configured policy unchanged", () => {
    const plan = { approvalMode: "gate_listed" as const, requiresApprovalFor: ["project.update"] };
    expect(restrictScheduledServiceApprovalPlan(plan, false, ["Read"])).toBe(plan);
  });
});
