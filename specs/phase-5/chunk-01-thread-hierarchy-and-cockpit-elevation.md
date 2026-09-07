Here is the complete, single, fully-detailed, production-ready Markdown specification file for **Phase 5 — Chunk 01**: `specs/phase-5/chunk-01-thread-hierarchy-and-cockpit-elevation.md`.

---

```markdown
---
chunk_id: "phase-5-chunk-01"
phase: 5
include_files:
  - workers/spaces/src/do/SpaceDO.ts
  - workers/spaces/src/index.ts
  - packages/types/src/index.ts
repomix_include:
  - "workers/spaces/src/do/SpaceDO.ts"
  - "workers/spaces/src/index.ts"
  - "packages/types/src/index.ts"
expected_outputs:
  - workers/spaces/src/do/SpaceDO.ts
  - workers/spaces/src/index.ts
  - packages/types/src/threads.ts
  - packages/types/src/index.ts
---

# Phase 5 — Chunk 01: 4-Tier Thread Hierarchy & Cockpit Dynamic Elevation

## 1. Executive Summary & Architectural Vision

Traditional AI applications force all interactions into a flat list of disconnected chat sessions. In multi-player, multi-agent workspaces, this creates **thread sprawl, accidental race conditions, and context contamination**.

AVOS introduces a structured **4-Tier Thread Hierarchy** enforced at the `SpaceDO` Durable Object SQLite storage layer:

```
┌───────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                    THE 4-TIER THREAD HIERARCHY                                            │
├────────────────────┬─────────────────────────┬────────────────────────────┬───────────────────────────────┤
│ Tier Level         │ Audience & Visibility   │ Multi-Player Interaction   │ Workspace Write Permissions   │
├────────────────────┼─────────────────────────┼────────────────────────────┼───────────────────────────────┤
│ **Tier 1: Team**   │ **Public to Project**   │ Humans chat freely;        │ **Branch / PR Only:**         │
│ **Room**           │ (All team members)      │ Agents answer on `@mention`│ Direct writes blocked; writes │
│                    │                         │ or `/goal` commands.       │ merge via Pull Request cards. │
├────────────────────┼─────────────────────────┼────────────────────────────┼───────────────────────────────┤
│ **Tier 2: Task**   │ **Public to Project**   │ Focused on 1 Feature / DAG │ **OCC Patches on Branch:**    │
│ **Workstation**    │ (All team members)      │ Milestone; teammates +     │ Hash-verified writes scoped   │
│                    │                         │ assigned functional agents.│ to dedicated Git branch ref.  │
├────────────────────┼─────────────────────────┼────────────────────────────┼───────────────────────────────┤
│ **Tier 3: System** │ **Internal Background** │ Sub-agent coordination &   │ **Coordination Only:**        │
│ **Consult Lane**   │ (Collapsed/Hidden in UI)│ handoffs (Architect to Dev,│ Updates Task DAG status and   │
│                    │                         │ Dev to Reviewer).          │ Project Journal state.        │
├────────────────────┼─────────────────────────┼────────────────────────────┼───────────────────────────────┤
│ **Tier 4: Private**│ **Strictly Private**    │ 1-on-1 between User & Agent│ **Read-Only / Simulation:**   │
│ **Scratchpad**     │ (Creator user only)     │ Personal ideation, drafting│ Direct repo writes blocked.   │
│                    │                         │ with personal connectors.  │ Promotes via Pull Request.    │
└────────────────────┴─────────────────────────┴────────────────────────────┴───────────────────────────────┘
```

### The Cockpit vs. Digital Office Dynamic Elevation Model
* **Solo Mode (1 Human Founder):** When a project has $\le 1$ human member in `project_members`, the UI operates as a streamlined **2-Tier Cockpit**. Tiers 3 and 4 are hidden. The founder talks naturally in Command Chat (no `@mentions` needed); changes commit directly to `main` and hot-reload the live canvas in 150ms.
* **Team Mode (2+ Humans):** When an additional teammate is invited (`project_members.length >= 2`), the project **dynamically elevates** to the full **4-Tier Digital Office**. Direct commits to `main` are locked, branch micro-forking is enforced, and changes require Pull Request review cards.

```
                  ┌──────────────────────────────────────────────┐
                  │    PROJECT MEMBER COUNT CHECK (SpaceDO)      │
                  └──────────────────────┬───────────────────────┘
                                         │
        ┌────────────────────────────────┴────────────────────────────────┐
        ▼ (project_members <= 1)                                          ▼ (project_members >= 2)
┌───────────────────────────────────────┐ ┌───────────────────────────────────────┐
│ 🚀 SOLO 2-TIER COCKPIT                │ │ 🏢 MULTI-USER 4-TIER DIGITAL OFFICE   │
│ • Tiers 3 & 4 hidden.                 │ │ • Full 4-tier hierarchy active.       │
│ • Direct writes to `main` enabled.    │ │ • Direct writes to `main` locked.     │
│ • Zero `@mentions` required.          │ │ • Enforces Git branches & PR cards.   │
│ • Fast, fluid builder flow.           │ │ • Isolated Tier 4 private scratchpads.│
└───────────────────────────────────────┘ └───────────────────────────────────────┘
```

---

## 2. Technical Specifications & File Implementation Contracts

### A. Create `packages/types/src/threads.ts`

Define the canonical TypeScript interfaces for thread tiers, thread kinds, and project elevation state:

```typescript
export type ThreadTier = 1 | 2 | 3 | 4;

export type ThreadKind =
  | "team_room"           // Tier 1: Main public collaborative channel
  | "task_workstation"    // Tier 2: Feature/DAG sprint thread bound to a Git branch
  | "system_consult"      // Tier 3: Collapsed background sub-agent coordination
  | "private_scratchpad"  // Tier 4: Personal 1-on-1 simulation sandbox
  | "heartbeat_wake"      // System: Scheduled cron background session
  | "voice_call";         // Telephony: Inbound/outbound phone call transcript

export interface AvosThread {
  id: string;
  spaceId: string;
  projectId: string;
  tier: ThreadTier;
  threadKind: ThreadKind;
  title: string;
  boundBranchName?: string;
  associatedTaskId?: string;
  sessionId?: string;
  parentThreadId?: string;
  isSimulationOnly: boolean; // True for Tier 4 scratchpads
  createdByUserId: string;
  status: "active" | "archived" | "completed";
  metadataJson: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateThreadParams {
  projectId: string;
  title: string;
  tier?: ThreadTier;
  threadKind?: ThreadKind;
  boundBranchName?: string;
  associatedTaskId?: string;
  sessionId?: string;
  parentThreadId?: string;
  isSimulationOnly?: boolean;
  createdByUserId: string;
  metadata?: Record<string, any>;
}

export interface ListThreadsQuery {
  projectId: string;
  tier?: ThreadTier;
  threadKind?: ThreadKind;
  parentThreadId?: string;
  includeArchived?: boolean;
  includeSystem?: boolean; // If false, hides Tier 3 system_consult and heartbeat_wake
  callerUserId: string;
}

export interface ThreadElevationStatus {
  projectId: string;
  isCockpitMode: boolean; // True if human member count <= 1
  memberCount: number;
  directMainWritesAllowed: boolean;
  activeTiers: ThreadTier[];
}
```

Re-export `packages/types/src/threads.ts` in `packages/types/src/index.ts`:
```typescript
export * from "./threads";
```

---

### B. Update `workers/spaces/src/do/SpaceDO.ts` (Durable Object Schema & Handlers)

Extend `SpaceDO.ts` SQLite storage to natively support thread tiers, simulation flags, and elevation calculations.

#### 1. SQLite Schema Migration (inside `ensureInit()`):
Ensure the `threads` table carries the complete tier and provenance columns:

```sql
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  tier INTEGER NOT NULL DEFAULT 1,
  thread_kind TEXT NOT NULL DEFAULT 'team_room',
  title TEXT NOT NULL,
  bound_branch_name TEXT,
  associated_task_id TEXT,
  session_id TEXT,
  parent_thread_id TEXT,
  is_simulation_only INTEGER NOT NULL DEFAULT 0,
  created_by_user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'completed')),
  metadata_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_threads_proj_tier ON threads(project_id, tier, status);
CREATE INDEX IF NOT EXISTS idx_threads_creator_kind ON threads(created_by_user_id, thread_kind);
CREATE INDEX IF NOT EXISTS idx_threads_session ON threads(session_id);
CREATE INDEX IF NOT EXISTS idx_threads_parent ON threads(parent_thread_id);
```

#### 2. Implement `createThread` Handler:
```typescript
async createThread(params: CreateThreadParams): Promise<AvosThread> {
  const threadId = `th_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const tier = params.tier ?? (params.threadKind === "private_scratchpad" ? 4 : params.threadKind === "task_workstation" ? 2 : params.threadKind === "system_consult" ? 3 : 1);
  const threadKind = params.threadKind ?? (tier === 4 ? "private_scratchpad" : tier === 2 ? "task_workstation" : tier === 3 ? "system_consult" : "team_room");
  const isSimulationOnly = tier === 4 ? 1 : (params.isSimulationOnly ? 1 : 0);

  this.ctx.storage.sql.exec(`
    INSERT INTO threads (
      id, space_id, project_id, tier, thread_kind, title,
      bound_branch_name, associated_task_id, session_id, parent_thread_id,
      is_simulation_only, created_by_user_id, status, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, datetime('now'), datetime('now'))
  `,
    threadId,
    this.spaceId,
    params.projectId,
    tier,
    threadKind,
    params.title,
    params.boundBranchName ?? null,
    params.associatedTaskId ?? null,
    params.sessionId ?? null,
    params.parentThreadId ?? null,
    isSimulationOnly,
    params.createdByUserId,
    JSON.stringify(params.metadata ?? {})
  );

  return this.getThread(threadId);
}
```

#### 3. Implement `listThreads` with Privacy and Elevation Filtering:
```typescript
async listThreads(query: ListThreadsQuery): Promise<AvosThread[]> {
  const includeSystem = query.includeSystem ?? false;
  const includeArchived = query.includeArchived ?? false;

  let sql = `
    SELECT * FROM threads 
    WHERE space_id = ? AND project_id = ?
  `;
  const binds: any[] = [this.spaceId, query.projectId];

  if (!includeArchived) {
    sql += ` AND status = 'active'`;
  }

  if (query.tier) {
    sql += ` AND tier = ?`;
    binds.push(query.tier);
  }

  if (query.threadKind) {
    sql += ` AND thread_kind = ?`;
    binds.push(query.threadKind);
  }

  if (query.parentThreadId) {
    sql += ` AND parent_thread_id = ?`;
    binds.push(query.parentThreadId);
  }

  // Tier 4 Privacy Rule: Users can ONLY see their own private scratchpads
  sql += ` AND (tier != 4 OR created_by_user_id = ?)`;
  binds.push(query.callerUserId);

  // Tier 3 System Consult Rule: Hidden unless explicitly requested
  if (!includeSystem) {
    sql += ` AND thread_kind NOT IN ('system_consult', 'heartbeat_wake')`;
  }

  sql += ` ORDER BY created_at DESC`;

  const rows = this.ctx.storage.sql.exec(sql, ...binds).toArray();
  return rows.map(r => this.mapThreadRow(r));
}
```

#### 4. Implement `getProjectElevationStatus`:
```typescript
async getProjectElevationStatus(projectId: string): Promise<ThreadElevationStatus> {
  // Query human member count in project
  const memberCountRow = this.ctx.storage.sql.exec(`
    SELECT COUNT(*) as count FROM project_members WHERE project_id = ?
  `, projectId).toArray()[0] as { count: number };

  const memberCount = memberCountRow ? memberCountRow.count : 0;
  const isCockpitMode = memberCount <= 1;

  return {
    projectId,
    isCockpitMode,
    memberCount,
    directMainWritesAllowed: isCockpitMode,
    activeTiers: isCockpitMode ? [1, 2] : [1, 2, 3, 4]
  };
}
```

---

### C. Update `workers/spaces/src/index.ts` (API Routes & Gating)

Mount the elevation and thread endpoints in the spaces worker router:

```typescript
// 1. Check Project Elevation Mode
app.get("/spaces/:spaceId/projects/:projectId/elevation-status", async (c) => {
  const { spaceId, projectId } = c.req.param();
  const spaceDO = await spaceDoStub(c.env, spaceId);
  const status = await (await forwardToSpaceDO(spaceDO, `/projects/${projectId}/elevation-status`, "GET")).json();
  return c.json({ ok: true, elevation: status });
});

// 2. List Threads with 4-Tier & Privacy Filtering
app.get("/spaces/:spaceId/projects/:projectId/threads", async (c) => {
  const { spaceId, projectId } = c.req.param();
  const caller = getCallerIdentity(c);
  const tier = c.req.query("tier") ? parseInt(c.req.query("tier")!, 10) : undefined;
  const threadKind = c.req.query("thread_kind") as any;
  const includeSystem = c.req.query("include_system") === "true";
  const parentThreadId = c.req.query("parent_thread_id");

  const spaceDO = await spaceDoStub(c.env, spaceId);
  const queryPayload = {
    projectId,
    tier,
    threadKind,
    parentThreadId,
    includeSystem,
    callerUserId: caller.userId
  };

  const response = await forwardToSpaceDO(spaceDO, `/projects/${projectId}/threads/list`, "POST", queryPayload);
  return c.json(await response.json());
});

// 3. Create Thread
app.post("/spaces/:spaceId/projects/:projectId/threads", async (c) => {
  const { spaceId, projectId } = c.req.param();
  const caller = getCallerIdentity(c);
  const body = await c.req.json();

  const spaceDO = await spaceDoStub(c.env, spaceId);
  const threadParams = {
    projectId,
    title: body.title,
    tier: body.tier,
    threadKind: body.threadKind,
    boundBranchName: body.boundBranchName,
    associatedTaskId: body.associatedTaskId,
    sessionId: body.sessionId,
    parentThreadId: body.parentThreadId,
    isSimulationOnly: body.isSimulationOnly,
    createdByUserId: caller.userId,
    metadata: body.metadata
  };

  const response = await forwardToSpaceDO(spaceDO, `/projects/${projectId}/threads/create`, "POST", threadParams);
  return c.json(await response.json(), 201);
});
```

---

## 3. Step-by-Step Implementation Checklist for the AI Runner

When executing this chunk:
1. Create `packages/types/src/threads.ts` with all types (`ThreadTier`, `ThreadKind`, `AvosThread`, `ThreadElevationStatus`).
2. Re-export `packages/types/src/threads.ts` inside `packages/types/src/index.ts`.
3. In `workers/spaces/src/do/SpaceDO.ts`:
   - Add SQLite `threads` schema migrations with tier, simulation flag, and provenance columns.
   - Implement `createThread`, `listThreads`, `getThread`, and `getProjectElevationStatus`.
   - Ensure `listThreads` strictly blocks Tier 4 scratchpads belonging to other users.
4. In `workers/spaces/src/index.ts`:
   - Add `/elevation-status` and updated `/threads` list/create route wrappers forwarding caller identity.
5. Run local syntax checks across modified files to ensure strict TypeScript compliance.
```
