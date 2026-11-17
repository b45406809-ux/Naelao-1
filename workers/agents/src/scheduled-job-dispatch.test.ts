import { describe, expect, it } from "vitest";
import { claimScheduledJobDispatch, releaseScheduledJobDispatch, scheduledJobDispatchSnapshotCurrent, scheduledJobExecutionIdentity } from "./scheduled-job-dispatch.js";

function makeDb(firstResult: unknown) {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      const values: unknown[] = [];
      const statement = {
        bind(...args: unknown[]) { values.push(...args); return statement; },
        async run() { statements.push({ sql, values: [...values] }); return { success: true }; },
        async first() { statements.push({ sql, values: [...values] }); return firstResult; },
      };
      return statement;
    },
  } as unknown as D1Database;
  return { db, statements };
}

describe("scheduled job dispatch claims", () => {
  it("derives a stable service identity and run receipt from the owner job revision", () => {
    expect(scheduledJobExecutionIdentity({ jobId: "job-1", revision: "v3", sweepKey: 10 })).toEqual({
      serviceIdentityId: "scheduled_job:job-1", authorizationRevision: "v3", runId: "scheduled-job:job-1:10",
    });
    expect(scheduledJobExecutionIdentity({ jobId: "job-1", revision: "v4", sweepKey: 10 }).runId)
      .toBe("scheduled-job:job-1:10");
  });

  it("atomically deduplicates one sweep and refuses paused or actively leased jobs", async () => {
    const { db, statements } = makeDb({ claim_token: "claim-1" });
    const token = await claimScheduledJobDispatch(db, { jobId: "job-1", sweepKey: 10, now: 1_000 });
    expect(token).toBe("claim-1");
    expect(statements).toHaveLength(2);
    expect(statements[1]!.sql).toContain("WHERE EXISTS (SELECT 1 FROM scheduled_jobs WHERE id = ? AND enabled = 1)");
    expect(statements[1]!.sql).toContain("NOT EXISTS");
    expect(statements[1]!.sql).toContain("ON CONFLICT(job_id, sweep_key) DO NOTHING");
    expect(statements[1]!.values).toEqual(["job-1", 10, expect.any(String), 1_801_000, 1_000, 1_000, "job-1", "job-1", 1_000]);
  });

  it("returns no claim when this sweep was already delivered or a run holds the lease", async () => {
    const { db } = makeDb(null);
    await expect(claimScheduledJobDispatch(db, { jobId: "job-1", sweepKey: 10, now: 1_000 })).resolves.toBeNull();
  });

  it("releases only the matching claim token and marks its terminal state", async () => {
    const { db, statements } = makeDb(null);
    await releaseScheduledJobDispatch(db, { jobId: "job-1", sweepKey: 10, claimToken: "claim-1", status: "completed", now: 2_000 });
    expect(statements).toHaveLength(1);
    expect(statements[0]!.sql).toContain("claim_token = ? AND status = 'running'");
    expect(statements[0]!.values).toEqual(["completed", 2_000, "job-1", 10, "claim-1"]);
  });

  it("revalidates the full owner authorization snapshot after claiming", async () => {
    const { db, statements } = makeDb({ current: 1 });
    const current = await scheduledJobDispatchSnapshotCurrent(db, {
      jobId: "job-1", spaceId: "space-1", tenantId: "tenant-1", updatedAt: "2026-11-17T12:00:00Z",
      projectId: "project-1", cronExpression: "0 * * * *", scriptName: "review", params: "{}", agentId: null,
      goal: null, quietHoursStart: null, quietHoursEnd: null, quietHoursTimezone: "UTC",
    });
    expect(current).toBe(true);
    expect(statements[0]!.sql).toContain("enabled=1 AND updated_at=? AND project_id=?");
    expect(statements[0]!.sql).toContain("agent_id IS ? AND goal IS ?");
    expect(statements[0]!.values).toEqual([
      "job-1", "space-1", "tenant-1", "2026-11-17T12:00:00Z", "project-1", "0 * * * *", "review", "{}",
      null, null, null, null, "UTC",
    ]);
  });

  it("fails closed if the job was paused, removed, or edited after the initial read", async () => {
    const { db } = makeDb(null);
    await expect(scheduledJobDispatchSnapshotCurrent(db, {
      jobId: "job-1", spaceId: "space-1", tenantId: "tenant-1", updatedAt: "old",
      projectId: "project-1", cronExpression: "0 * * * *", scriptName: "review", params: "{}", agentId: null,
      goal: null, quietHoursStart: null, quietHoursEnd: null, quietHoursTimezone: "UTC",
    })).resolves.toBe(false);
  });
});
