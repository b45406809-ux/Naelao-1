export type WorkflowClass = "COMPANY_AUTOMATION" | "VERTICAL_EXTENSION" | "EPHEMERAL_TASK";

/**
 * Declarative hooks allow templates and users to inject verification and context enrichment 
 * steps safely without writing raw execution scripts that could leak credentials.
 */
export interface DeclarativePipelineHooks {
  /**
   * Pre-flight context enrichment. E.g., Query a background indexing gadget via MCP 
   * to fetch a relational graph before touching code.
   */
  preFlightMcp?: Array<{
    server: string;
    tool: string;
    description: string;
  }>;

  /**
   * Verification Gate. A deterministic validation check run before a task is marked complete.
   */
  verificationGate?: {
    command: string;           // e.g., "npm test" or "pytest"
    requiredExitCode: number;  // e.g., 0
    maxRetryAttempts: number;  // e.g., 2
  };
}

export interface AvosWorkflowDefinition {
  id: string;
  name: string;
  description: string;
  workflowClass: WorkflowClass;
  scope: "SPACE_WIDE" | "PROJECT_BOUND" | "TASK_BOUND";
  spaceId: string;
  projectId?: string;
  bundledByPluginId?: string;

  trigger: {
    type: "cron" | "webhook" | "event_queue" | "on_demand";
    cronExpression?: string; 
    eventTopic?: string;
  };

  governance: {
    maxStepCeiling: number;
    stepTimeoutSeconds: number;
    alertChannel: "FOUNDER_TELEGRAM" | "PROJECT_TEAM_ROOM" | "THREAD_RECEIPT_ONLY";
    fundingSource: "COMPANY_WALLET" | "PROJECT_CAP" | "USER_CREDITS";
  };

  hooks?: DeclarativePipelineHooks;
  entrypointPath: string; // The .avos/shared/workflows/ path
}
