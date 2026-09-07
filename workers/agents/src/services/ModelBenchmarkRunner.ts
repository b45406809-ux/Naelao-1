export interface ModelRaceCandidate {
  modelId: string;
  branchName: string;
  maxSteps?: number;
}

export interface ModelRaceResultItem {
  modelId: string;
  branch: string;
  success: boolean;
  testExitCode: number;
  durationMs: number;
  tokenSpend: number;
  error?: string;
}

export interface ModelBenchmarkLeaderboard {
  winner: ModelRaceResultItem;
  leaderboard: ModelRaceResultItem[];
  executedAt: string;
}
