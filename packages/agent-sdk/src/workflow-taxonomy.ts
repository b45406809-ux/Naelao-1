export type WorkflowClass =
  | "company_automation"
  | "vertical_extension"
  | "ephemeral_task";
export interface WorkflowClassPolicy {
  executionClass: 1 | 2 | 3;
  minimumDeterministicStepRatio: number;
  owner: "space" | "extension" | "invoker";
  persistence: "durable" | "extension_state" | "until_terminal";
  maxAttempts: number;
  cancellation: "owner_or_admin" | "extension_or_admin" | "invoker_or_admin";
  billing: "space" | "extension_budget" | "invoker";
  reportsTo: "executive_channel_and_founder_telegram" | "project_team_room" | "receipt_card";
  escalationTarget: "space_owner" | "project_lead" | "invoker";
  receiptLines: 2 | null;
}
export const WORKFLOW_CLASS_POLICIES: Readonly<
  Record<WorkflowClass, WorkflowClassPolicy>
> = Object.freeze({
  company_automation: {
    executionClass: 1, minimumDeterministicStepRatio: 0.9,
    owner: "space",
    persistence: "durable",
    maxAttempts: 5,
    cancellation: "owner_or_admin",
    billing: "space",
    reportsTo: "executive_channel_and_founder_telegram", escalationTarget: "space_owner", receiptLines: null,
  },
  vertical_extension: {
    executionClass: 2, minimumDeterministicStepRatio: 0,
    owner: "extension",
    persistence: "extension_state",
    maxAttempts: 3,
    cancellation: "extension_or_admin",
    billing: "extension_budget",
    reportsTo: "project_team_room", escalationTarget: "project_lead", receiptLines: null,
  },
  ephemeral_task: {
    executionClass: 3, minimumDeterministicStepRatio: 0,
    owner: "invoker",
    persistence: "until_terminal",
    maxAttempts: 2,
    cancellation: "invoker_or_admin",
    billing: "invoker",
    reportsTo: "receipt_card", escalationTarget: "invoker", receiptLines: 2,
  },
});

export interface WorkflowDeclaration { workflowClass: WorkflowClass; spaceId: string; projectId?: string; extensionId?: string; invokerId?: string; budgetCredits: number }
export interface RoutedWorkflow extends WorkflowDeclaration { budgetKey: string; reportTarget: WorkflowClassPolicy["reportsTo"]; escalationTarget: WorkflowClassPolicy["escalationTarget"] }
/** Validates scope and returns an isolated accounting/routing envelope. */
export function routeWorkflow(declaration: WorkflowDeclaration): RoutedWorkflow {
  if (!Number.isFinite(declaration.budgetCredits) || declaration.budgetCredits <= 0) throw new Error("workflow budget must be positive");
  const policy = WORKFLOW_CLASS_POLICIES[declaration.workflowClass];
  if (declaration.workflowClass === "vertical_extension" && (!declaration.projectId || !declaration.extensionId)) throw new Error("vertical workflow requires projectId and extensionId");
  if (declaration.workflowClass === "ephemeral_task" && !declaration.invokerId) throw new Error("ephemeral workflow requires invokerId");
  const owner = declaration.workflowClass === "company_automation" ? declaration.spaceId : declaration.workflowClass === "vertical_extension" ? `${declaration.extensionId}:${declaration.projectId}` : declaration.invokerId!;
  return { ...declaration, budgetKey: `workflow:${declaration.workflowClass}:${owner}`, reportTarget: policy.reportsTo, escalationTarget: policy.escalationTarget };
}
