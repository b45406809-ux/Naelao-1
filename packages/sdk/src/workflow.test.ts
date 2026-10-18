import { describe, expect, it } from "vitest";
import { compileWorkflowPlan } from "./workflow.js";

describe("declarative workflow plan compiler", () => {
  it("emits durable, capability-bound steps with data serialized as JSON", () => {
    const compiled = compileWorkflowPlan({ schemaVersion: "1.0", steps: [
      { id: "lookup", operation: "extension.gadget.list", args: { gadget_id: "journal", table: "notes", filter: { status: "open" } } },
      { id: "notify", operation: "notifications.email", args: { subject: "Review", body: "${process.env.SECRET}" } },
    ] }, ["extension.gadget.list", "notifications.email"]);
    expect(compiled).toMatchObject({ stepIds: ["lookup", "notify"], capabilities: ["extension.gadget.list", "notifications.email"] });
    expect(compiled.source).toContain('step.do("plan:" + item.id');
    expect(compiled.source).toContain("${process.env.SECRET}");
    expect(compiled.source).not.toContain("process.env.SECRET);");
  });

  it("rejects ungranted capabilities, duplicate or malformed steps, and oversized plans", () => {
    expect(() => compileWorkflowPlan({ schemaVersion: "1.0", steps: [{ id: "send", operation: "payments.transfer", args: {} }] }, ["notifications.email"])).toThrow("workflow_plan_step_invalid_or_ungranted");
    expect(() => compileWorkflowPlan({ schemaVersion: "1.0", steps: [{ id: "read", operation: "tools.read", args: {} }, { id: "read", operation: "tools.read", args: {} }] }, ["tools.read"])).toThrow("workflow_plan_step_invalid_or_ungranted");
    expect(() => compileWorkflowPlan({ schemaVersion: "1.0", steps: [] }, [])).toThrow("workflow_plan_invalid");
    expect(() => compileWorkflowPlan({ schemaVersion: "1.0", steps: [{ id: "bad.id", operation: "tools.read", args: {} }] }, ["tools.read"])).toThrow("workflow_plan_step_invalid_or_ungranted");
  });
});
