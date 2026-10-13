import { describe, expect, it } from "vitest";
import { WORKFLOW_CLASS_POLICIES, routeWorkflow } from "./workflow-taxonomy.js";

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

describe("workflow routing", () => {
  it("isolates class budgets and targets reports", () => {
    expect(routeWorkflow({ workflowClass: "company_automation", spaceId: "s", budgetCredits: 10 })).toMatchObject({ budgetKey: "workflow:company_automation:s", reportTarget: "executive_channel_and_founder_telegram", escalationTarget: "space_owner" });
    expect(routeWorkflow({ workflowClass: "vertical_extension", spaceId: "s", projectId: "p", extensionId: "ext_ci", budgetCredits: 2 })).toMatchObject({ budgetKey: "workflow:vertical_extension:ext_ci:p", reportTarget: "project_team_room" });
    expect(routeWorkflow({ workflowClass: "ephemeral_task", spaceId: "s", invokerId: "u", budgetCredits: 1 })).toMatchObject({ budgetKey: "workflow:ephemeral_task:u", reportTarget: "receipt_card" });
  });

  it("enforces class ownership boundaries", () => {
    expect(() => routeWorkflow({ workflowClass: "company_automation", spaceId: "s", projectId: "p", budgetCredits: 1 })).toThrow("rooted at the space");
    expect(() => routeWorkflow({ workflowClass: "vertical_extension", spaceId: "s", projectId: "p", extensionId: "ext_ok", budgetCredits: 1 })).not.toThrow();
  });

  it("routes a vertical extension installed for a whole Space under installation ownership", () => {
    expect(routeWorkflow({ workflowClass: "vertical_extension", spaceId: "s", installationId: "install-a", extensionId: "ext_ok", budgetCredits: 1 }))
      .toMatchObject({ budgetKey: "workflow:vertical_extension:ext_ok:install-a", reportTarget: "executive_channel_and_founder_telegram" });
    expect(() => routeWorkflow({ workflowClass: "vertical_extension", spaceId: "s", installationId: "install-a", budgetCredits: 1 })).toThrow("extensionId");
  });
});
