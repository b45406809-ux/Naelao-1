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

// ── CRUD (spaces worker) — real SQLite via the actual migration, not regex mocks ────────────
const SCHEDULED_JOBS_MIGRATION = readFileSync(
  join(__dirname, "../../infra/migrations/0041_scheduled_jobs.sql"),
  "utf8"
);
const SPACES_TABLE_SQL = `
  CREATE TABLE spaces (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    name TEXT NOT NULL DEFAULT '', spacetype_id TEXT NOT NULL DEFAULT 'launchpad', config_json TEXT
  );
`;

function makeSpacesEnv(spaceId: string, tenantId: string): Record<string, unknown> {
  const fakeDb = createFakeD1([SPACES_TABLE_SQL, SCHEDULED_JOBS_MIGRATION]);
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

  it("lists jobs for a space", async () => {
    const env = makeSpacesEnv("space-1", "tenant-1");
    await spacesWorker.fetch(
      req("/spaces/space-1/scheduled-jobs", { method: "POST", body: { name: "Job A", cron_expression: "0 8 * * *", script_name: "s1" } }),
      env as never, execCtx
    );
    const res = await spacesWorker.fetch(req("/spaces/space-1/scheduled-jobs"), env as never, execCtx);
    const json = await res.json() as { data: unknown[]; count: number };
    expect(json.count).toBe(1);
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

// ── Dispatcher (agents worker) — runScheduledJobs fires due jobs, skips not-due, records last_run_at
describe("runScheduledJobs (agents worker hourly dispatcher)", () => {
  interface Row {
    id: string; space_id: string; tenant_id: string; project_id: string | null;
    cron_expression: string; script_name: string; params: string; last_run_at: number | null;
  }

  function makeAgentsEnv(rows: Row[]): { env: AgentsEnv; fireCalls: Array<{ url: string; body: unknown }>; updates: Array<{ id: string; last_run_at: number }> } {
    const fireCalls: Array<{ url: string; body: unknown }> = [];
    const updates: Array<{ id: string; last_run_at: number }> = [];
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
            if (/UPDATE scheduled_jobs SET last_run_at/.test(sql)) {
              updates.push({ id: args[1] as string, last_run_at: args[0] as number });
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
    const env = {
      PLATFORM_SECRET: "test-secret",
      PLATFORM_DB: db,
      NAELAO_AGENT_DO: agentDoNamespace,
      ANALYTICS: { writeDataPoint() {} },
    } as unknown as AgentsEnv;
    return { env, fireCalls, updates };
  }

  it("fires a job whose cron is due and records last_run_at", async () => {
    const dueRow: Row = {
      id: "job-1", space_id: "space-1", tenant_id: "tenant-1", project_id: null,
      cron_expression: "* * * * *", script_name: "notifications.daily_standup",
      params: "{}", last_run_at: null,
    };
    const { env, fireCalls, updates } = makeAgentsEnv([dueRow]);
    await runScheduledJobs(env);
    expect(fireCalls).toHaveLength(1);
    const body = fireCalls[0]!.body as { scriptName: string; spaceId: string };
    expect(body.scriptName).toBe("notifications.daily_standup");
    expect(body.spaceId).toBe("space-1");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.id).toBe("job-1");
  });

  it("skips a job whose cron is not due, and does not update last_run_at", async () => {
    // A cron pinned to a specific minute far from "now" (year 2000) will never match.
    const notDueRow: Row = {
      id: "job-2", space_id: "space-1", tenant_id: "tenant-1", project_id: null,
      cron_expression: "0 0 1 1 *", script_name: "s", params: "{}",
      last_run_at: Date.now(), // just ran — definitely not due again immediately
    };
    const { env, fireCalls, updates } = makeAgentsEnv([notDueRow]);
    await runScheduledJobs(env);
    expect(fireCalls).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it("passes params through to the fired script", async () => {
    const dueRow: Row = {
      id: "job-3", space_id: "space-1", tenant_id: "tenant-1", project_id: "proj-1",
      cron_expression: "* * * * *", script_name: "commerce.report",
      params: JSON.stringify({ format: "csv" }), last_run_at: null,
    };
    const { env, fireCalls } = makeAgentsEnv([dueRow]);
    await runScheduledJobs(env);
    const body = fireCalls[0]!.body as { params: { format: string }; projectId?: string };
    expect(body.params).toEqual({ format: "csv" });
    expect(body.projectId).toBe("proj-1");
  });

  it("one job's failure does not block another space's job in the same sweep", async () => {
    const badRow: Row = {
      id: "bad", space_id: "space-bad", tenant_id: "tenant-1", project_id: null,
      cron_expression: "not a cron", script_name: "s", params: "{}", last_run_at: null,
    };
    const goodRow: Row = {
      id: "good", space_id: "space-good", tenant_id: "tenant-1", project_id: null,
      cron_expression: "* * * * *", script_name: "s2", params: "{}", last_run_at: null,
    };
    const { env, fireCalls } = makeAgentsEnv([badRow, goodRow]);
    await runScheduledJobs(env);
    expect(fireCalls).toHaveLength(1);
    expect((fireCalls[0]!.body as { spaceId: string }).spaceId).toBe("space-good");
  });
});
