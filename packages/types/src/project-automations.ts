export type WorkflowClass = "COMPANY_AUTOMATION" | "VERTICAL_EXTENSION" | "EPHEMERAL_TASK";

export interface ProjectAnchoredWorkflow {
  id: string;
  projectId: string;
  spaceId: string;
  workflowClass: WorkflowClass;
  title: string;
  scriptPath: string;
  triggerType: string;
  triggerSpec?: string | null;
  status: "ACTIVE" | "PAUSED" | "DISABLED";
  createdAt: string;
  updatedAt: string;
}
