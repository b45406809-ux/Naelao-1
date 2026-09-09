export type ScheduledJobStatus = "ACTIVE" | "PAUSED" | "COMPLETED";

export interface ProjectScheduledJob {
  id: string;
  spaceId: string;
  projectId: string;
  ownerBotId: string;
  originThreadId?: string;
  title: string;
  cronExpression: string;
  workflowScriptPath: string;
  payloadJson: Record<string, any>;
  status: ScheduledJobStatus;
  lastRunAt?: string;
  nextRunAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectCronRunRecord {
  id: string;
  jobId: string;
  spaceId: string;
  projectId: string;
  executedByBotId: string;
  exitCode: number;
  summaryText: string;
  stdoutR2Key?: string;
  durationMs: number;
  executedAt: string;
}
