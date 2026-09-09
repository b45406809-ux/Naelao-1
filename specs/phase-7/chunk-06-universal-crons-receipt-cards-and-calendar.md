Here is the complete, single, fully-detailed, production-ready Markdown specification file for **Phase 7 — Chunk 06**: `specs/phase-7/chunk-06-universal-crons-receipt-cards-and-calendar.md`.

---

```markdown
---
chunk_id: "phase-7-chunk-06"
phase: 7
include_files:
  - workers/spaces/src/do/SpaceDO.ts
  - workers/agents/src/script-engine/prebuilt/schedule.ts
  - workers/agents/src/do/NaelaoAgentDO.ts
  - packages/types/src/index.ts
repomix_include:
  - "workers/spaces/src/do/SpaceDO.ts"
  - "workers/agents/src/script-engine/prebuilt/schedule.ts"
  - "workers/agents/src/do/NaelaoAgentDO.ts"
  - "packages/types/src/index.ts"
expected_outputs:
  - workers/spaces/src/do/SpaceDO.ts
  - workers/agents/src/script-engine/prebuilt/schedule.ts
  - packages/types/src/calendar.ts
  - packages/types/src/scheduled-jobs.ts
  - packages/types/src/index.ts
---

# Phase 7 — Chunk 06: Project-Universal Scheduled Crons, Decoupled Receipt Cards & Shared Calendar Plane

## 1. Executive Summary & Architectural Vision

Running scheduled jobs and background crons directly inside conversational chat threads causes **context bloat, high latency, and conversation hijacking**. If an agent loads a 50-message chat history just to execute a routine 03:00 AM security sweep, it burns 40,000 tokens and risks cluttering the human user's screen with raw execution logs.

Phase 7 Chunk 06 resolves this by implementing:
1. **Project-Universal, Bot-Attributed Scheduled Crons:** Scheduled tasks are registered centrally in `SpaceDO` SQLite (`project_scheduled_jobs`). When a cron triggers, it executes inside a **pristine, isolated Workflow context (<2,000 tokens)** without loading any historical chat turns.
2. **Compact Inline Receipt Cards:** Completed background jobs do not dump verbose stdout into active conversations. They emit a **2-line expandable Receipt Card** in the origin thread (or Team Room), offloading heavy execution logs to Cloudflare R2.
3. **The Unified Space-Wide Shared Calendar & CRM Plane:** A single authoritative appointment and reservation table (`space_calendar_events`) in `SpaceDO` SQLite that is universally accessible to Voice Receptionists, Document Studios, and the Space Assistant with atomic double-booking prevention.

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                        DECOUPLED CRON EXECUTION & RECEIPT CARD FLOW                                    │
├────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ 1. REGISTRATION: Agent calls `schedule.wake_me({ cron: "0 9 * * 1", task: "..." })`                    │
│    Recorded in `SpaceDO` SQLite (`project_scheduled_jobs`) with `ownerBotId: "dev-operator"`.          │
├────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ 2. ISOLATED DISPATCH: Cron fires via Cloudflare Workflows in a **clean context (<2k tokens)**.         │
│    Zero chat transcript loaded. Runs AST/security checks, commits a Git branch, and saves logs to R2.  │
├────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ 3. ASYNC RECEIPT CARD: Emits an inline, expandable 2-line card into the origin thread via WsHubDO:     │
│ ┌────────────────────────────────────────────────────────────────────────────────────────────────────┐ │
│ │ ⏰ **Background Cron Run Completed** (by **@DevOperator**)                         [ 09:01 UTC ]   │ │
│ │ Task: *Weekly Dependency Security Audit*                                                           │ │
│ │ Status: 🟢 **All 42 packages secure. 0 vulnerabilities found.**                                     │ │
│ │ [ 🔍 View Full Output Logs ]                               [ 🌿 Inspect Commit `c_8a12` ]          │ │
│ └────────────────────────────────────────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Canonical TypeScript Types

### A. Create `packages/types/src/scheduled-jobs.ts`

```typescript
export type ScheduledJobStatus = "ACTIVE" | "PAUSED" | "COMPLETED";

export interface ProjectScheduledJob {
  id: string;
  spaceId: string;
  projectId: string;
  ownerBotId: string;
  originThreadId?: string;
  title: string;
  cronExpression: string;
  workflowScriptPath: string;
  payloadJson: Record<string, any>;
  status: ScheduledJobStatus;
  lastRunAt?: string;
  nextRunAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectCronRunRecord {
  id: string;
  jobId: string;
  spaceId: string;
  projectId: string;
  executedByBotId: string;
  exitCode: number;
  summaryText: string;
  stdoutR2Key?: string;
  durationMs: number;
  executedAt: string;
}
```

### B. Create `packages/types/src/calendar.ts`

```typescript
export type CalendarEventStatus = "CONFIRMED" | "CANCELLED" | "RESCHEDULED" | "COMPLETED";

export interface SpaceCalendarEvent {
  id: string;
  spaceId: string;
  projectId?: string;
  clientName: string;
  clientContact: string; // Email or Phone (E.164)
  eventType: string;     // e.g. "dental_cleaning", "consultation", "inspection"
  startTime: string;     // ISO-8601 UTC
  endTime: string;       // ISO-8601 UTC
  status: CalendarEventStatus;
  metadataJson: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export interface SlotAvailabilityResult {
  available: boolean;
  conflictingEventId?: string;
  nextAvailableSlot?: string;
}
```

Re-export both files in `packages/types/src/index.ts`.

---

## 3. SQLite DDL Schema in `SpaceDO.ts`

In `workers/spaces/src/do/SpaceDO.ts`, add the tables for decoupled scheduled jobs, run history, and the shared calendar plane:

```sql
-- 1. Project-Universal Scheduled Jobs Registry
CREATE TABLE IF NOT EXISTS project_scheduled_jobs (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  owner_bot_id TEXT NOT NULL,
  origin_thread_id TEXT,
  title TEXT NOT NULL,
  cron_expression TEXT NOT NULL,
  workflow_script_path TEXT NOT NULL,
  payload_json TEXT DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PAUSED', 'COMPLETED')),
  last_run_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_psj_proj ON project_scheduled_jobs(project_id, status);

-- 2. Audit Run History for Scheduled Jobs
CREATE TABLE IF NOT EXISTS project_cron_runs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES project_scheduled_jobs(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  executed_by_bot_id TEXT NOT NULL,
  exit_code INTEGER NOT NULL,
  summary_text TEXT NOT NULL,
  stdout_r2_key TEXT,
  duration_ms INTEGER NOT NULL,
  executed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pcr_job ON project_cron_runs(job_id, executed_at DESC);

-- 3. Universal Shared Calendar & CRM Plane
CREATE TABLE IF NOT EXISTS space_calendar_events (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  project_id TEXT,
  client_name TEXT NOT NULL,
  client_contact TEXT NOT NULL,
  event_type TEXT NOT NULL DEFAULT 'consultation',
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'CONFIRMED' CHECK (status IN ('CONFIRMED', 'CANCELLED', 'RESCHEDULED', 'COMPLETED')),
  metadata_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sce_time ON space_calendar_events(space_id, start_time, end_time);
```

---

## 4. Implementation Code & Contracts

### A. Update `SpaceDO.ts` with Calendar & Job Methods

Add the following methods to `SpaceDO` in `workers/spaces/src/do/SpaceDO.ts`:

```typescript
import { SpaceCalendarEvent, SlotAvailabilityResult, ProjectScheduledJob, ProjectCronRunRecord } from "@naelao/types";

export class SpaceDO extends DurableObject {
  // ── 1. UNIVERSAL CALENDAR PLANE ──────────────────────────────────────────

  async checkCalendarAvailability(spaceId: string, startTime: string, endTime: string): Promise<SlotAvailabilityResult> {
    const conflict = this.ctx.storage.sql.exec<SpaceCalendarEvent>(`
      SELECT * FROM space_calendar_events 
      WHERE space_id = ? 
        AND status = 'CONFIRMED'
        AND ((start_time < ? AND end_time > ?) OR (start_time >= ? AND start_time < ?))
      LIMIT 1
    `, spaceId, endTime, startTime, startTime, endTime).toArray()[0];

    if (conflict) {
      return { available: false, conflictingEventId: conflict.id };
    }
    return { available: true };
  }

  async bookCalendarSlot(params: {
    spaceId: string;
    projectId?: string;
    clientName: string;
    clientContact: string;
    eventType: string;
    startTime: string;
    endTime: string;
    metadata?: Record<string, any>;
  }): Promise<{ success: boolean; event?: SpaceCalendarEvent; error?: string }> {
    // Atomic Double-Booking Verification
    const availability = await this.checkCalendarAvailability(params.spaceId, params.startTime, params.endTime);
    if (!availability.available) {
      return { success: false, error: "Slot already booked by another event." };
    }

    const eventId = `evt_cal_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const now = new Date().toISOString();

    this.ctx.storage.sql.exec(`
      INSERT INTO space_calendar_events (
        id, space_id, project_id, client_name, client_contact, event_type, start_time, end_time, status, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'CONFIRMED', ?, ?, ?)
    `,
      eventId,
      params.spaceId,
      params.projectId || null,
      params.clientName,
      params.clientContact,
      params.eventType,
      params.startTime,
      params.endTime,
      JSON.stringify(params.metadata || {}),
      now,
      now
    );

    const bookedEvent: SpaceCalendarEvent = {
      id: eventId,
      spaceId: params.spaceId,
      projectId: params.projectId,
      clientName: params.clientName,
      clientContact: params.clientContact,
      eventType: params.eventType,
      startTime: params.startTime,
      endTime: params.endTime,
      status: "CONFIRMED",
      metadataJson: params.metadata || {},
      createdAt: now,
      updatedAt: now
    };

    return { success: true, event: bookedEvent };
  }

  // ── 2. PROJECT SCHEDULED JOBS & RECEIPT LOGGING ─────────────────────────

  async registerScheduledJob(job: Omit<ProjectScheduledJob, "createdAt" | "updatedAt">): Promise<{ ok: boolean; job: ProjectScheduledJob }> {
    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(`
      INSERT INTO project_scheduled_jobs (
        id, space_id, project_id, owner_bot_id, origin_thread_id, title, cron_expression, workflow_script_path, payload_json, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        cron_expression = excluded.cron_expression,
        workflow_script_path = excluded.workflow_script_path,
        payload_json = excluded.payload_json,
        status = excluded.status,
        updated_at = excluded.updated_at
    `,
      job.id,
      job.spaceId,
      job.projectId,
      job.ownerBotId,
      job.originThreadId || null,
      job.title,
      job.cronExpression,
      job.workflowScriptPath,
      JSON.stringify(job.payloadJson || {}),
      job.status,
      now,
      now
    );

    return {
      ok: true,
      job: {
        ...job,
        createdAt: now,
        updatedAt: now
      }
    };
  }

  async recordCronRun(run: Omit<ProjectCronRunRecord, "id" | "executedAt">): Promise<{ ok: boolean; runId: string }> {
    const runId = `run_cron_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const now = new Date().toISOString();

    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(`
        INSERT INTO project_cron_runs (
          id, job_id, space_id, project_id, executed_by_bot_id, exit_code, summary_text, stdout_r2_key, duration_ms, executed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        runId,
        run.jobId,
        run.spaceId,
        run.projectId,
        run.executedByBotId,
        run.exitCode,
        run.summaryText,
        run.stdoutR2Key || null,
        run.durationMs,
        now
      );

      // Update last_run_at on the parent job
      this.ctx.storage.sql.exec(`
        UPDATE project_scheduled_jobs SET last_run_at = ?, updated_at = ? WHERE id = ?
      `, now, now, run.jobId);
    });

    return { ok: true, runId };
  }
}
```

---

### B. Prebuilt Scheduling Tool (`workers/agents/src/script-engine/prebuilt/schedule.ts`)

Create `schedule.ts` implementing `schedule.wake_me`, `schedule.list`, and `schedule.cancel`:

```typescript
import { PrebuiltOpContext } from "../types";

export const schedulePrebuilt = {
  name: "schedule",
  description: "Manage project-universal scheduled jobs, cron sweeps, and delayed wake-ups.",
  operations: {
    "schedule.wake_me": async (
      args: {
        title: string;
        cronExpression?: string;
        delayMinutes?: number;
        workflowPath: string;
        payload?: Record<string, any>;
      },
      ctx: PrebuiltOpContext
    ) => {
      let cron = args.cronExpression;
      if (!cron && args.delayMinutes) {
        // Calculate one-shot timestamp into a minute cron target
        const targetDate = new Date(Date.now() + args.delayMinutes * 60000);
        cron = `${targetDate.getUTCMinutes()} ${targetDate.getUTCHours()} ${targetDate.getUTCDate()} ${targetDate.getUTCMonth() + 1} *`;
      }

      if (!cron) {
        throw new Error("Must provide either 'cronExpression' or 'delayMinutes'.");
      }

      const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const spaceDO = await ctx.env.SPACES_DO.get(ctx.env.SPACES_DO.idFromName(ctx.env.spaceId));

      const res = await spaceDO.fetch("http://internal/scheduled-jobs/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: jobId,
          spaceId: ctx.env.spaceId,
          projectId: ctx.env.projectId,
          ownerBotId: ctx.env.agentId,
          originThreadId: ctx.env.threadId,
          title: args.title,
          cronExpression: cron,
          workflowScriptPath: args.workflowPath,
          payloadJson: args.payload || {},
          status: "ACTIVE"
        })
      });

      const data = await res.json() as any;
      return {
        ok: true,
        jobId,
        cronExpression: cron,
        message: `✔ Scheduled job '${args.title}' successfully registered. It will wake in an isolated Workflow context.`
      };
    },

    "schedule.list": async (args: Record<string, any>, ctx: PrebuiltOpContext) => {
      const spaceDO = await ctx.env.SPACES_DO.get(ctx.env.SPACES_DO.idFromName(ctx.env.spaceId));
      const res = await spaceDO.fetch(`http://internal/scheduled-jobs/list?project_id=${ctx.env.projectId || ""}`);
      return await res.json();
    },

    "schedule.cancel": async (args: { jobId: string }, ctx: PrebuiltOpContext) => {
      const spaceDO = await ctx.env.SPACES_DO.get(ctx.env.SPACES_DO.idFromName(ctx.env.spaceId));
      const res = await spaceDO.fetch(`http://internal/scheduled-jobs/${args.jobId}/cancel`, { method: "POST" });
      return await res.json();
    }
  }
};
```

---

### C. Emit Inline Receipt Cards (`workers/agents/src/do/NaelaoAgentDO.ts`)

When a scheduled job completes in a background Workflow, `NaelaoAgentDO` emits the compact receipt card without polluting the thread history:

```typescript
export async function emitCronReceiptCard(
  job: ProjectScheduledJob,
  runRecord: ProjectCronRunRecord,
  env: Env
) {
  // 1. Offload heavy stdout logs to Cloudflare R2 if present
  let stdoutKey: string | undefined = undefined;
  if (runRecord.summaryText && runRecord.summaryText.length > 500) {
    stdoutKey = `cron_logs/${job.spaceId}/${job.projectId}/${runRecord.id}.txt`;
    await env.WORKSPACE_BUCKET.put(stdoutKey, runRecord.summaryText);
  }

  // 2. Format 2-line expandable Receipt Card
  const receiptCardPayload = {
    type: "CRON_RECEIPT_CARD",
    jobId: job.id,
    runId: runRecord.id,
    title: job.title,
    executedByBotId: runRecord.executedByBotId,
    status: runRecord.exitCode === 0 ? "SUCCESS" : "FAILED",
    summary: runRecord.exitCode === 0 
      ? `🟢 ${job.title}: Completed successfully in ${runRecord.durationMs}ms.`
      : `🔴 ${job.title}: Failed with exit code ${runRecord.exitCode}.`,
    stdoutR2Key: stdoutKey,
    executedAt: new Date().toISOString()
  };

  // 3. Broadcast to origin thread and Team Room via WsHubDO
  const wsHub = env.WS_GATEWAY.get(env.WS_GATEWAY.idFromName(job.spaceId));
  await wsHub.fetch("http://internal/broadcast", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      topic: `project:${job.projectId}:events`,
      event: "cron.receipt_emitted",
      data: receiptCardPayload
    })
  });
}
```

---

## 5. Step-by-Step Implementation Instructions for the AI Runner

When applying this chunk:
1. **Types:** Create `packages/types/src/calendar.ts` and `packages/types/src/scheduled-jobs.ts`, then re-export both in `packages/types/src/index.ts`.
2. **Schema:** Update `workers/spaces/src/do/SpaceDO.ts` `ensureInit()` to create `project_scheduled_jobs`, `project_cron_runs`, and `space_calendar_events`.
3. **DO Methods:** Implement `checkCalendarAvailability`, `bookCalendarSlot`, `registerScheduledJob`, and `recordCronRun` inside `SpaceDO.ts`.
4. **Prebuilt Tool:** Create `workers/agents/src/script-engine/prebuilt/schedule.ts` and register it in the tool engine registry.
5. **Receipt Cards:** Implement `emitCronReceiptCard` in `NaelaoAgentDO.ts` to push structured WebSocket events to `WsHubDO`.
6. Run `npx turbo run typecheck` to verify zero type mismatches across packages.
```
