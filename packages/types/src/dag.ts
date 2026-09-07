export type ModelTierTarget = "EDGE_OPEN" | "FRONTIER_REASON";

export interface SubtaskPlanItem {
  id: string;                               // e.g. "task_01_db_schema"
  title: string;                            // "Scaffold D1 Database Schema"
  targetFiles: string[];                    // ["infra/migrations/0080_stripe.sql", "src/types/billing.ts"]
  specification: string;                    // Self-contained, explicit PRD for the worker model
  assignedModelTier: ModelTierTarget;       // Defaults to "EDGE_OPEN"
  dependencies: string[];                   // Task IDs that must finish before this task starts
}

export interface FrontierArchitecturePlan {
  architecturalSummary: string;
  targetRepositoryFiles: string[];
  tasks: SubtaskPlanItem[];
}

export interface SubtaskExecutionResult {
  taskId: string;
  success: boolean;
  modifiedFiles: string[];
  outputSummary: string;
  error?: string;
  tokensUsed: number;
}

export interface GoalPipelineResult {
  goalPrompt: string;
  architecturalSummary: string;
  tasksCompleted: number;
  tasksFailed: number;
  modifiedFiles: string[];
  auditApproved: boolean;
  auditFeedback: string;
  branchName: string;
}
