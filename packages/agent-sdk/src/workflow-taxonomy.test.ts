import { describe, expect, it } from "vitest";
import { WORKFLOW_CLASS_POLICIES } from "./workflow-taxonomy.js";

describe("Workflow Taxonomy Policies (Item 4)", () => {
  it("defines durable policies for company automations", () => {
    const policy = WORKFLOW_CLASS_POLICIES.company_automation;
    expect(policy.owner).toBe("space");
    expect(policy.persistence).toBe("durable");
    expect(policy.maxAttempts).toBe(5);
    expect(policy.billing).toBe("space");
  });

  it("defines extension-scoped policies for vertical extensions", () => {
    const policy = WORKFLOW_CLASS_POLICIES.vertical_extension;
    expect(policy.owner).toBe("extension");
    expect(policy.persistence).toBe("extension_state");
    expect(policy.billing).toBe("extension_budget");
  });

  it("bounds ephemeral task execution without holding DO compute", () => {
    const policy = WORKFLOW_CLASS_POLICIES.ephemeral_task;
    expect(policy.persistence).toBe("until_terminal");
    expect(policy.maxAttempts).toBe(2);
  });
});
