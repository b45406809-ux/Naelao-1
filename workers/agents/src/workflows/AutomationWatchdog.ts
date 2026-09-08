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
    try {
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
    } catch (err: any) {
      // If table doesn't exist yet or other query error, log and continue
      console.warn("[AutomationWatchdog] runAuditPass encountered error:", err?.message || err);
    }
  }

  private isOverdue(nextRunAt: any): boolean {
    if (!nextRunAt) return false;
    const now = Date.now();
    const runTime = typeof nextRunAt === "number" ? nextRunAt : new Date(nextRunAt).getTime();
    // Overdue by more than 6 hours (21600000 ms)
    return (now - runTime) > (1000 * 60 * 60 * 6);
  }

  private async handleIncident(incident: AutomationIncident) {
    try {
      // 1. Log to SpaceDO audit table if available
      if (typeof this.spaceDo.sql?.exec === "function") {
        await this.spaceDo.sql.exec(
          "INSERT INTO workflow_incidents (job_id, kind, message, created_at) VALUES (?, ?, ?, ?)",
          incident.jobId, incident.failureKind, incident.message, Date.now()
        );
      }
    } catch (e) {
      // Table workflow_incidents might need to be created if missing
      try {
        await this.spaceDo.sql.exec(`
          CREATE TABLE IF NOT EXISTS workflow_incidents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id TEXT,
            kind TEXT,
            message TEXT,
            created_at INTEGER
          )
        `);
        await this.spaceDo.sql.exec(
          "INSERT INTO workflow_incidents (job_id, kind, message, created_at) VALUES (?, ?, ?, ?)",
          incident.jobId, incident.failureKind, incident.message, Date.now()
        );
      } catch (err2) {
        console.error("[AutomationWatchdog] Failed to record incident in database:", err2);
      }
    }

    // 2. Dispatch Incident Card to Tier 1 Team Room / broadcast event
    if (typeof this.spaceDo.postToTeamRoom === "function") {
      await this.spaceDo.postToTeamRoom(incident.projectId, {
        type: "INCIDENT_CARD",
        body: `🚨 Automation Incident: ${incident.failureKind}\n${incident.message}`,
        actions: ["RETRY", "DISMISS"]
      });
    }

    // 3. Broadcast through event bus if available
    if (typeof this.spaceDo.broadcastEvent === "function") {
      await this.spaceDo.broadcastEvent({
        type: "AUTOMATION_INCIDENT_REPORTED",
        payload: incident,
        timestamp: Date.now()
      });
    }
  }
}
