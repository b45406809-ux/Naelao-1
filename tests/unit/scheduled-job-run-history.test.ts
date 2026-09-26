import { describe, it, expect } from "vitest";
import { recordScheduledJobRun, SCHEDULED_JOB_RUN_HISTORY_LIMIT } from "../../workers/agents/src/index.js";
import type { AgentsEnv } from "../../workers/agents/src/index.js";
import { createFakeD1 } from "../stubs/d1-sqlite.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 3 item 27/28 — the run-history log (migration 0071). Driven against a REAL SQLite
// instance created from the real migration file, not a hand-rolled schema — the same discipline
// scheduled-jobs.test.ts already established for scheduled_jobs itself.

const RUN_HISTORY_MIGRATION = readFileSync(
  join(__dirname, "../../infra/migrations/0071_scheduled_job_runs.sql"),
  "utf8"
);

function makeEnv() {
  const fakeDb = createFakeD1([RUN_HISTORY_MIGRATION]);
  fakeDb.db.exec("ALTER TABLE scheduled_job_runs ADD COLUMN project_id TEXT NOT NULL DEFAULT 'project-1'");
  return { PLATFORM_DB: fakeDb } as unknown as AgentsEnv;
}

const ROW = { id: "job-1", space_id: "space-1", tenant_id: "tenant-1", project_id: "project-1" };

function rawDb(env: AgentsEnv) {
  return (env as unknown as { PLATFORM_DB: { db: { prepare(sql: string): { all(): unknown[] } } } }).PLATFORM_DB.db;
}

function readRows(env: AgentsEnv): Array<{ ok: number; error: string | null; skipped_busy: number; duration_ms: number | null; fired_at: number }> {
  return rawDb(env).prepare(`SELECT ok, error, skipped_busy, duration_ms, fired_at FROM scheduled_job_runs WHERE job_id = 'job-1' ORDER BY fired_at ASC`).all() as never;
}

describe("recordScheduledJobRun", () => {
  it("records a success with real duration", async () => {
    const env = makeEnv();
    await recordScheduledJobRun(env, ROW, { ok: true, durationMs: 420, firedAt: 1000 });
    const rows = readRows(env);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ok: 1, error: null, skipped_busy: 0, duration_ms: 420, fired_at: 1000 });
  });

  it("records a failure with the real error text, truncated at 2000 chars", async () => {
    const env = makeEnv();
    const longError = "x".repeat(3000);
    await recordScheduledJobRun(env, ROW, { ok: false, error: longError, durationMs: 10, firedAt: 2000 });
    const rows = readRows(env);
    expect(rows[0]!.ok).toBe(0);
    expect(rows[0]!.error).toHaveLength(2000);
  });

  it("records a busy-skip distinctly from a genuine failure", async () => {
    const env = makeEnv();
    await recordScheduledJobRun(env, ROW, { ok: false, skippedBusy: true, firedAt: 3000 });
    const rows = readRows(env);
    expect(rows[0]).toMatchObject({ ok: 0, skipped_busy: 1, error: null });
  });

  it("caps retention at SCHEDULED_JOB_RUN_HISTORY_LIMIT rows, keeping only the most recent", async () => {
    const env = makeEnv();
    for (let i = 0; i < SCHEDULED_JOB_RUN_HISTORY_LIMIT + 10; i++) {
      await recordScheduledJobRun(env, ROW, { ok: true, firedAt: i });
    }
    const rows = readRows(env);
    expect(rows).toHaveLength(SCHEDULED_JOB_RUN_HISTORY_LIMIT);
    // The oldest ones (fired_at 0..9) must be gone; the newest (fired_at 10..59) must remain.
    expect(rows[0]!.fired_at).toBe(10);
    expect(rows[rows.length - 1]!.fired_at).toBe(SCHEDULED_JOB_RUN_HISTORY_LIMIT + 9);
  });

  it("retention is scoped per job — a second job's history is untouched", async () => {
    const env = makeEnv();
    for (let i = 0; i < SCHEDULED_JOB_RUN_HISTORY_LIMIT + 5; i++) {
      await recordScheduledJobRun(env, ROW, { ok: true, firedAt: i });
    }
    await recordScheduledJobRun(env, { id: "job-2", space_id: "space-1", tenant_id: "tenant-1", project_id: "project-1" }, { ok: true, firedAt: 999 });

    const job2Rows = rawDb(env).prepare(`SELECT id FROM scheduled_job_runs WHERE job_id = 'job-2'`).all();
    expect(job2Rows).toHaveLength(1);
    expect(readRows(env)).toHaveLength(SCHEDULED_JOB_RUN_HISTORY_LIMIT);
  });

  it("never throws even against a broken PLATFORM_DB (best-effort)", async () => {
    const brokenEnv = {
      PLATFORM_DB: { prepare() { throw new Error("db down"); } },
    } as unknown as AgentsEnv;
    await expect(recordScheduledJobRun(brokenEnv, ROW, { ok: true, firedAt: 1 })).resolves.toBeUndefined();
  });
});
