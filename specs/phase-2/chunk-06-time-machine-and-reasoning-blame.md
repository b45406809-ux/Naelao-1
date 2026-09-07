Here is the complete, single, fully-detailed, production-ready Markdown specification file for **Phase 2 — Chunk 06**: `specs/phase-2/chunk-06-time-machine-and-reasoning-blame.md`.

---

```markdown
---
chunk_id: "phase-2-chunk-06"
phase: 2
include_files:
  - workers/agents/src/script-engine/loop.ts
  - workers/agents/src/services/ArtifactsGitService.ts
  - workers/agents/src/do/NaelaoAgentDO.ts
repomix_include:
  - "workers/agents/src/script-engine/loop.ts"
  - "workers/agents/src/services/ArtifactsGitService.ts"
  - "workers/agents/src/do/NaelaoAgentDO.ts"
expected_outputs:
  - workers/agents/src/script-engine/loop.ts
  - workers/agents/src/services/ArtifactsGitService.ts
---

# Phase 2 — Chunk 06: Turn-by-Turn Time Machine & Reasoning Git Blame

## 1. Executive Summary & Architectural Vision

To give users complete auditability and instant recovery when an agent makes a mistake, **every tool turn creates an immutable commit in Cloudflare Artifacts**.

```
Thread Timeline in UI:
├── Message 1 (User): "Add Stripe checkout"
├── Turn 1 (Agent): Scaffolds `stripe.ts`   ──► 🏷️ Commit `t1-scaffold` [⏪ Rollback]
├── Turn 2 (Agent): Adds webhook handler   ──► 🏷️ Commit `t2-webhook`  [⏪ Rollback]
└── Turn 3 (Agent): Broken CSS patch       ──► 🏷️ Commit `t3-css-bug`  [⏪ Rollback]
```

### Reasoning-Aware Git Blame
Every automated commit stores structured **Reasoning Front-Matter** in the Git commit message. This allows developers and other agents to audit *why* a piece of code was written by inspecting git history:
```yaml
feat: add mutual indemnification clause in Section 4.2

--AVOS-METADATA--
author: "@LegalAgent"
goal: "Review MSA for Delaware compliance"
rationale: "Delaware Code § 145 limits unilateral indemnification for directors."
task_id: "task_402"
timestamp: "2026-09-07T02:40:00.000Z"
```

---

## 2. Technical Specifications & File Implementation Contracts

### A. Update `workers/agents/src/script-engine/loop.ts`
Automatically commit workspace state at the conclusion of every tool turn.

```typescript
import { ArtifactsGitService } from "../services/ArtifactsGitService";

export interface TurnCommitContext {
  artifactsGit: ArtifactsGitService;
  repoName: string;
  branch: string;
  turnIndex: number;
  agentRole: string;
  goal: string;
  rationale: string;
  taskId?: string;
}

/**
 * Commits current workspace state into Cloudflare Artifacts (Zig-WASM Git in DO)
 * with structured reasoning metadata after an agent completes a turn.
 */
export async function commitTurnState(ctx: TurnCommitContext) {
  const commitMessage = `turn(${ctx.turnIndex}): ${ctx.goal.slice(0, 50)}

--AVOS-METADATA--
author: "${ctx.agentRole}"
goal: "${ctx.goal}"
rationale: "${ctx.rationale}"
task_id: "${ctx.taskId || "none"}"
timestamp: "${new Date().toISOString()}"
`;

  try {
    const repo = await (ctx.artifactsGit as any).env.AGENT_REPOS.get(ctx.repoName);
    // Stage all changes in workspace and commit
    return await repo.commit({
      branch: ctx.branch,
      message: commitMessage
    });
  } catch (err: any) {
    console.warn(`⚠️ Failed to commit turn state to Artifacts: ${err.message}`);
    return { ok: false, error: err.message };
  }
}
```

---

### B. Update `workers/agents/src/services/ArtifactsGitService.ts`

Add rollback and commit helper methods to `ArtifactsGitService`:

```typescript
export class ArtifactsGitService {
  constructor(private env: any) {}

  async createProjectRepo(projectId: string) {
    const repoName = `proj_${projectId}`;
    const repo = await this.env.AGENT_REPOS.create(repoName);
    const token = await repo.issueToken({ permission: "write", ttlSeconds: 86400 });
    return { repoId: repo.id, remoteUrl: repo.remote, token: token.token };
  }

  async createRepoFork(parentRepoName: string, forkSuffix: string) {
    const forkName = `${parentRepoName}_fork_${forkSuffix}`;
    const fork = await this.env.AGENT_REPOS.fork({ source: parentRepoName, name: forkName });
    const writeToken = await fork.issueToken({ permission: "write", ttlSeconds: 3600 });
    return { forkName, remoteUrl: fork.remote, token: writeToken.token };
  }

  async commitWorkspace(opts: { repoName: string; branch: string; message: string }) {
    const repo = await this.env.AGENT_REPOS.get(opts.repoName);
    return await repo.commit({
      branch: opts.branch,
      message: opts.message
    });
  }

  async rollbackToTurnCommit(repoName: string, targetCommitSha: string, branch: string = "main") {
    const repo = await this.env.AGENT_REPOS.get(repoName);
    // Fast-forward or reset branch HEAD to target commit for Turn Time Machine
    await repo.fastForward(targetCommitSha);
    return { ok: true, restoredCommit: targetCommitSha, branch };
  }
}
```

---

## 3. Step-by-Step Implementation Instructions for the AI Runner

When applying this chunk:
1. Update `workers/agents/src/script-engine/loop.ts` to call `commitTurnState` after successful tool turns.
2. Update `workers/agents/src/services/ArtifactsGitService.ts` to include `commitWorkspace` and `rollbackToTurnCommit`.
3. Run `node --check` syntax checks across modified files to ensure strict TypeScript compliance.
```
