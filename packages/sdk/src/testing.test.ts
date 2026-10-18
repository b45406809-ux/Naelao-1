import { describe, expect, it } from "vitest";
import { runMockWorkflowPlan } from "./testing.js";

describe("offline extension test harness", () => {
  it("runs a synthetic plan using only static fixtures and reports unpriced mock resources honestly", () => {
    const result = runMockWorkflowPlan({
      plan: { schemaVersion: "1.0", steps: [
        { id: "find_notes", operation: "extension.gadget.list", args: { gadget_id: "journal", table: "notes" } },
        { id: "send_summary", operation: "notifications.email", args: { to: "student@example.test", notes: { $workflowRef: "find_notes" } } },
      ] },
      allowedCapabilities: ["extension.gadget.list", "notifications.email"],
      responses: { find_notes: [{ id: "n1", title: "Lesson 1" }] },
    });
    expect(result).toMatchObject({ passed: true, result: { find_notes: [{ id: "n1", title: "Lesson 1" }], send_summary: { simulated: true, operation: "notifications.email" } }, calls: [
      { stepId: "find_notes", operation: "extension.gadget.list", args: { gadget_id: "journal", table: "notes" } },
      { stepId: "send_summary", operation: "notifications.email", args: { to: "student@example.test", notes: [{ id: "n1", title: "Lesson 1" }] } },
    ], profile: {
      mode: "offline_mock", operations: 2, uniqueCapabilities: 2, liveProviderCalls: 0, liveWorkerRuns: 0, creditsMeasured: false, estimatedCredits: null, costConfidence: "not_measured",
    } });
  });

  it("fails before simulation when a plan requests a capability outside its grant fixture", () => {
    expect(() => runMockWorkflowPlan({ plan: { schemaVersion: "1.0", steps: [{ id: "pay", operation: "payments.transfer", args: { amount: 20 } }] }, allowedCapabilities: [] })).toThrow("workflow_plan_step_invalid_or_ungranted");
  });
});
