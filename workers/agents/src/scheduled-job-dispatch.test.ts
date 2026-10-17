import { describe, expect, it } from "vitest";
import { claimScheduledJobDispatch, releaseScheduledJobDispatch } from "./scheduled-job-dispatch.js";

function makeDb(firstResult: { claim_token: string } | null) {
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
});
