This chunk specification finalizes the **Project Automation Watchdog** system. 

It addresses the fundamental "unattended runtime" problem: if a background automation or subagent process hangs, exceeds its budget, or stalls silently, the platform must detect, classify, and report it without requiring a human to manually monitor execution logs.

---

### Chunk 9: `specs/phase-6/chunk-09-project-automation-watchdog.md`

```markdown
---
chunk_id: "phase-6-chunk-09"
phase: 6
include_files:
  - workers/agents/src/workflows/AutomationWatchdog.ts
  - workers/spaces/src/do/SpaceDO.ts
  - packages/events/src/events.ts
repomix_include:
  - "workers/agents/src/workflows/AutomationWatchdog.ts"
  - "workers/spaces/src/do/SpaceDO.ts"
  - "packages/events/src/events.ts"
expected_outputs:
  - workers/agents/src/workflows/AutomationWatchdog.ts
  - workers/spaces/src/do/SpaceDO.ts
---

# Phase 6 — Chunk 09: Project Automation Watchdog

## 1. Mental Model & Architectural Vision

The Watchdog is a project-level sentry that ensures background automations (Class 1 Company Automations & Class 2 Vertical Extensions) do not drift into "zombie" states or silent failures. 

It does not rely on a centralized global poller (which would cause N+1 scaling issues). Instead, each project's `SpaceDO` performs **Self-Monitoring Heartbeats** that trigger an audit against the `project_anchored_workflows` registry.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       PROJECT AUTOMATION WATCHDOG                           │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. HEARTBEAT DISPATCHER      │ Triggers every 6 hours via Durable Object    │
│                              │ Alarm (`ctx.storage.setAlarm`).             │
├──────────────────────────────┼──────────────────────────────────────────────┤
│ 2. HEALTH AUDIT PASS         │ Scans `project_anchored_workflows` for jobs  │
│                              │ that missed their `next_run_at` deadline.    │
├──────────────────────────────┼──────────────────────────────────────────────┤
│ 3. FAILURE CLASSIFICATION    │ Categorizes failures: `STALL`, `OOM`, `429`, │
│                              │ `CRASH`, `BUDGET_EXCEEDED`, `UNAUTH`.        │
├──────────────────────────────┼──────────────────────────────────────────────┤
│ 4. ESCALATION ENGINE         │ Posts concise Incident Card to Team Room.    │
│                              │ Retries `CRASH`/`429` with exponential backoff. │
└──────────────────────────────┴──────────────────────────────────────────────┘
```

---

## 2. Implementation Requirements

### A. The Watchdog Service (`workers/agents/src/workflows/AutomationWatchdog.ts`)

```typescript
export interface AutomationIncident {
  jobId: string;
  projectId: string;
  failureKind: "STALL" | "OOM" | "RATE_LIMIT" | "CRASH" | "UNAUTH";
  message: string;
  remedy: "AUTO_RETRY" | "MANUAL_REVIEW";
}

export class AutomationWatchdog {
  constructor(private spaceDo: any) {}

  /**
   * Scans all anchored workflows for health violations.
   */
  async runAuditPass() {
    const jobs = await this.spaceDo.sql.exec("SELECT * FROM project_anchored_workflows WHERE status = 'ACTIVE'");
    
    for (const job of jobs.toArray()) {
      if (this.isOverdue(job.next_run_at)) {
        await this.handleIncident({
          jobId: job.id,
          projectId: job.project_id,
          failureKind: "STALL",
          message: "Automation heartbeat missed by > 6 hours.",
          remedy: "AUTO_RETRY"
        });
      }
    }
  }

  private async handleIncident(incident: AutomationIncident) {
    // 1. Log to SpaceDO audit table
    await this.spaceDo.sql.exec(
      "INSERT INTO workflow_incidents (job_id, kind, message) VALUES (?, ?, ?)",
      incident.jobId, incident.failureKind, incident.message
    );

    // 2. Dispatch Incident Card to Tier 1 Team Room
    await this.spaceDo.postToTeamRoom(incident.projectId, {
      type: "INCIDENT_CARD",
      body: `🚨 Automation Incident: ${incident.failureKind}\n${incident.message}`,
      actions: ["RETRY", "DISMISS"]
    });
  }
}
```

### B. Update `SpaceDO.ts`
1. Register a persistent alarm in `SpaceDO` to fire every 6 hours:
   ```typescript
   async setAuditAlarm() {
     await this.ctx.storage.setAlarm(Date.now() + 1000 * 60 * 60 * 6);
   }

   async alarm() {
     const watchdog = new AutomationWatchdog(this);
     await watchdog.runAuditPass();
     // Reset alarm
     await this.setAuditAlarm();
   }
   ```
2. Ensure `project_anchored_workflows` is included in the migration state.

---

## 3. Implementation Instructions for the AI Runner

1. **Automation Watchdog:** Create `workers/agents/src/workflows/AutomationWatchdog.ts` with the incident classification and escalation logic.
2. **DO Registry Integration:** Update `SpaceDO.ts` to include the `alarm()` entrypoint for scheduled health audits.
3. **Event Emissary:** Ensure `AutomationIncident` types are broadcast through the `@naelao/events` bus so the UI can render incident badges in the Project Overview.
4. **Resiliency:** Use `execSync` via the local runner to verify the SQLite schema migrations include the `workflow_incidents` table (if needed for audit history).
```

---

### Summary of what this provides:
* **The "Zombie" Detection:** It stops projects from silently failing background automations.
* **Auto-Recovery:** `AUTO_RETRY` handles transient `429` (Rate Limit) or `503` (Service Unavailable) errors automatically with exponential backoff.
* **Human-in-the-loop Escalation:** When a `CRASH` or `UNAUTH` (Invalid Credentials) occurs, the founder is notified immediately in the thread timeline with an actionable `[ Retry ]` or `[ Reconfigure Credentials ]` button.
