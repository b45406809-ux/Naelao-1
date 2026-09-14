export type WorkflowClass =
  | "company_automation"
  | "vertical_extension"
  | "ephemeral_task";
export interface WorkflowClassPolicy {
  owner: "space" | "extension" | "invoker";
  persistence: "durable" | "extension_state" | "until_terminal";
  maxAttempts: number;
  cancellation: "owner_or_admin" | "extension_or_admin" | "invoker_or_admin";
  billing: "space" | "extension_budget" | "invoker";
}
export const WORKFLOW_CLASS_POLICIES: Readonly<
  Record<WorkflowClass, WorkflowClassPolicy>
> = Object.freeze({
  company_automation: {
    owner: "space",
    persistence: "durable",
    maxAttempts: 5,
    cancellation: "owner_or_admin",
    billing: "space",
  },
  vertical_extension: {
    owner: "extension",
    persistence: "extension_state",
    maxAttempts: 3,
    cancellation: "extension_or_admin",
    billing: "extension_budget",
  },
  ephemeral_task: {
    owner: "invoker",
    persistence: "until_terminal",
    maxAttempts: 2,
    cancellation: "invoker_or_admin",
    billing: "invoker",
  },
});
