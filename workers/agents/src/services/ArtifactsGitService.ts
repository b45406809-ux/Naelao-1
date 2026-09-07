import type { BranchDivergenceStatus, RepoDiffSummary } from "@naelao/types";

export interface ArtifactsRepository {

  id: string;
  name: string;
  remoteUrl?: string;
  remote?: string;
  head: string;
  createWriteToken?(expirySeconds: number): Promise<string>;
  issueToken?(opts: { permission: string; ttlSeconds: number }): Promise<{ token: string }>;
  fork?(forkName: string | { source: string; name: string }): Promise<ArtifactsRepository>;
  fastForward(commitId: string): Promise<{ ok: boolean; mergedCommit?: string }>;
  commit?(opts: { branch: string; message: string }): Promise<any>;
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
    fork(parentNameOrOpts: string | { source: string; name: string }, forkName?: string): Promise<ArtifactsRepository>;
    compare?(baseName: string | { base: string; head: string }, forkName?: string): Promise<any>;
  };
}

export class ArtifactsGitService {
  public env: ArtifactsEnv;

  constructor(env: ArtifactsEnv) {
    this.env = env;
  }

  /**
   * Creates a fresh repository for a project, and issues a 24-hour write token.
   */
  async createProjectRepo(projectId: string): Promise<{ repoId: string; remoteUrl: string; token: string }> {
    const repoName = `proj_${projectId}`;
    const repo = await this.env.AGENT_REPOS.create(repoName);
    let token = "";
    if (typeof repo.createWriteToken === "function") {
      token = await repo.createWriteToken(24 * 60 * 60);
    } else if (typeof repo.issueToken === "function") {
      const issued = await repo.issueToken({ permission: "write", ttlSeconds: 86400 });
      token = issued.token;
    }
    return {
      repoId: repo.id,
      remoteUrl: repo.remoteUrl || repo.remote || "",
      token,
    };
  }

  /**
   * Forks an existing repository and issues a 1-hour write token.
   */
  async createRepoFork(parentRepoName: string, forkSuffix: string): Promise<{ forkName: string; remoteUrl: string; token: string }> {
    const forkName = `${parentRepoName}_fork_${forkSuffix}`;
    let forkRepo: ArtifactsRepository;
    if (typeof this.env.AGENT_REPOS.fork === "function") {
      try {
        forkRepo = await this.env.AGENT_REPOS.fork({ source: parentRepoName, name: forkName });
      } catch {
        forkRepo = await this.env.AGENT_REPOS.fork(parentRepoName, forkName);
      }
    } else {
      const parentRepo = await this.env.AGENT_REPOS.get(parentRepoName);
      forkRepo = await parentRepo.fork!(forkName);
    }
    let token = "";
    if (typeof forkRepo.createWriteToken === "function") {
      token = await forkRepo.createWriteToken(1 * 60 * 60);
    } else if (typeof forkRepo.issueToken === "function") {
      const writeToken = await forkRepo.issueToken({ permission: "write", ttlSeconds: 3600 });
      token = writeToken.token;
    }
    return {
      forkName: forkRepo.name || forkName,
      remoteUrl: forkRepo.remoteUrl || forkRepo.remote || "",
      token,
    };
  }

  /**
   * Compares two repository states (HEAD commits) and returns a diff summary.
   */
  async generateCommitDiff(baseRepoName: string, forkRepoName: string): Promise<RepoDiffSummary> {
    if (this.env.AGENT_REPOS.compare) {
      const diff = await this.env.AGENT_REPOS.compare(baseRepoName, forkRepoName);
      return {
        additions: diff.additions,
        deletions: diff.deletions,
        changedFiles: diff.changedFiles,
      };
    }
    return { additions: 0, deletions: 0, changedFiles: [] };
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
      mergedCommit: result.mergedCommit || forkRepo.head,
    };
  }

  /**
   * Commits workspace changes into repository with given branch and message.
   */
  async commitWorkspace(opts: { repoName: string; branch: string; message: string }): Promise<any> {
    const repo = await this.env.AGENT_REPOS.get(opts.repoName);
    if (typeof repo.commit === "function") {
      return await repo.commit({
        branch: opts.branch,
        message: opts.message,
      });
    }
    return { ok: true };
  }

  /**
   * Fast-forwards or resets branch HEAD to target commit for Turn Time Machine.
   */
  async rollbackToTurnCommit(repoName: string, targetCommitSha: string, branch: string = "main"): Promise<{ ok: boolean; restoredCommit: string; branch: string }> {
    const repo = await this.env.AGENT_REPOS.get(repoName);
    await repo.fastForward(targetCommitSha);
    return { ok: true, restoredCommit: targetCommitSha, branch };
  }

  /**
   * Calculates how many commits a branch is behind upstream main,
   * and checks whether active files collide.
   */
  async getDivergenceStatus(repoName: string, branchName: string, baseBranch: string = "main"): Promise<BranchDivergenceStatus> {
    const baseRepo = await this.env.AGENT_REPOS.get(repoName);
    const branchRepo = await this.env.AGENT_REPOS.get(`${repoName}_fork_${branchName}`);

    let diff: any = { behindCount: 0, aheadCount: 0, hasConflict: false, conflicts: [], files: [] };
    if (this.env.AGENT_REPOS.compare) {
      diff = await this.env.AGENT_REPOS.compare({
        base: baseRepo.head,
        head: branchRepo.head,
      });
    }

    const changedFiles = (diff.files || []).map((f: any) => f.path || f);

    return {
      branchName,
      baseBranch,
      commitsBehind: diff.behindCount || 0,
      commitsAhead: diff.aheadCount || 0,
      baseHeadCommit: baseRepo.head,
      branchHeadCommit: branchRepo.head,
      hasConflict: diff.hasConflict || false,
      conflictingFiles: diff.conflicts || diff.conflictingFiles || [],
    };
  }

  /**
   * Rebase a feature branch onto main if no conflicting files exist.
   */
  async rebaseOntoMain(repoName: string, branchName: string): Promise<{ ok: boolean; rebased: boolean; reason?: string }> {
    const status = await this.getDivergenceStatus(repoName, branchName);

    if (status.commitsBehind === 0) {
      return { ok: true, rebased: false, reason: "Branch is already up to date with main." };
    }

    if (status.hasConflict || status.conflictingFiles.length > 0) {
      return {
        ok: false,
        rebased: false,
        reason: `Rebase collision detected on: ${status.conflictingFiles.join(", ")}. Manual review required.`,
      };
    }

    // Fast-forward rebase
    const branchRepo = await this.env.AGENT_REPOS.get(`${repoName}_fork_${branchName}`);
    await branchRepo.fastForward(status.baseHeadCommit);

    return { ok: true, rebased: true };
  }
}

