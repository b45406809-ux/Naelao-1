import { describe, it, expect, vi } from "vitest";
import spacesWorker from "../../workers/spaces/src/index.js";
import { runScheduledJobs } from "../../workers/agents/src/index.js";
import type { AgentsEnv } from "../../workers/agents/src/index.js";
import { createFakeD1 } from "../stubs/d1-sqlite.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Time-based scheduling (spec §05 "cron-jobs.json") — the no-code, TIME-driven counterpart to
// event-triggers. Two surfaces: builder-facing CRUD (spaces worker, PLATFORM_DB) and the hourly
// dispatcher (agents worker, runScheduledJobs) that fires due jobs directly (no reasoning loop).

const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

// ── CRUD (spaces worker) — real SQLite via the actual migrations, not regex mocks ───────────
const SCHEDULED_JOBS_MIGRATION = readFileSync(
  join(__dirname, "../../infra/migrations/0041_scheduled_jobs.sql"),
  "utf8"
);
const SCHEDULED_JOBS_FAILURES_MIGRATION = readFileSync(
  join(__dirname, "../../infra/migrations/0042_scheduled_jobs_failures.sql"),
  "utf8"
);
const SPACES_TABLE_SQL = `
  CREATE TABLE spaces (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    name TEXT NOT NULL DEFAULT '', spacetype_id TEXT NOT NULL DEFAULT 'launchpad', config_json TEXT
  );
`;

function makeSpacesEnv(spaceId: string, tenantId: string): Record<string, unknown> {
  const fakeDb = createFakeD1([SPACES_TABLE_SQL, SCHEDULED_JOBS_MIGRATION, SCHEDULED_JOBS_FAILURES_MIGRATION]);
  fakeDb.db.exec(`INSERT INTO spaces (id, tenant_id, status, name) VALUES ('${spaceId}', '${tenantId}', 'active', 'Test Space')`);
  return { PLATFORM_SECRET: "s", ENVIRONMENT: "test", PLATFORM_DB: fakeDb };
}

function req(path: string, opts: { method?: string; body?: unknown; tenant?: string } = {}): Request {
  const headers = new Headers();
  headers.set("x-naelao-tenant-id", opts.tenant ?? "tenant-1");
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  return new Request(`https://spaces.naelao.com${path}`, {
    method: opts.method ?? "GET",
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

describe("scheduled-jobs CRUD (spaces worker)", () => {
  it("creates a job with a valid cron expression", async () => {
    const env = makeSpacesEnv("space-1", "tenant-1");
    const res = await spacesWorker.fetch(
      req("/spaces/space-1/scheduled-jobs", {
        method: "POST",
        body: { name: "Daily standup", cron_expression: "0 9 * * *", script_name: "notifications.daily_standup" },
      }),
      env as never, execCtx
    );
    expect(res.status).toBe(201);
    const json = await res.json() as { id: string; cron_expression: string; enabled: boolean };
    expect(json.cron_expression).toBe("0 9 * * *");
    expect(json.enabled).toBe(true);
  });

  it("rejects a malformed cron expression", async () => {
    const env = makeSpacesEnv("space-1", "tenant-1");
    const res = await spacesWorker.fetch(
      req("/spaces/space-1/scheduled-jobs", {
        method: "POST",
        body: { name: "Bad", cron_expression: "not a cron", script_name: "x" },
      }),
      env as never, execCtx
    );
    expect(res.status).toBe(400);
  });

  it("rejects a missing required field", async () => {
    const env = makeSpacesEnv("space-1", "tenant-1");
    const res = await spacesWorker.fetch(
      req("/spaces/space-1/scheduled-jobs", { method: "POST", body: { name: "No cron" } }),
      env as never, execCtx
    );
    expect(res.status).toBe(400);
  });

  it("lists jobs for a space, including the new failure-tracking fields", async () => {
    const env = makeSpacesEnv("space-1", "tenant-1");
    await spacesWorker.fetch(
      req("/spaces/space-1/scheduled-jobs", { method: "POST", body: { name: "Job A", cron_expression: "0 8 * * *", script_name: "s1" } }),
      env as never, execCtx
    );
    const res = await spacesWorker.fetch(req("/spaces/space-1/scheduled-jobs"), env as never, execCtx);
    const json = await res.json() as { data: Array<{ consecutive_failures: number; last_error: string | null }>; count: number };
    expect(json.count).toBe(1);
    expect(json.data[0]!.consecutive_failures).toBe(0);
    expect(json.data[0]!.last_error).toBeNull();
  });

  it("PATCH can disable a job and rejects an invalid new cron", async () => {
    const env = makeSpacesEnv("space-1", "tenant-1");
    const created = await (await spacesWorker.fetch(
      req("/spaces/space-1/scheduled-jobs", { method: "POST", body: { name: "Job A", cron_expression: "0 8 * * *", script_name: "s1" } }),
      env as never, execCtx
    )).json() as { id: string };

    const disable = await spacesWorker.fetch(
      req(`/spaces/space-1/scheduled-jobs/${created.id}`, { method: "PATCH", body: { enabled: false } }),
      env as never, execCtx
    );
    expect(disable.status).toBe(200);

    const badCron = await spacesWorker.fetch(
      req(`/spaces/space-1/scheduled-jobs/${created.id}`, { method: "PATCH", body: { cron_expression: "garbage" } }),
      env as never, execCtx
    );
    expect(badCron.status).toBe(400);
  });

  it("PATCH 404s for a job that doesn't exist", async () => {
    const env = makeSpacesEnv("space-1", "tenant-1");
    const res = await spacesWorker.fetch(
      req("/spaces/space-1/scheduled-jobs/nope", { method: "PATCH", body: { enabled: false } }),
      env as never, execCtx
    );
    expect(res.status).toBe(404);
  });

  it("DELETE removes a job, scoped to the owning tenant", async () => {
    const env = makeSpacesEnv("space-1", "tenant-1");
    const created = await (await spacesWorker.fetch(
      req("/spaces/space-1/scheduled-jobs", { method: "POST", body: { name: "Job A", cron_expression: "0 8 * * *", script_name: "s1" } }),
      env as never, execCtx
    )).json() as { id: string };

    const del = await spacesWorker.fetch(
      req(`/spaces/space-1/scheduled-jobs/${created.id}`, { method: "DELETE" }),
      env as never, execCtx
    );
    expect(del.status).toBe(200);

    const list = await spacesWorker.fetch(req("/spaces/space-1/scheduled-jobs"), env as never, execCtx);
    expect((await list.json() as { count: number }).count).toBe(0);
  });

  it("404s for a space the calling tenant does not own", async () => {
    const env = makeSpacesEnv("space-1", "tenant-1");
    const res = await spacesWorker.fetch(
      req("/spaces/space-1/scheduled-jobs", { tenant: "tenant-evil" }),
      env as never, execCtx
    );
    expect(res.status).toBe(404);
  });
});

// ── Dispatcher (agents worker) — runScheduledJobs fires due jobs, skips not-due, records
// last_run_at, and now tracks/auto-disables on repeated failure.
describe("runScheduledJobs (agents worker hourly dispatcher)", () => {
  interface Row {
    id: string; space_id: string; tenant_id: string; project_id: string | null;
    cron_expression: string; script_name: string; params: string; last_run_at: number | null;
    created_at: string; consecutive_failures: number;
  }

  // A fixed, far-in-the-past creation instant — every existing test's cron windows assume the
  // job has "always existed" so created_at never becomes the binding constraint.
  const OLD_CREATED_AT = "2020-01-01 00:00:00";

  function row(overrides: Partial<Row> & Pick<Row, "id" | "space_id" | "tenant_id" | "cron_expression" | "script_name">): Row {
    return {
      project_id: null, params: "{}", last_run_at: null,
      created_at: OLD_CREATED_AT, consecutive_failures: 0,
      ...overrides,
    };
  }

  function makeAgentsEnv(rows: Row[]): {
    env: AgentsEnv;
    fireCalls: Array<{ url: string; body: unknown }>;
    updates: Array<{ id: string; last_run_at: number; consecutive_failures?: number; last_error?: string | null; enabled?: number }>;
    eventFireCalls: Array<{ url: string; body: unknown }>;
  } {
    const fireCalls: Array<{ url: string; body: unknown }> = [];
    const updates: Array<{ id: string; last_run_at: number; consecutive_failures?: number; last_error?: string | null; enabled?: number }> = [];
    const db = {
      prepare(sql: string) {
        let args: unknown[] = [];
        const stmt = {
          bind(...a: unknown[]) { args = a; return stmt; },
          async all() {
            if (/FROM scheduled_jobs/.test(sql)) return { results: rows };
            return { results: [] };
          },
          async run() {
            // Match on the distinguishing column list only — the real query wraps across
            // lines with leading whitespace, which a literal-text regex would miss.
            if (/consecutive_failures = \?, last_error = \?, enabled = \?/.test(sql)) {
              // now, failures, error, enabled, id
              updates.push({
                id: args[4] as string,
                last_run_at: args[0] as number,
                consecutive_failures: args[1] as number,
                last_error: args[2] as string | null,
                enabled: args[3] as number,
              });
            } else if (/consecutive_failures = 0, last_error = NULL/.test(sql)) {
              // now, id — the success path
              updates.push({ id: args[1] as string, last_run_at: args[0] as number, consecutive_failures: 0, last_error: null });
            }
            return { meta: { changes: 1 } };
          },
        };
        return stmt;
      },
    };
    const agentDoStub = {
      async fetch(reqInput: Request | string, init?: RequestInit) {
        const url = typeof reqInput === "string" ? reqInput : reqInput.url;
        const body = init?.body ? JSON.parse(init.body as string) : await (reqInput as Request).json().catch(() => null);
        fireCalls.push({ url, body });
        return new Response(JSON.stringify({ result: "ok" }), { status: 200 });
      },
    };
    const agentDoNamespace = {
      idFromName: (name: string) => ({ toString: () => name }),
      get: () => agentDoStub,
    };
    const eventFireCalls: Array<{ url: string; body: unknown }> = [];
    const spacesWorkerStub = {
      async fetch(reqInput: Request | string, init?: RequestInit) {
        const req2 = typeof reqInput === "string" ? new Request(reqInput, init) : reqInput;
        const body = await req2.clone().json().catch(() => null);
        eventFireCalls.push({ url: req2.url, body });
        return new Response(JSON.stringify({ fired: true }), { status: 200 });
      },
    };
    const env = {
      PLATFORM_SECRET: "test-secret",
      PLATFORM_DB: db,
      NAELAO_AGENT_DO: agentDoNamespace,
      SPACES_WORKER: spacesWorkerStub,
      ANALYTICS: { writeDataPoint() {} },
    } as unknown as AgentsEnv;
    return { env, fireCalls, updates, eventFireCalls };
  }

  // Fires with an always-firing agent DO that fails (used by the failure-tracking tests below).
  function makeFailingAgentsEnv(rows: Row[], status = 500): ReturnType<typeof makeAgentsEnv> {
    const result = makeAgentsEnv(rows);
    const failingStub = { async fetch() { return new Response("boom", { status }); } };
    (result.env as unknown as { NAELAO_AGENT_DO: { get: () => unknown } }).NAELAO_AGENT_DO = {
      idFromName: (name: string) => ({ toString: () => name }),
      get: () => failingStub,
    };
    return result;
  }

  it("fires a job whose cron is due and records last_run_at", async () => {
    const dueRow = row({
      id: "job-1", space_id: "space-1", tenant_id: "tenant-1",
      cron_expression: "* * * * *", script_name: "notifications.daily_standup",
    });
    const { env, fireCalls, updates } = makeAgentsEnv([dueRow]);
    await runScheduledJobs(env);
    expect(fireCalls).toHaveLength(1);
    const body = fireCalls[0]!.body as { scriptName: string; spaceId: string };
    expect(body.scriptName).toBe("notifications.daily_standup");
    expect(body.spaceId).toBe("space-1");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.id).toBe("job-1");
    expect(updates[0]!.consecutive_failures).toBe(0);
  });

  it("skips a job whose cron is not due, and does not update last_run_at", async () => {
    // A cron pinned to a specific minute far from "now" (year 2000) will never match.
    const notDueRow = row({
      id: "job-2", space_id: "space-1", tenant_id: "tenant-1",
      cron_expression: "0 0 1 1 *", script_name: "s",
      last_run_at: Date.now(), // just ran — definitely not due again immediately
    });
    const { env, fireCalls, updates } = makeAgentsEnv([notDueRow]);
    await runScheduledJobs(env);
    expect(fireCalls).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it("passes params through to the fired script", async () => {
    const dueRow = row({
      id: "job-3", space_id: "space-1", tenant_id: "tenant-1", project_id: "proj-1",
      cron_expression: "* * * * *", script_name: "commerce.report",
      params: JSON.stringify({ format: "csv" }),
    });
    const { env, fireCalls } = makeAgentsEnv([dueRow]);
    await runScheduledJobs(env);
    const body = fireCalls[0]!.body as { params: { format: string }; projectId?: string };
    expect(body.params).toEqual({ format: "csv" });
    expect(body.projectId).toBe("proj-1");
  });

  it("one job's failure does not block another space's job in the same sweep", async () => {
    const badRow = row({
      id: "bad", space_id: "space-bad", tenant_id: "tenant-1",
      cron_expression: "not a cron", script_name: "s",
    });
    const goodRow = row({
      id: "good", space_id: "space-good", tenant_id: "tenant-1",
      cron_expression: "* * * * *", script_name: "s2",
    });
    const { env, fireCalls } = makeAgentsEnv([badRow, goodRow]);
    await runScheduledJobs(env);
    expect(fireCalls).toHaveLength(1);
    expect((fireCalls[0]!.body as { spaceId: string }).spaceId).toBe("space-good");
  });

  it("a newly created job does not fire for a cron minute that already passed before it existed (B5 regression)", async () => {
    const now = Date.now();
    const nowDate = new Date(now);
    // Cron matching every minute EXCEPT right now — created exactly now, so the floor
    // (created_at) equals "now" and isCronDue must find no matching minute strictly after it.
    const currentMinute = nowDate.getUTCMinutes();
    const excludedMinute = (currentMinute + 30) % 60; // a minute that is NOT "now"
    const freshRow = row({
      id: "fresh2", space_id: "space-1", tenant_id: "tenant-1",
      cron_expression: `${excludedMinute} * * * *`, script_name: "s",
      created_at: nowDate.toISOString().slice(0, 19).replace("T", " "),
    });
    const { env, fireCalls } = makeAgentsEnv([freshRow]);
    await runScheduledJobs(env);
    expect(fireCalls).toHaveLength(0);
  });

  it("records the failure, advances last_run_at, and stores last_error on a failed fire", async () => {
    const dueRow = row({
      id: "job-fail", space_id: "space-1", tenant_id: "tenant-1",
      cron_expression: "* * * * *", script_name: "s",
    });
    const { env, updates } = makeFailingAgentsEnv([dueRow]);
    await runScheduledJobs(env);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.id).toBe("job-fail");
    expect(updates[0]!.consecutive_failures).toBe(1);
    expect(updates[0]!.last_error).toBeTruthy();
    expect(updates[0]!.enabled).toBe(1); // not yet at the disable threshold
  });

  it("auto-disables and fires a scheduled_job.disabled event on the 5th consecutive failure", async () => {
    const dueRow = row({
      id: "job-chronic", space_id: "space-1", tenant_id: "tenant-1",
      cron_expression: "* * * * *", script_name: "s",
      consecutive_failures: 4, // this sweep's failure will be the 5th
    });
    const { env, updates, eventFireCalls } = makeFailingAgentsEnv([dueRow]);
    await runScheduledJobs(env);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.consecutive_failures).toBe(5);
    expect(updates[0]!.enabled).toBe(0);

    expect(eventFireCalls).toHaveLength(1);
    expect(eventFireCalls[0]!.url).toBe("http://spaces-worker/internal/spaces/space-1/events/fire");
    const body = eventFireCalls[0]!.body as { type: string; space_id: string; payload: { scheduled_job_id: string; consecutive_failures: number } };
    expect(body.type).toBe("scheduled_job.disabled");
    expect(body.space_id).toBe("space-1");
    expect(body.payload.scheduled_job_id).toBe("job-chronic");
    expect(body.payload.consecutive_failures).toBe(5);
  });

  it("does not fire the disabled event before the 5th consecutive failure", async () => {
    const dueRow = row({
      id: "job-chronic2", space_id: "space-1", tenant_id: "tenant-1",
      cron_expression: "* * * * *", script_name: "s",
      consecutive_failures: 3, // this sweep's failure is only the 4th
    });
    const { env, eventFireCalls } = makeFailingAgentsEnv([dueRow]);
    await runScheduledJobs(env);
    expect(eventFireCalls).toHaveLength(0);
  });

  it("resets consecutive_failures and last_error to a clean state on a successful fire after prior failures", async () => {
    const recoveringRow = row({
      id: "job-recovered", space_id: "space-1", tenant_id: "tenant-1",
      cron_expression: "* * * * *", script_name: "s",
      consecutive_failures: 3,
    });
    const { env, updates } = makeAgentsEnv([recoveringRow]); // healthy stub — this sweep succeeds
    await runScheduledJobs(env);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.consecutive_failures).toBe(0);
    expect(updates[0]!.last_error).toBeNull();
  });
});
