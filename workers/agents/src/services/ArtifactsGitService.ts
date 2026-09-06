export interface ArtifactsRepository {
  id: string;
  name: string;
  remoteUrl: string;
  head: string;
  createWriteToken(expirySeconds: number): Promise<string>;
  fork(forkName: string): Promise<ArtifactsRepository>;
  fastForward(commitId: string): Promise<{ ok: boolean; mergedCommit: string }>;
}

export interface RepoDiffSummary {
  additions: number;
  deletions: number;
  changedFiles: string[];
}

export interface ArtifactsEnv {
  AGENT_REPOS: {
    create(name: string): Promise<ArtifactsRepository>;
    get(name: string): Promise<ArtifactsRepository>;
    fork(parentName: string, forkName: string): Promise<ArtifactsRepository>;
    compare(baseName: string, forkName: string): Promise<RepoDiffSummary>;
  };
}

export class ArtifactsGitService {
  private env: ArtifactsEnv;

  constructor(env: ArtifactsEnv) {
    this.env = env;
  }

  /**
   * Creates a fresh repository for a project, and issues a 24-hour write token.
   */
  async createProjectRepo(projectId: string): Promise<{ repoId: string; remoteUrl: string; token: string }> {
    const repoName = `proj_${projectId}`;
    const repo = await this.env.AGENT_REPOS.create(repoName);
    const token = await repo.createWriteToken(24 * 60 * 60); // 24-hour write token
    return {
      repoId: repo.id,
      remoteUrl: repo.remoteUrl,
      token,
    };
  }

  /**
   * Forks an existing repository and issues a 1-hour write token.
   */
  async createRepoFork(parentRepoName: string, forkSuffix: string): Promise<{ forkName: string; remoteUrl: string; token: string }> {
    const forkName = `${parentRepoName}_fork_${forkSuffix}`;
    const forkRepo = await this.env.AGENT_REPOS.fork(parentRepoName, forkName);
    const token = await forkRepo.createWriteToken(1 * 60 * 60); // 1-hour write token
    return {
      forkName: forkRepo.name,
      remoteUrl: forkRepo.remoteUrl,
      token,
    };
  }

  /**
   * Compares two repository states (HEAD commits) and returns a diff summary.
   */
  async generateCommitDiff(baseRepoName: string, forkRepoName: string): Promise<RepoDiffSummary> {
    const diff = await this.env.AGENT_REPOS.compare(baseRepoName, forkRepoName);
    return {
      additions: diff.additions,
      deletions: diff.deletions,
      changedFiles: diff.changedFiles,
    };
  }

  /**
   * Fast-forwards base repository to the head of the fork.
   */
  async fastForwardMerge(baseRepoName: string, forkRepoName: string): Promise<{ ok: boolean; mergedCommit: string }> {
    const baseRepo = await this.env.AGENT_REPOS.get(baseRepoName);
    const forkRepo = await this.env.AGENT_REPOS.get(forkRepoName);
    const result = await baseRepo.fastForward(forkRepo.head);
    return {
      ok: result.ok,
      mergedCommit: result.mergedCommit,
    };
  }
}
