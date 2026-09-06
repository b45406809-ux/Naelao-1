# Phase 1 — Chunk 05: Cloudflare Artifacts Git-for-Agents Service

## Objective
Implement the standalone `ArtifactsGitService.ts` and Cloudflare Artifacts bindings.

## Implementation Details

1. Update `workers/agents/wrangler.toml` and `workers/spaces/wrangler.toml`:
   - Add binding:
     ```toml
     [[artifacts]]
     binding = "AGENT_REPOS"
     namespace = "naelao-git-mesh"
     ```

2. Create `workers/agents/src/services/ArtifactsGitService.ts`:
   - Export interfaces: `ArtifactsRepository`, `ArtifactsEnv`, `RepoDiffSummary`.
   - Implement class `ArtifactsGitService`:
     * `createProjectRepo(projectId)`: Calls `env.AGENT_REPOS.create('proj_' + projectId)`, issues a 24h write token, returns `{ repoId, remoteUrl, token }`.
     * `createRepoFork(parentRepoName, forkSuffix)`: Calls `env.AGENT_REPOS.fork()`, issues a 1h write token, returns `{ forkName, remoteUrl, token }`.
     * `generateCommitDiff(baseRepoName, forkRepoName)`: Compares HEAD commits via `env.AGENT_REPOS.compare()`, returns additions, deletions, and changed files.
     * `fastForwardMerge(baseRepoName, forkRepoName)`: Calls `baseRepo.fastForward(forkRepo.head)`, returns `{ ok: true, mergedCommit }`.
