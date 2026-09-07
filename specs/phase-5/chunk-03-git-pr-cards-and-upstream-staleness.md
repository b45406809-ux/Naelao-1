Here is the complete, single, fully-detailed, production-ready Markdown specification file for **Phase 5 — Chunk 03**: `specs/phase-5/chunk-03-git-pr-cards-and-upstream-staleness.md`.

---

```markdown
---
chunk_id: "phase-5-chunk-03"
phase: 5
include_files:
  - workers/agents/src/services/ArtifactsGitService.ts
  - workers/spaces/src/do/SpaceDO.ts
  - packages/events/src/index.ts
  - packages/types/src/index.ts
repomix_include:
  - "workers/agents/src/services/ArtifactsGitService.ts"
  - "workers/spaces/src/do/SpaceDO.ts"
  - "packages/events/src/index.ts"
  - "packages/types/src/index.ts"
expected_outputs:
  - packages/types/src/pull-requests.ts
  - packages/types/src/index.ts
  - workers/agents/src/services/ArtifactsGitService.ts
  - workers/spaces/src/do/SpaceDO.ts
---

# Phase 5 — Chunk 03: Git PR Review Cards, Upstream Staleness & Model Races

## 1. Executive Summary & Architectural Vision

In collaborative, multi-player workspaces, code landing on the production `main` branch must never occur through untracked direct writes. Every feature or refactoring task executed by humans or functional agents in **Tier 2 Task Workstations** or **Tier 4 Private Scratchpads** commits to an isolated Git branch on **Cloudflare Artifacts (Zig-to-WASM Git in Durable Objects)**.

This chunk implements the **Pull Request & Branch Reconciliation Engine**:
1. **Interactive Pull Request Review Cards:** When an agent finishes a task, it compiles an AST diff manifest and opens a Pull Request. The Tier 1 Team Room renders an interactive review card displaying changed files, additions/deletions, and one-click fast-forward merge buttons.
2. **Upstream Staleness & AI Auto-Rebase Engine:** Branches track real-time divergence (`commitsBehind`). When `main` advances, agents evaluate upstream changes: if non-overlapping, they auto-rebase; if overlapping, they pause and request human review.
3. **Multi-Branch Parallel Model Benchmarking Races:** For ambiguous or high-complexity tasks, the system creates 3 instant zero-copy branch forks in parallel (e.g. for Claude 3.7, Llama 3.3, Qwen 2.5), executes the test suite on each, and presents the winning branch's PR to the team room.

```
                                  ┌──────────────────────────────────────────────┐
                                  │      CLOUDFLARE ARTIFACTS REPOSITORY MESH    │
                                  │   (Zig-to-WASM Git Engine in Durable Object) │
                                  └──────────────────────┬───────────────────────┘
                                                         │
                         ┌───────────────────────────────┴───────────────────────────────┐
                         ▼                                                               ▼
┌─────────────────────────────────────────────────────────────┐   ┌─────────────────────────────────────────────────────────────┐
│ 🌿 MAIN WORKSPACE REPO (`proj_dev_main`)                    │   │ 🌿 FEATURE BRANCH FORK (`proj_dev_fork_task_102`)           │
│ • Production codebase / live edge preview HEAD.             │   │ • Scoped to Task #102 in Tier 2 Workstation.                │
│ • Protected: Direct writes locked in multi-player mode.     │   │ • Agent executes AST edits, runs tests, commits in sandbox. │
└──────────────────────────────┬──────────────────────────────┘   └──────────────────────────────┬──────────────────────────────┘
                               │                                                                 │
                               │                        [ Agent Pushes & Creates PR Proposal ] ──┘
                               ▼                                                                 │
┌────────────────────────────────────────────────────────────────────────────────────────────────▼──────────────────────────────┐
│ 📬 TIER 1 TEAM ROOM: INLINE PR REVIEW CARD                                                                                    │
│ ├── 📌 **PR #14: "Refactor Stripe Webhook Signature Check"** (by @DevOperator on `branch:task_102`)                           │
│ ├── 🤖 **AI Rationale:** "Replaced insecure query check with crypto.subtle HMAC verification. All 8 tests passed."           │
│ ├── 🔍 **Git Diff:** `git diff main..task_102` [ +14 lines / -3 lines ]                                                      │
│ └── 🔘 **Reviewer Actions:** `[ ✅ Accept & Merge to Main ]`   `[ 💬 Request Revisions ]`   `[ ❌ Reject ]`                   │
└────────────────────────────────────────────────────────────────────────────────────────────────┬──────────────────────────────┘
                                                                                                 │ (Reviewer clicks Accept)
                                                                                                 ▼
┌───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ ATOMIC FAST-FORWARD MERGE: `baseRepo.fastForward(forkRepo.head)`                                                              │
│ • WsHubDO broadcasts `workspace.merged` ──► Live Workspace Canvas hot-reloads in 150ms!                                       │
└───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Technical Specifications & Data Contracts

### A. Define Pull Request Types (`packages/types/src/pull-requests.ts`)
Create `packages/types/src/pull-requests.ts` and re-export in `packages/types/src/index.ts`:

```typescript
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
```

---

## 3. Database Schema in `SpaceDO.ts` SQLite

Inside `workers/spaces/src/do/SpaceDO.ts`, ensure `ensureInit()` executes the `pull_requests` table DDL:

```sql
-- Pull Requests & Proposed Changes Table in SpaceDO SQLite
CREATE TABLE IF NOT EXISTS pull_requests (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  source_branch TEXT NOT NULL,
  target_branch TEXT NOT NULL DEFAULT 'main',
  title TEXT NOT NULL,
  reasoning_summary TEXT NOT NULL,
  diff_manifest_json TEXT NOT NULL,
  total_additions INTEGER NOT NULL DEFAULT 0,
  total_deletions INTEGER NOT NULL DEFAULT 0,
  author_user_id TEXT,
  author_agent_id TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'MERGED', 'REJECTED', 'CHANGES_REQUESTED')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  merged_at TEXT,
  merged_by_user_id TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pr_lookup ON pull_requests(project_id, status);
CREATE INDEX IF NOT EXISTS idx_pr_branch ON pull_requests(project_id, source_branch);
```

---

## 4. Implementation Requirements

### A. Update `workers/spaces/src/do/SpaceDO.ts`

Implement the complete Pull Request lifecycle methods:

```typescript
import { PullRequestRecord, FileDiffEntry } from "@naelao/types";

export class SpaceDO extends DurableObject {
  // ... existing SpaceDO implementation ...

  /**
   * Opens a new Pull Request comparing a feature/task branch against main.
   */
  async createPullRequest(params: {
    projectId: string;
    sourceBranch: string;
    targetBranch?: string;
    title: string;
    reasoningSummary: string;
    authorUserId?: string;
    authorAgentId?: string;
  }): Promise<{ ok: boolean; pullRequest: PullRequestRecord }> {
    const prId = `pr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const targetBranch = params.targetBranch || "main";

    // 1. Fetch file trees from DO SQLite workspace_files for source and target branches
    const sourceFiles = this.ctx.storage.sql.exec(
      "SELECT path, content, hash FROM workspace_files WHERE branch = ?",
      params.sourceBranch
    ).toArray() as Array<{ path: string; content: string; hash: string }>;

    const targetFiles = this.ctx.storage.sql.exec(
      "SELECT path, content, hash FROM workspace_files WHERE branch = ?",
      targetBranch
    ).toArray() as Array<{ path: string; content: string; hash: string }>;

    const targetMap = new Map(targetFiles.map(f => [f.path, f]));
    const diffManifest: FileDiffEntry[] = [];
    let totalAdditions = 0;
    let totalDeletions = 0;

    for (const src of sourceFiles) {
      const tgt = targetMap.get(src.path);
      if (!tgt) {
        // Newly created file
        const lines = src.content.split("\n").length;
        diffManifest.push({
          path: src.path,
          status: "CREATED",
          additions: lines,
          deletions: 0,
          patch: `+ [New File: ${lines} lines]`,
          newContent: src.content
        });
        totalAdditions += lines;
      } else if (tgt.hash !== src.hash) {
        // Modified file
        const srcLines = src.content.split("\n");
        const tgtLines = tgt.content.split("\n");
        const added = Math.max(0, srcLines.length - tgtLines.length);
        const deleted = Math.max(0, tgtLines.length - srcLines.length);
        diffManifest.push({
          path: src.path,
          status: "MODIFIED",
          additions: added || 1,
          deletions: deleted || 0,
          patch: `@@ -1,${tgtLines.length} +1,${srcLines.length} @@`,
          oldContent: tgt.content,
          newContent: src.content
        });
        totalAdditions += (added || 1);
        totalDeletions += (deleted || 0);
      }
    }

    // Check for deleted files
    const sourceMap = new Map(sourceFiles.map(f => [f.path, f]));
    for (const tgt of targetFiles) {
      if (!sourceMap.has(tgt.path)) {
        const lines = tgt.content.split("\n").length;
        diffManifest.push({
          path: tgt.path,
          status: "DELETED",
          additions: 0,
          deletions: lines,
          patch: `- [Deleted File: ${lines} lines]`,
          oldContent: tgt.content
        });
        totalDeletions += lines;
      }
    }

    // 2. Insert Pull Request Record into SQLite
    this.ctx.storage.sql.exec(
      `INSERT INTO pull_requests (
        id, space_id, project_id, source_branch, target_branch,
        title, reasoning_summary, diff_manifest_json, total_additions,
        total_deletions, author_user_id, author_agent_id, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN')`,
      prId,
      this.spaceId,
      params.projectId,
      params.sourceBranch,
      targetBranch,
      params.title,
      params.reasoningSummary,
      JSON.stringify(diffManifest),
      totalAdditions,
      totalDeletions,
      params.authorUserId || null,
      params.authorAgentId || null
    );

    const prRecord: PullRequestRecord = {
      id: prId,
      spaceId: this.spaceId,
      projectId: params.projectId,
      sourceBranch: params.sourceBranch,
      targetBranch,
      title: params.title,
      reasoningSummary: params.reasoningSummary,
      diffManifest,
      totalAdditions,
      totalDeletions,
      authorUserId: params.authorUserId,
      authorAgentId: params.authorAgentId,
      status: "OPEN",
      createdAt: new Date().toISOString()
    };

    return { ok: true, pullRequest: prRecord };
  }

  /**
   * Atomically merges an approved Pull Request into main workspace files.
   */
  async mergePullRequest(prId: string, mergedByUserId: string): Promise<{ ok: boolean; message: string }> {
    const pr = this.ctx.storage.sql.exec(
      "SELECT * FROM pull_requests WHERE id = ? AND status = 'OPEN'",
      prId
    ).toArray()[0] as any;

    if (!pr) {
      throw new Error(`Pull Request '${prId}' not found or already merged/closed.`);
    }

    // Atomic transaction: copy branch files to target_branch (main) and update status
    this.ctx.storage.transactionSync(() => {
      // 1. Delete target branch files that were removed in source branch
      const sourceFiles = this.ctx.storage.sql.exec(
        "SELECT path FROM workspace_files WHERE branch = ?",
        pr.source_branch
      ).toArray() as Array<{ path: string }>;
      const sourcePaths = new Set(sourceFiles.map(f => f.path));

      const targetFiles = this.ctx.storage.sql.exec(
        "SELECT path FROM workspace_files WHERE branch = ?",
        pr.target_branch
      ).toArray() as Array<{ path: string }>;

      for (const tgt of targetFiles) {
        if (!sourcePaths.has(tgt.path)) {
          this.ctx.storage.sql.exec(
            "DELETE FROM workspace_files WHERE branch = ? AND path = ?",
            pr.target_branch,
            tgt.path
          );
        }
      }

      // 2. Overwrite / insert source files into target branch
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO workspace_files (branch, path, content, hash, size_bytes, updated_at)
         SELECT ?, path, content, hash, size_bytes, datetime('now')
         FROM workspace_files WHERE branch = ?`,
        pr.target_branch,
        pr.source_branch
      );

      // 3. Mark PR as MERGED
      this.ctx.storage.sql.exec(
        "UPDATE pull_requests SET status = 'MERGED', merged_at = datetime('now'), merged_by_user_id = ? WHERE id = ?",
        mergedByUserId,
        prId
      );
    });

    return { ok: true, message: `Successfully merged PR #${prId} into ${pr.target_branch}.` };
  }

  /**
   * List Pull Requests for a project.
   */
  async listPullRequests(projectId: string, status?: string): Promise<PullRequestRecord[]> {
    const sql = status
      ? "SELECT * FROM pull_requests WHERE project_id = ? AND status = ? ORDER BY created_at DESC"
      : "SELECT * FROM pull_requests WHERE project_id = ? ORDER BY created_at DESC";
    
    const rows = status
      ? this.ctx.storage.sql.exec(sql, projectId, status).toArray()
      : this.ctx.storage.sql.exec(sql, projectId).toArray();

    return rows.map((r: any) => ({
      id: r.id,
      spaceId: r.space_id,
      projectId: r.project_id,
      sourceBranch: r.source_branch,
      targetBranch: r.target_branch,
      title: r.title,
      reasoningSummary: r.reasoning_summary,
      diffManifest: JSON.parse(r.diff_manifest_json || "[]"),
      totalAdditions: r.total_additions,
      totalDeletions: r.total_deletions,
      authorUserId: r.author_user_id,
      authorAgentId: r.author_agent_id,
      status: r.status,
      createdAt: r.created_at,
      mergedAt: r.merged_at,
      mergedByUserId: r.merged_by_user_id
    }));
  }
}
```

---

### B. Update `workers/agents/src/services/ArtifactsGitService.ts`

Add upstream divergence calculation and automated rebasing logic:

```typescript
import { BranchDivergenceStatus, RepoDiffSummary } from "@naelao/types";

export class ArtifactsGitService {
  constructor(private env: any) {}

  // ... existing methods (createProjectRepo, createRepoFork) ...

  /**
   * Calculates how many commits a branch is behind upstream main,
   * and checks whether active files collide.
   */
  async getDivergenceStatus(repoName: string, branchName: string, baseBranch: string = "main"): Promise<BranchDivergenceStatus> {
    const baseRepo = await this.env.AGENT_REPOS.get(repoName);
    const branchRepo = await this.env.AGENT_REPOS.get(`${repoName}_fork_${branchName}`);

    // Compare base with branch
    const diff = await this.env.AGENT_REPOS.compare({
      base: baseRepo.head,
      head: branchRepo.head
    });

    const changedFiles = diff.files.map((f: any) => f.path);

    return {
      branchName,
      baseBranch,
      commitsBehind: diff.behindCount || 0,
      commitsAhead: diff.aheadCount || 0,
      baseHeadCommit: baseRepo.head,
      branchHeadCommit: branchRepo.head,
      hasConflict: diff.hasConflict || false,
      conflictingFiles: diff.conflicts || []
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
        reason: `Rebase collision detected on: ${status.conflictingFiles.join(", ")}. Manual review required.`
      };
    }

    // Fast-forward rebase
    const branchRepo = await this.env.AGENT_REPOS.get(`${repoName}_fork_${branchName}`);
    await branchRepo.fastForward(status.baseHeadCommit);

    return { ok: true, rebased: true };
  }
}
```

---

## 5. Step-by-Step Implementation Instructions for the AI Runner

When applying this chunk:
1. Create `packages/types/src/pull-requests.ts` and re-export its types in `packages/types/src/index.ts`.
2. Update `workers/spaces/src/do/SpaceDO.ts`:
   - Add the `pull_requests` table DDL in `ensureInit()`.
   - Implement `createPullRequest()`, `mergePullRequest()`, and `listPullRequests()`.
3. Update `workers/agents/src/services/ArtifactsGitService.ts`:
   - Implement `getDivergenceStatus()` and `rebaseOntoMain()`.
4. Run `node --check` syntax checks across modified files to verify strict TypeScript and Cloudflare runtime compliance.
```
