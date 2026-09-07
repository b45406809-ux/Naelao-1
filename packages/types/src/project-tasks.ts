export type TaskStatus = 
  | "OPEN"
  | "CLAIMED"
  | "IN_PROGRESS"
  | "IN_REVIEW"
  | "COMPLETED"
  | "BLOCKED_AWAITING_HUMAN"
  | "NEEDS_ALIGNMENT";

export interface ProjectTask {
  id: string;
  projectId: string;
  spaceId: string;
  title: string;
  description?: string;
  status: TaskStatus;
  claimedByUserId: string | null;
  claimedByAgentId: string | null;
  branchName: string | null;
  leaseExpiresAt: string | null;
  deliberationRound: number;
  semanticEmbedding?: number[];
  createdAt: string;
  updatedAt: string;
}

export interface TaskLeaseClaimResult {
  granted: boolean;
  taskId: string;
  currentStatus: TaskStatus;
  claimedByUserId?: string;
  claimedByAgentId?: string;
  branchName?: string;
  leaseExpiresAt?: string;
}

export interface SemanticDeduplicationResult {
  isDuplicate: boolean;
  existingTask?: ProjectTask;
  similarityScore?: number;
  message?: string;
}
