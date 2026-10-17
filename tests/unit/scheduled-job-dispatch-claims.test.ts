import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claimScheduledJobDispatch, releaseScheduledJobDispatch } from "../../workers/agents/src/scheduled-job-dispatch.js";
import { createFakeD1, type FakeD1 } from "../stubs/d1-sqlite.js";

const database = (): FakeD1 => createFakeD1([
  readFileSync(join(__dirname, "../../infra/migrations/0041_scheduled_jobs.sql"), "utf8"),
  readFileSync(join(__dirname, "../../infra/migrations/0105_scheduled_job_dispatch_claims.sql"), "utf8"),
]);

describe("scheduled job dispatch claims (SQLite integration)", () => {
  let db: FakeD1 | undefined;
  afterEach(() => { db?.db.close(); db = undefined; });

  it("allows only one concurrent claim for a job in the same sweep", async () => {
    db = database();
    db.db.exec(`INSERT INTO scheduled_jobs (id, space_id, tenant_id, name, cron_expression, script_name)
      VALUES ('job-1','space-1','tenant-1','Review','0 * * * *','review')`);
    const claims = await Promise.all([
      claimScheduledJobDispatch(db, { jobId: "job-1", sweepKey: 42, now: 1_000 }),
      claimScheduledJobDispatch(db, { jobId: "job-1", sweepKey: 42, now: 1_000 }),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it("blocks a second sweep during an active lease, then admits it after release", async () => {
    db = database();
    db.db.exec(`INSERT INTO scheduled_jobs (id, space_id, tenant_id, name, cron_expression, script_name)
      VALUES ('job-1','space-1','tenant-1','Review','0 * * * *','review')`);
    const claim = await claimScheduledJobDispatch(db, { jobId: "job-1", sweepKey: 42, now: 1_000 });
    expect(claim).toBeTruthy();
    await expect(claimScheduledJobDispatch(db, { jobId: "job-1", sweepKey: 43, now: 2_000 })).resolves.toBeNull();
    await releaseScheduledJobDispatch(db, { jobId: "job-1", sweepKey: 42, claimToken: claim!, status: "completed", now: 3_000 });
    expect(await claimScheduledJobDispatch(db, { jobId: "job-1", sweepKey: 43, now: 4_000 })).toBeTruthy();
  });

  it("will not claim a job paused before the worker starts it", async () => {
    db = database();
    db.db.exec(`INSERT INTO scheduled_jobs (id, space_id, tenant_id, name, cron_expression, script_name, enabled)
      VALUES ('job-1','space-1','tenant-1','Review','0 * * * *','review',0)`);
    await expect(claimScheduledJobDispatch(db, { jobId: "job-1", sweepKey: 42, now: 1_000 })).resolves.toBeNull();
  });

  it("reclaims a crashed run after its 30 minute lease expires, on a later sweep", async () => {
    db = database();
    db.db.exec(`INSERT INTO scheduled_jobs (id, space_id, tenant_id, name, cron_expression, script_name)
      VALUES ('job-1','space-1','tenant-1','Review','0 * * * *','review')`);
    await claimScheduledJobDispatch(db, { jobId: "job-1", sweepKey: 42, now: 1_000 });
    await expect(claimScheduledJobDispatch(db, { jobId: "job-1", sweepKey: 43, now: 1_801_001 })).resolves.toBeTruthy();
  });
});
