export type PullRequestStatus = "OPEN" | "MERGED" | "REJECTED" | "CHANGES_REQUESTED";

export interface FileDiffEntry {
  path: string;
  status: "CREATED" | "MODIFIED" | "DELETED";
  additions: number;
  deletions: number;
  patch: string;
  oldContent?: string;
  newContent?: string;
}

export interface PullRequestRecord {
  id: string;
  spaceId: string;
  projectId: string;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  reasoningSummary: string;
  diffManifest: FileDiffEntry[];
  totalAdditions: number;
  totalDeletions: number;
  authorUserId?: string;
  authorAgentId?: string;
  status: PullRequestStatus;
  createdAt: string;
  mergedAt?: string;
  mergedByUserId?: string;
}

export interface BranchDivergenceStatus {
  branchName: string;
  baseBranch: string;
  commitsBehind: number;
  commitsAhead: number;
  baseHeadCommit: string;
  branchHeadCommit: string;
  hasConflict: boolean;
  conflictingFiles: string[];
}

export interface ModelRaceResult {
  raceId: string;
  taskId: string;
  candidates: Array<{
    modelId: string;
    branchName: string;
    commitSha: string;
    testPassed: boolean;
    durationMs: number;
    tokensUsed: number;
    diffSummary: { additions: number; deletions: number };
  }>;
  winningBranchName?: string;
}
