Here is the complete, single, fully-detailed, production-ready Markdown specification file for **Phase 5 — Chunk 04**: `specs/phase-5/chunk-04-atomic-task-leases-and-sibling-spectator.md`.

---

```markdown
---
chunk_id: "phase-5-chunk-04"
phase: 5
include_files:
  - workers/spaces/src/do/SpaceDO.ts
  - workers/agents/src/do/NaelaoAgentDO.ts
  - packages/types/src/index.ts
repomix_include:
  - "workers/spaces/src/do/SpaceDO.ts"
  - "workers/agents/src/do/NaelaoAgentDO.ts"
  - "packages/types/src/index.ts"
expected_outputs:
  - workers/spaces/src/do/SpaceDO.ts
  - workers/agents/src/do/NaelaoAgentDO.ts
  - packages/types/src/project-tasks.ts
  - packages/types/src/index.ts
---

# Phase 5 — Chunk 04: Atomic Task Leases, Sibling Spectator Mode & Multi-Assistant Governance

## 1. Executive Summary & Architectural Vision

When multiple employees (e.g. Alice and Bob) each possess a personal Space Assistant in a shared organization, a system incident at 03:00 AM or simultaneous user requests must not cause **multi-agent collisions**, **duplicate credit burn**, or **conflicting code patches**.

This chunk implements **Multi-Assistant Collision Governance**:
1. **Atomic Task Leases (CAS in SQLite):** Single-writer leases with a 15-minute crash-proof TTL. Only ONE assistant wins the right to execute a task; all others abort code generation immediately ($0 duplicate token spend).
2. **Sibling Spectator & Review Mode:** Non-claiming assistants transition into observers. Instead of generating duplicate code, they notify their user and offer to audit the active Pull Request.
3. **Semantic Intent Deduplication Gate:** An edge embedding check ($>0.85$ cosine similarity) intercepts duplicate requests submitted by different users before code generation starts.
4. **Sponsor Alignment Gate (RFC Trigger):** Contradictory architectural directives (e.g. Alice's assistant requesting Supabase Auth vs. Bob's assistant requesting Lucia Auth) freeze execution and surface an RFC discussion card in the Team Room.
5. **2-Round Deliberation Horizon:** Enforces a strict circuit breaker on assistant-to-assistant dialogue loops, transitioning runaway tasks to `BLOCKED_AWAITING_HUMAN`.

```
[ Incident / Feature Request Triggered in Shared Project ]
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. SEMANTIC DEDUPLICATION CHECK (Workers AI bge-small-en-v1.5)              │
│    Is another assistant already working on a >0.85 similarity task?         │
└──────────────────────────┬──────────────────────────────────────────────────┘
                           │ (No duplicate found)
                           ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 2. ATOMIC TASK LEASE CLAIM (SpaceDO.tasks SQLite CAS)                       │
├─────────────────────────────────────────────────────────────────────────────┤
│ • Alice's Assistant executes: `changes === 1` ──► LEASE GRANTED (Executes)  │
│ • Bob's Assistant executes 10ms later: `0`    ──► LEASE DENIED (Aborts)     │
└──────────────────────────┬──────────────────────────────────────────────────┘
                           │
         ┌─────────────────┴─────────────────┐
         ▼                                   ▼
┌──────────────────────────────────┐┌──────────────────────────────────┐
│ ALICE'S ASSISTANT (Claimer)      ││ BOB'S ASSISTANT (Spectator)      │
│ • Forks `branch:fix-task-042`.   ││ • Aborts LLM code generation.    │
│ • Writes patch in V8 sandbox.    ││ • Notifies Bob: "Alice's team is │
│ • Opens PR #18 for team review.  ││   fixing it. [ Audit PR Diff ]"  │
└──────────────────────────────────┘└──────────────────────────────────┘
```

---

## 2. Technical Specifications & File Implementation Contracts

### A. Define Task & Governance Types (`packages/types/src/project-tasks.ts`)

Create `packages/types/src/project-tasks.ts` and re-export in `packages/types/src/index.ts`:

```typescript
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
```

---

### B. Update `SpaceDO.ts` (SQLite Schema & Atomic Lease State Machine)

Update `workers/spaces/src/do/SpaceDO.ts` to implement single-writer atomic task leases and deliberation tracking:

```typescript
// 1. In SpaceDO.ensureInit(), create/update the project_tasks table:
/*
CREATE TABLE IF NOT EXISTS project_tasks (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLAIMED', 'IN_PROGRESS', 'IN_REVIEW', 'COMPLETED', 'BLOCKED_AWAITING_HUMAN', 'NEEDS_ALIGNMENT')),
  claimed_by_user_id TEXT,
  claimed_by_agent_id TEXT,
  branch_name TEXT,
  lease_expires_at TEXT,
  deliberation_round INTEGER NOT NULL DEFAULT 0,
  semantic_embedding_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pt_lookup ON project_tasks(project_id, status);
CREATE INDEX IF NOT EXISTS idx_pt_lease ON project_tasks(lease_expires_at);
*/

// 2. Implement Atomic Compare-And-Swap (CAS) Lease Claim:
export class SpaceDO extends DurableObject {
  /**
   * Attempts to claim a task lease atomically.
   * Succeeds only if the task is OPEN or its prior lease has expired (15-min crash TTL).
   */
  async claimTaskLease(params: {
    taskId: string;
    projectId: string;
    userId: string;
    agentId: string;
    branchName: string;
    ttlMinutes?: number;
  }): Promise<TaskLeaseClaimResult> {
    const ttl = params.ttlMinutes || 15;
    const now = new Date().toISOString();

    // Atomic CAS Update in DO SQLite
    const result = this.ctx.storage.sql.exec(`
      UPDATE project_tasks
      SET status = 'CLAIMED',
          claimed_by_user_id = ?,
          claimed_by_agent_id = ?,
          branch_name = ?,
          lease_expires_at = datetime('now', '+${ttl} minutes'),
          updated_at = datetime('now')
      WHERE id = ? 
        AND project_id = ?
        AND (status = 'OPEN' OR lease_expires_at < datetime('now'))
    `, params.userId, params.agentId, params.branchName, params.taskId, params.projectId);

    if (result.rowsWritten === 1) {
      return {
        granted: true,
        taskId: params.taskId,
        currentStatus: "CLAIMED",
        claimedByUserId: params.userId,
        claimedByAgentId: params.agentId,
        branchName: params.branchName
      };
    }

    // If lease failed, fetch current owner details for spectator routing
    const currentTask = this.ctx.storage.sql.exec(
      `SELECT * FROM project_tasks WHERE id = ?`,
      params.taskId
    ).toArray()[0] as any;

    return {
      granted: false,
      taskId: params.taskId,
      currentStatus: currentTask?.status || "IN_PROGRESS",
      claimedByUserId: currentTask?.claimed_by_user_id,
      claimedByAgentId: currentTask?.claimed_by_agent_id,
      branchName: currentTask?.branch_name,
      leaseExpiresAt: currentTask?.lease_expires_at
    };
  }

  /**
   * Increments the deliberation round on inter-agent reviews.
   * If deliberation exceeds 2 rounds, halts execution to prevent token burn.
   */
  async incrementDeliberationRound(taskId: string): Promise<{ blockedForHuman: boolean; round: number }> {
    const task = this.ctx.storage.sql.exec(
      `SELECT deliberation_round FROM project_tasks WHERE id = ?`,
      taskId
    ).toArray()[0] as any;

    const nextRound = (task?.deliberation_round || 0) + 1;

    if (nextRound > 2) {
      this.ctx.storage.sql.exec(`
        UPDATE project_tasks 
        SET status = 'BLOCKED_AWAITING_HUMAN', deliberation_round = ?, updated_at = datetime('now')
        WHERE id = ?
      `, nextRound, taskId);

      return { blockedForHuman: true, round: nextRound };
    }

    this.ctx.storage.sql.exec(`
      UPDATE project_tasks 
      SET deliberation_round = ?, updated_at = datetime('now')
      WHERE id = ?
    `, nextRound, taskId);

    return { blockedForHuman: false, round: nextRound };
  }

  /**
   * Releases or completes a task lease.
   */
  async completeTask(taskId: string, finalStatus: "COMPLETED" | "IN_REVIEW" = "COMPLETED") {
    this.ctx.storage.sql.exec(`
      UPDATE project_tasks
      SET status = ?, lease_expires_at = NULL, updated_at = datetime('now')
      WHERE id = ?
    `, finalStatus, taskId);
    return { ok: true, taskId, status: finalStatus };
  }

  /**
   * Retrieves all active tasks with their embeddings for semantic deduplication.
   */
  async listActiveTasksForProject(projectId: string) {
    return this.ctx.storage.sql.exec(`
      SELECT * FROM project_tasks 
      WHERE project_id = ? AND status IN ('OPEN', 'CLAIMED', 'IN_PROGRESS', 'NEEDS_ALIGNMENT')
      ORDER BY created_at DESC
    `, projectId).toArray() as any[];
  }
}
```

---

### C. Update `NaelaoAgentDO.ts` (Semantic Deduplication & Sponsor Alignment Gate)

Update `workers/agents/src/do/NaelaoAgentDO.ts` to evaluate semantic duplication and conflicting directives before creating tasks or branching:

```typescript
export class NaelaoAgentDO extends DurableObject {
  /**
   * Evaluates incoming user prompt against active tasks to prevent duplicate code branches.
   */
  async evaluateSemanticTaskDeduplication(
    projectId: string,
    userPrompt: string,
    callingUserId: string,
    spaceDoStub: any
  ): Promise<SemanticDeduplicationResult> {
    // 1. Compute prompt embedding using Workers AI bge-small-en-v1.5
    let queryEmbedding: number[] = [];
    try {
      const embedRes = await (this.env as any).AI.run("@cf/baai/bge-small-en-v1.5", {
        text: [userPrompt]
      });
      queryEmbedding = embedRes.data[0];
    } catch {
      // Degrade gracefully if embeddings unavailable
      return { isDuplicate: false };
    }

    // 2. Fetch active tasks from SpaceDO
    const activeTasks = await (await spaceDoStub.fetch(`http://internal/projects/${projectId}/tasks/active`)).json() as any[];

    // 3. Check for high semantic collision (Cosine Similarity > 0.85)
    for (const task of activeTasks) {
      if (!task.semantic_embedding_json) continue;
      const taskEmbedding = JSON.parse(task.semantic_embedding_json);
      const similarity = calculateCosineSimilarity(queryEmbedding, taskEmbedding);

      if (similarity > 0.85) {
        return {
          isDuplicate: true,
          existingTask: task,
          similarityScore: similarity,
          message: `Task already underway by user '${task.claimed_by_user_id}' on branch '${task.branch_name}'.`
        };
      }
    }

    return { isDuplicate: false };
  }

  /**
   * Detects contradictory architectural directives and triggers an RFC Alignment Gate.
   */
  async checkSponsorAlignment(
    newDirective: string,
    projectId: string,
    spaceDoStub: any
  ): Promise<{ hasConflict: boolean; rfcTitle?: string; conflictingDirectives?: string[] }> {
    const architecturalKeywords = ["auth", "database", "orm", "framework", "schema", "router", "state"];
    const isArchitectural = architecturalKeywords.some(kw => newDirective.toLowerCase().includes(kw));

    if (!isArchitectural) {
      return { hasConflict: false };
    }

    const activeTasks = await (await spaceDoStub.fetch(`http://internal/projects/${projectId}/tasks/active`)).json() as any[];
    const conflictingTask = activeTasks.find((t: any) => 
      architecturalKeywords.some(kw => t.title.toLowerCase().includes(kw) && t.title.toLowerCase() !== newDirective.toLowerCase())
    );

    if (conflictingTask) {
      return {
        hasConflict: true,
        rfcTitle: `RFC: Resolve Architectural Direction for ${projectId}`,
        conflictingDirectives: [conflictingTask.title, newDirective]
      };
    }

    return { hasConflict: false };
  }
}

function calculateCosineSimilarity(vecA: number[], vecB: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  return normA === 0 || normB === 0 ? 0 : dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}
```

---

## 3. Step-by-Step Implementation Instructions for the AI Runner

When applying this chunk:
1. Create `packages/types/src/project-tasks.ts` and re-export all types in `packages/types/src/index.ts`.
2. Update `workers/spaces/src/do/SpaceDO.ts`:
   - Initialize `project_tasks` table in SQLite with `deliberation_round` and lease constraints.
   - Implement `claimTaskLease`, `incrementDeliberationRound`, `completeTask`, and `listActiveTasksForProject`.
3. Update `workers/agents/src/do/NaelaoAgentDO.ts`:
   - Implement `evaluateSemanticTaskDeduplication` using `@cf/baai/bge-small-en-v1.5`.
   - Implement `checkSponsorAlignment` to freeze contradictory architectural directives.
4. Run `node --check` syntax checks across all modified files.
```
