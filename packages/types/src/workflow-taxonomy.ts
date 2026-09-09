export type WorkflowClass = "COMPANY_AUTOMATION" | "VERTICAL_EXTENSION" | "EPHEMERAL_TASK";

export type WorkflowTriggerType = "cron" | "webhook" | "event_queue" | "on_demand" | "git_push";

export type WorkflowFundingSource = "COMPANY_WALLET" | "PROJECT_CAP" | "USER_CREDITS";

export type WorkflowAlertChannel = "FOUNDER_TELEGRAM" | "PROJECT_TEAM_ROOM" | "THREAD_RECEIPT_ONLY";

export interface AvosWorkflowGovernance {
  maxStepCeiling: number;        // e.g. 50 steps max to prevent runaway loops
  stepTimeoutSeconds: number;    // e.g. 300s (5 minutes) per step
  fundingSource: WorkflowFundingSource;
  alertChannel: WorkflowAlertChannel;
}

export interface AvosWorkflowDefinition {
  id: string;                    // e.g. "wf_stripe_reconciler_01"
  spaceId: string;
  projectId?: string;            // Nullable for space-wide root automations
  workflowClass: WorkflowClass;
  title: string;
  description: string;
  pluginId?: string;             // Optional owning plugin identifier
  scriptPath: string;            // Path in virtual FS e.g. "/.avos/shared/workflows/reconcile.ts"
  trigger: {
    type: WorkflowTriggerType;
    cronExpression?: string;     // e.g. "0 8 * * *"
    eventTopic?: string;         // e.g. "git.branch_pushed", "stripe.charge_dispute"
  };
  governance: AvosWorkflowGovernance;
  status: "ACTIVE" | "PAUSED" | "DISABLED";
  createdAt: string;
  updatedAt: string;
}
