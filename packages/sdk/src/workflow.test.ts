import { describe, expect, it } from "vitest";
import { compileWorkflowPlan, createWorkflowExtensionRelease } from "./workflow.js";

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

  it("accepts only references to completed steps with bounded JSON pointers", () => {
    const compiled = compileWorkflowPlan({ schemaVersion: "1.0", steps: [
      { id: "lookup", operation: "records.read", args: {} },
      { id: "notify", operation: "notifications.email", args: { to: { $workflowRef: "lookup#/owner/email" } } },
    ] }, ["records.read", "notifications.email"]);
    expect(compiled.source).toContain("workflow_plan_reference_path_missing");
    expect(() => compileWorkflowPlan({ schemaVersion: "1.0", steps: [
      { id: "notify", operation: "notifications.email", args: { to: { $workflowRef: "later#/owner/email" } } },
      { id: "later", operation: "records.read", args: {} },
    ] }, ["records.read", "notifications.email"])).toThrow("workflow_plan_reference_invalid");
    expect(() => compileWorkflowPlan({ schemaVersion: "1.0", steps: [
      { id: "lookup", operation: "records.read", args: {} },
      { id: "notify", operation: "notifications.email", args: { to: { $workflowRef: "lookup#/owner/~2email" } } },
    ] }, ["records.read", "notifications.email"])).toThrow("workflow_plan_reference_invalid");
  });

  it("builds a signed-package-ready internal workflow bundle and refuses ungranted Gadget table actions", () => {
    const release = createWorkflowExtensionRelease({ extensionId: "ext_course_helper", version: "1.0.0",
      plan: { schemaVersion: "1.0", steps: [{ id: "summarize", operation: "knowledge.search", args: { query: "lesson" } }] },
      allowedCapabilities: ["knowledge.search"] });
    expect(release).toMatchObject({ artifactPath: "./workflow.ts", operations: ["knowledge.search"], manifest: {
      id: "ext_course_helper", bundle: { id: "ext_course_helper", primitives: [{ id: "workflow", kind: "workflow", entry: "./workflow.ts" }],
        workerRoles: [{ principal: "project_member", primitiveIds: ["workflow"] }] },
    } });
    expect(() => createWorkflowExtensionRelease({ extensionId: "ext_course_helper", version: "1.0.0",
      plan: { schemaVersion: "1.0", steps: [{ id: "write", operation: "extension.gadget.insert", args: { gadget_id: "notes", table: "items", record: {} } }] },
      allowedCapabilities: ["extension.gadget.insert"] })).toThrow("workflow_gadget_action_grants_required");
  });
});
