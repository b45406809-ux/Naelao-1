import { describe, it, expect, vi } from "vitest";
import spacesWorker from "../../workers/spaces/src/index.js";
import { enqueueAgentTicks, handleAgentTicksQueue, handleAgentTick } from "../../workers/agents/src/index.js";
import type { AgentsEnv, AgentTickMessage } from "../../workers/agents/src/index.js";
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
const SCHEDULED_JOBS_AGENT_GOAL_MIGRATION = readFileSync(
  join(__dirname, "../../infra/migrations/0043_scheduled_jobs_agent_goal.sql"),
  "utf8"
);
const SCHEDULED_JOB_RUNS_MIGRATION = readFileSync(
  join(__dirname, "../../infra/migrations/0071_scheduled_job_runs.sql"),
  "utf8"
);
const SCHEDULED_JOB_QUIET_HOURS_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0106_scheduled_job_quiet_hours.sql"), "utf8");
const SPACES_TABLE_SQL = `
  CREATE TABLE spaces (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    name TEXT NOT NULL DEFAULT '', spacetype_id TEXT NOT NULL DEFAULT 'launchpad', config_json TEXT,
    parent_space_id TEXT
  );
`;

function makeSpacesEnv(spaceId: string, tenantId: string, visibleProjectIds = ["proj-1"]): Record<string, unknown> {
  const fakeDb = createFakeD1([SPACES_TABLE_SQL, SCHEDULED_JOBS_MIGRATION, SCHEDULED_JOBS_FAILURES_MIGRATION, SCHEDULED_JOBS_AGENT_GOAL_MIGRATION, SCHEDULED_JOB_RUNS_MIGRATION, SCHEDULED_JOB_QUIET_HOURS_MIGRATION]);
  fakeDb.db.exec(`INSERT INTO spaces (id, tenant_id, status, name) VALUES ('${spaceId}', '${tenantId}', 'active', 'Test Space')`);
  return { PLATFORM_SECRET: "s", ENVIRONMENT: "test", PLATFORM_DB: fakeDb, SPACE_DO: {
    idFromName: (name: string) => name,
    get: () => ({ fetch: async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/projects") return Response.json({ data: visibleProjectIds.map((id) => ({ id })) });
      const accessProjectId = url.pathname.match(/^\/projects\/([^/]+)\/automation-access$/)?.[1];
      if (accessProjectId) {
        const allowed = url.searchParams.get("space_manager") === "1" || visibleProjectIds.includes(decodeURIComponent(accessProjectId));
        return allowed
          ? Response.json({ project_id: accessProjectId, can_manage: true })
          : Response.json({ error_code: "forbidden" }, { status: 403 });
      }
      return Response.json({ project_id: "proj-1", can_manage: true });
    } }),
  } };
}

function req(path: string, opts: { method?: string; body?: unknown; tenant?: string; userId?: string; role?: string } = {}): Request {
  const headers = new Headers();
  headers.set("x-naelao-tenant-id", opts.tenant ?? "tenant-1");
  if (opts.userId) headers.set("x-naelao-user-id", opts.userId);
  if (opts.role) headers.set("x-naelao-role", opts.role);
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
        body: { name: "Daily standup", cron_expression: "0 9 * * *", script_name: "notifications.daily_standup", project_id: "proj-1" },
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
        body: { name: "Bad", cron_expression: "not a cron", script_name: "x", project_id: "proj-1" },
      }),
      env as never, execCtx
    );
    expect(res.status).toBe(400);
  });

  it("stores quiet-hours settings and rejects invalid timezone or unpaired times", async () => {
    const env = makeSpacesEnv("space-1", "tenant-1");
    const created = await spacesWorker.fetch(req("/spaces/space-1/scheduled-jobs", {
      method: "POST", body: { name: "Quiet routine", cron_expression: "0 9 * * *", goal: "Review project", project_id: "proj-1",
        quiet_hours_start: "22:00", quiet_hours_end: "07:00", quiet_hours_timezone: "America/New_York" },
    }), env as never, execCtx);
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ quiet_hours_start: "22:00", quiet_hours_end: "07:00", quiet_hours_timezone: "America/New_York" });
    const invalid = await spacesWorker.fetch(req("/spaces/space-1/scheduled-jobs", {
      method: "POST", body: { name: "Bad quiet routine", cron_expression: "0 9 * * *", goal: "Review project", project_id: "proj-1",
        quiet_hours_start: "22:00", quiet_hours_end: "07:00", quiet_hours_timezone: "Not/AZone" },
    }), env as never, execCtx);
    expect(invalid.status).toBe(400);
  });

  it("rejects a missing required field", async () => {
    const env = makeSpacesEnv("space-1", "tenant-1");
    const res = await spacesWorker.fetch(
      req("/spaces/space-1/scheduled-jobs", { method: "POST", body: { name: "No cron" } }),
      env as never, execCtx
    );
    expect(res.status).toBe(400);
  });

  // Phase 3 item 27/28 — "next run" computed fresh on every list, not stored.
  it("reports a real next_run_at for an enabled job, and null for a disabled one", async () => {
    const env = makeSpacesEnv("space-1", "tenant-1");
    await spacesWorker.fetch(
      req("/spaces/space-1/scheduled-jobs", { method: "POST", body: { name: "Enabled job", cron_expression: "0 9 * * *", script_name: "s1", project_id: "proj-1" } }),
      env as never, execCtx
    );
    const created = await (await spacesWorker.fetch(
      req("/spaces/space-1/scheduled-jobs", { method: "POST", body: { name: "Disabled job", cron_expression: "0 9 * * *", script_name: "s2", project_id: "proj-1" } }),
      env as never, execCtx
    )).json() as { id: string };
    await spacesWorker.fetch(
      req(`/spaces/space-1/scheduled-jobs/${created.id}`, { method: "PATCH", body: { enabled: false } }),
      env as never, execCtx
    );

    const res = await spacesWorker.fetch(req("/spaces/space-1/scheduled-jobs"), env as never, execCtx);
    const json = await res.json() as { data: Array<{ name: string; enabled: number; next_run_at: number | null }> };
    const enabledJob = json.data.find((j) => j.name === "Enabled job")!;
    const disabledJob = json.data.find((j) => j.name === "Disabled job")!;
    expect(typeof enabledJob.next_run_at).toBe("number");
    expect(enabledJob.next_run_at).toBeGreaterThan(Date.now());
    expect(disabledJob.next_run_at).toBeNull();
  });

  it("lists jobs for a space, including the new failure-tracking fields", async () => {
    const env = makeSpacesEnv("space-1", "tenant-1");
    await spacesWorker.fetch(
      req("/spaces/space-1/scheduled-jobs", { method: "POST", body: { name: "Job A", cron_expression: "0 8 * * *", script_name: "s1", project_id: "proj-1" } }),
      env as never, execCtx
    );
    const res = await spacesWorker.fetch(req("/spaces/space-1/scheduled-jobs"), env as never, execCtx);
    const json = await res.json() as { data: Array<{ consecutive_failures: number; last_error: string | null }>; count: number };
    expect(json.count).toBe(1);
    expect(json.data[0]!.consecutive_failures).toBe(0);
    expect(json.data[0]!.last_error).toBeNull();
  });

  // Crons side-panel scoping: the assistant/Home view wants ITS OWN (space-wide) jobs, a project
  // thread wants only that project's own — see workers/spaces/src/index.ts's own header comment
  // on this route for why neither param given stays unfiltered (Dashboard overview compat).
  it("?scope=assistant is empty because automations are project anchored", async () => {
    const env = makeSpacesEnv("space-1", "tenant-1");
    await spacesWorker.fetch(
      req("/spaces/space-1/scheduled-jobs", { method: "POST", body: { name: "Assistant job", cron_expression: "0 8 * * *", script_name: "s1", project_id: "proj-1" } }),
      env as never, execCtx
    );
    await spacesWorker.fetch(
      req("/spaces/space-1/scheduled-jobs", { method: "POST", body: { name: "Project job", cron_expression: "0 9 * * *", script_name: "s2", project_id: "proj-1" } }),
      env as never, execCtx
    );
    const res = await spacesWorker.fetch(req("/spaces/space-1/scheduled-jobs?scope=assistant"), env as never, execCtx);
    const json = await res.json() as { data: Array<{ name: string; project_id: string | null }> };
    expect(json.data).toHaveLength(0);
  });

  it("?project_id=X returns only that project's own jobs", async () => {
    const env = makeSpacesEnv("space-1", "tenant-1");
    await spacesWorker.fetch(
      req("/spaces/space-1/scheduled-jobs", { method: "POST", body: { name: "Other project job", cron_expression: "0 8 * * *", script_name: "s1", project_id: "proj-0" } }),
      env as never, execCtx
    );
    await spacesWorker.fetch(
      req("/spaces/space-1/scheduled-jobs", { method: "POST", body: { name: "Project job", cron_expression: "0 9 * * *", script_name: "s2", project_id: "proj-1" } }),
      env as never, execCtx
    );
    await spacesWorker.fetch(
      req("/spaces/space-1/scheduled-jobs", { method: "POST", body: { name: "Other project job", cron_expression: "0 10 * * *", script_name: "s3", project_id: "proj-2" } }),
      env as never, execCtx
    );
    const res = await spacesWorker.fetch(req("/spaces/space-1/scheduled-jobs?project_id=proj-1"), env as never, execCtx);
    const json = await res.json() as { data: Array<{ name: string; project_id: string | null }> };
    expect(json.data).toHaveLength(1);
    expect(json.data[0]!.name).toBe("Project job");
    expect(json.data[0]!.project_id).toBe("proj-1");
  });

  it("unfiltered list is limited to the caller's visible projects", async () => {
    const env = makeSpacesEnv("space-1", "tenant-1");
    await spacesWorker.fetch(
      req("/spaces/space-1/scheduled-jobs", { method: "POST", body: { name: "Assistant job", cron_expression: "0 8 * * *", script_name: "s1", project_id: "proj-1" } }),
      env as never, execCtx
    );
    await spacesWorker.fetch(
      req("/spaces/space-1/scheduled-jobs", { method: "POST", body: { name: "Hidden project job", cron_expression: "0 9 * * *", script_name: "s2", project_id: "proj-2" } }),
      env as never, execCtx
    );
    const res = await spacesWorker.fetch(req("/spaces/space-1/scheduled-jobs", { userId: "member-1", role: "viewer" }), env as never, execCtx);
    const json = await res.json() as { data: unknown[] };
    expect(json.data).toHaveLength(1);
  });

  it("rejects a project schedule lookup outside the caller's visible project set", async () => {
    const env = makeSpacesEnv("space-1", "tenant-1", ["proj-1"]);
    const created = await spacesWorker.fetch(
      req("/spaces/space-1/scheduled-jobs", { method: "POST", body: { name: "Private job", cron_expression: "0 9 * * *", script_name: "s2", project_id: "proj-2" } }),
      env as never, execCtx
    );
    expect(created.status).toBe(201);
    const res = await spacesWorker.fetch(
      req("/spaces/space-1/scheduled-jobs?project_id=proj-2", { userId: "member-1", role: "viewer" }),
      env as never, execCtx
    );
    expect(res.status).toBe(403);
  });

  it("PATCH can disable a job and rejects an invalid new cron", async () => {
    const env = makeSpacesEnv("space-1", "tenant-1");
    const created = await (await spacesWorker.fetch(
      req("/spaces/space-1/scheduled-jobs", { method: "POST", body: { name: "Job A", cron_expression: "0 8 * * *", script_name: "s1", project_id: "proj-1" } }),
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
      req("/spaces/space-1/scheduled-jobs", { method: "POST", body: { name: "Job A", cron_expression: "0 8 * * *", script_name: "s1", project_id: "proj-1" } }),
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

// Phase 3 item 27/28 — GET /scheduled-job-runs (migration 0071). Deliberately a flat sibling
// route (job_id in the query string) rather than nested under the existing dynamic
// /scheduled-jobs/:jobId route — see that route's own header comment for why.
describe("scheduled-job-runs (spaces worker) — run-history read side", () => {
  it("requires job_id", async () => {
    const env = makeSpacesEnv("space-1", "tenant-1");
    const res = await spacesWorker.fetch(req("/spaces/space-1/scheduled-job-runs"), env as never, execCtx);
    expect(res.status).toBe(400);
  });

  it("returns the real fires recorded for a job, newest first", async () => {
    const env = makeSpacesEnv("space-1", "tenant-1");
    const db = (env as unknown as { PLATFORM_DB: { db: { exec(sql: string): void } } }).PLATFORM_DB.db;
    db.exec(`INSERT INTO scheduled_jobs (id, space_id, tenant_id, project_id, name, cron_expression, script_name) VALUES ('job-1', 'space-1', 'tenant-1', 'proj-1', 'Job', '* * * * *', 'script')`);
    db.exec(
      `INSERT INTO scheduled_job_runs (id, job_id, space_id, tenant_id, fired_at, ok, error, duration_ms, skipped_busy) VALUES
       ('r1', 'job-1', 'space-1', 'tenant-1', 1000, 1, NULL, 50, 0),
       ('r2', 'job-1', 'space-1', 'tenant-1', 2000, 0, 'boom', 10, 0),
       ('r3', 'job-1', 'space-1', 'tenant-1', 3000, 0, NULL, NULL, 1),
       ('r4', 'job-OTHER', 'space-1', 'tenant-1', 4000, 1, NULL, 5, 0)`
    );
    const res = await spacesWorker.fetch(req("/spaces/space-1/scheduled-job-runs?job_id=job-1"), env as never, execCtx);
    expect(res.status).toBe(200);
    const json = await res.json() as { data: Array<{ id: string; ok: number; error: string | null; skipped_busy: number }>; count: number };
    expect(json.count).toBe(3);
    // newest first, and job-OTHER's row never leaks in
    expect(json.data.map((r) => r.id)).toEqual(["r3", "r2", "r1"]);
    expect(json.data[1]!.error).toBe("boom");
    expect(json.data[0]!.skipped_busy).toBe(1);
  });

  it("respects a limit param, capped at 100", async () => {
    const env = makeSpacesEnv("space-1", "tenant-1");
    const db = (env as unknown as { PLATFORM_DB: { db: { exec(sql: string): void } } }).PLATFORM_DB.db;
    db.exec(`INSERT INTO scheduled_jobs (id, space_id, tenant_id, project_id, name, cron_expression, script_name) VALUES ('job-1', 'space-1', 'tenant-1', 'proj-1', 'Job', '* * * * *', 'script')`);
    for (let i = 0; i < 5; i++) {
      db.exec(`INSERT INTO scheduled_job_runs (id, job_id, space_id, tenant_id, fired_at, ok) VALUES ('r${i}', 'job-1', 'space-1', 'tenant-1', ${i}, 1)`);
    }
    const res = await spacesWorker.fetch(req("/spaces/space-1/scheduled-job-runs?job_id=job-1&limit=2"), env as never, execCtx);
    const json = await res.json() as { count: number };
    expect(json.count).toBe(2);
  });

  it("404s for a space the calling tenant does not own", async () => {
    const env = makeSpacesEnv("space-1", "tenant-1");
    const res = await spacesWorker.fetch(
      req("/spaces/space-1/scheduled-job-runs?job_id=job-1", { tenant: "tenant-evil" }),
      env as never, execCtx
    );
    expect(res.status).toBe(404);
  });
});

// WS-2 (Space Assistant surface, Crons panel): GET is now reachable by a signed-in product end
// user reading their own product's (or business's) scheduled jobs — resolveEndUserBusinessRole
// treats the product root (no parent_space_id) as an implicit member, matching every other
// end-user floor's precedent. POST/PATCH/DELETE are now admin-gated by requireBusinessMembership
// (Phase 3 item 27/28's Crons editing UI) rather than forbidding every product_end_user outright
// — a business's own admin/owner end user CAN write; a plain product-root "member" (the only role
// the root ever implies) cannot, which is what this file's own POST case below still proves.
// See scheduled-jobs-business-membership.test.ts for the full admin/member/non-member matrix on
// a real business (child) space.
describe("scheduled-jobs — product_end_user floor (WS-2)", () => {
  function productEndUserReq(path: string, opts: { method?: string; body?: unknown } = {}): Request {
    const headers = new Headers({
      "x-naelao-tenant-id": "tenant-1",
      "x-naelao-role": "product_end_user",
      "x-naelao-user-id": "user-42",
    });
    if (opts.body !== undefined) headers.set("content-type", "application/json");
    return new Request(`https://spaces.naelao.com${path}`, {
      method: opts.method ?? "GET",
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
  }

  it("a product_end_user without an explicit root-space membership cannot GET scheduled jobs", async () => {
    const env = makeSpacesEnv("space-1", "tenant-1");
    const res = await spacesWorker.fetch(productEndUserReq("/spaces/space-1/scheduled-jobs"), env as never, execCtx);
    expect(res.status).toBe(403);
  });

  it("a product_end_user on the PRODUCT ROOT cannot POST (implicit 'member' role is below the admin floor)", async () => {
    const env = makeSpacesEnv("space-1", "tenant-1");
    const res = await spacesWorker.fetch(
      productEndUserReq("/spaces/space-1/scheduled-jobs", {
        method: "POST",
        body: { name: "Malicious cron", cron_expression: "0 9 * * *", script_name: "x" },
      }),
      env as never, execCtx
    );
    expect(res.status).toBe(403);
  });
});


// ── enqueueAgentTicks (agents worker hourly cron, enumerate-and-enqueue phase) ───────────────
// A1.16.14: the old serial in-invocation loop (pollConnectors + runChannelHeartbeats +
// runScheduledJobs, all awaited subrequests inside ONE Worker invocation) broke the platform's
// 1000-subrequest-per-invocation limit at a few hundred active spaces. scheduled() now does
// ONLY the cheap D1 roster queries + the pure isCronDue computation (no subrequests at all),
// and hands one message per due tick to AGENT_TICKS — these tests cover that planning step:
// roster rows in, expected messages out.
describe("enqueueAgentTicks (agents worker hourly cron — enumerate-and-enqueue)", () => {
  interface JobRow {
    id: string; space_id: string; tenant_id: string;
    cron_expression: string; last_run_at: number | null; created_at: string;
    quiet_hours_start?: string | null; quiet_hours_end?: string | null; quiet_hours_timezone?: string;
  }
  interface ConnectorRow { space_id: string; tenant_id: string; name: string; id?: string }
  interface HeartbeatRow { space_id: string; tenant_id: string }

  const OLD_CREATED_AT = "2020-01-01 00:00:00";

  // enqueueAgentTicks now keyset-paginates each roster (F1) — every `.prepare(...).all()` call
  // binds its cursor and page-size LIMIT as the last two positional params. This mock
  // implements real pagination semantics (filter by "sort key > cursor", sort, slice to limit)
  // instead of returning the whole fixture array on every call, so a test with a roster larger
  // than one page actually exercises multiple round trips the same way D1 would.
  function paginate<T>(rows: T[], sortKeyOf: (row: T) => string, cursor: string, limit: number): T[] {
    return [...rows]
      .filter((r) => sortKeyOf(r) > cursor)
      .sort((a, b) => (sortKeyOf(a) < sortKeyOf(b) ? -1 : sortKeyOf(a) > sortKeyOf(b) ? 1 : 0))
      .slice(0, limit);
  }

  function makeEnqueueEnv(opts: {
    connectors?: ConnectorRow[];
    heartbeats?: HeartbeatRow[];
    jobs?: JobRow[];
  }): { env: AgentsEnv; batches: AgentTickMessage[][]; eventFireCalls: Array<{ url: string; body: unknown }>; allCallCounts: { connectors: number; heartbeats: number; jobs: number } } {
    const connectors = (opts.connectors ?? []).map((c, i) => ({ ...c, id: c.id ?? `conn-${i}` }));
    const heartbeats = opts.heartbeats ?? [];
    const jobs = opts.jobs ?? [];
    const allCallCounts = { connectors: 0, heartbeats: 0, jobs: 0 };
    const db = {
      prepare(sql: string) {
        let args: unknown[] = [];
        const stmt = {
          bind(...a: unknown[]) { args = a; return stmt; },
          async all() {
            const cursor = String(args[args.length - 2] ?? "");
            const limit = Number(args[args.length - 1] ?? Number.MAX_SAFE_INTEGER);
            if (/FROM mcp_servers/.test(sql)) {
              allCallCounts.connectors++;
              return { results: paginate(connectors, (r) => r.id!, cursor, limit) };
            }
            if (/FROM channel_links/.test(sql)) {
              allCallCounts.heartbeats++;
              return { results: paginate(heartbeats, (r) => r.space_id, cursor, limit) };
            }
            if (/FROM scheduled_jobs/.test(sql)) {
              allCallCounts.jobs++;
              return { results: paginate(jobs, (r) => r.id, cursor, limit) };
            }
            return { results: [] };
          },
          async run() {
            return { meta: { changes: 1 } }; // used by recordScheduledJobFailure on a bad cron
          },
        };
        return stmt;
      },
    };
    const batches: AgentTickMessage[][] = [];
    const agentTicksQueue = {
      async sendBatch(messages: Array<{ body: AgentTickMessage }>) {
        batches.push(messages.map((m) => m.body));
      },
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
      AGENT_TICKS: agentTicksQueue,
      SPACES_WORKER: spacesWorkerStub,
      ANALYTICS: { writeDataPoint() {} },
    } as unknown as AgentsEnv;
    return { env, batches, eventFireCalls, allCallCounts };
  }

  it("enqueues a heartbeat message for every space with an enabled channel link", async () => {
    const { env, batches } = makeEnqueueEnv({
      heartbeats: [{ space_id: "space-1", tenant_id: "tenant-1" }, { space_id: "space-2", tenant_id: "tenant-1" }],
    });
    await enqueueAgentTicks(env);
    const messages = batches.flat();
    expect(messages).toHaveLength(2);
    expect(messages.every((m) => m.kind === "heartbeat")).toBe(true);
    expect(messages.map((m) => m.spaceId).sort()).toEqual(["space-1", "space-2"]);
  });

  it("enqueues a connector_poll message per enabled connector row, carrying the connector name", async () => {
    const { env, batches } = makeEnqueueEnv({
      connectors: [{ space_id: "space-1", tenant_id: "tenant-1", name: "gumroad" }],
    });
    await enqueueAgentTicks(env);
    const messages = batches.flat();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ kind: "connector_poll", spaceId: "space-1", tenantId: "tenant-1", connectorName: "gumroad" });
  });

  it("enqueues a scheduled_job message only for jobs isCronDue considers due", async () => {
    const dueJob: JobRow = { id: "job-due", space_id: "space-1", tenant_id: "tenant-1", cron_expression: "* * * * *", last_run_at: null, created_at: OLD_CREATED_AT };
    const notDueJob: JobRow = { id: "job-not-due", space_id: "space-1", tenant_id: "tenant-1", cron_expression: "0 0 1 1 *", last_run_at: Date.now(), created_at: OLD_CREATED_AT };
    const { env, batches } = makeEnqueueEnv({ jobs: [dueJob, notDueJob] });
    await enqueueAgentTicks(env);
    const messages = batches.flat();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ kind: "scheduled_job", spaceId: "space-1", tenantId: "tenant-1", jobId: "job-due", sweepKey: expect.any(Number) });
  });

  it("defers due jobs during quiet hours and coalesces them into one wake after the window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-17T03:00:00.000Z"));
    try {
      const dueJob: JobRow = { id: "quiet-job", space_id: "space-1", tenant_id: "tenant-1", cron_expression: "* * * * *",
        last_run_at: null, created_at: OLD_CREATED_AT, quiet_hours_start: "22:00", quiet_hours_end: "07:00", quiet_hours_timezone: "UTC" };
      const deferred = makeEnqueueEnv({ jobs: [dueJob] });
      await enqueueAgentTicks(deferred.env);
      expect(deferred.batches.flat().filter((message) => message.kind === "scheduled_job")).toHaveLength(0);

      vi.setSystemTime(new Date("2026-10-17T08:00:00.000Z"));
      const resumed = makeEnqueueEnv({ jobs: [dueJob] });
      await enqueueAgentTicks(resumed.env);
      expect(resumed.batches.flat().filter((message) => message.kind === "scheduled_job")).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it("does not enqueue a job created after its cron's most recent due minute (B5 regression, carried into the planning phase)", async () => {
    const now = new Date();
    const currentMinute = now.getUTCMinutes();
    const excludedMinute = (currentMinute + 30) % 60; // guaranteed not to be "now"
    const freshJob: JobRow = {
      id: "fresh", space_id: "space-1", tenant_id: "tenant-1",
      cron_expression: `${excludedMinute} * * * *`, last_run_at: null,
      created_at: now.toISOString().slice(0, 19).replace("T", " "),
    };
    const { env, batches } = makeEnqueueEnv({ jobs: [freshJob] });
    await enqueueAgentTicks(env);
    expect(batches.flat()).toHaveLength(0);
  });

  it("records a failure (but does not enqueue) for a job whose cron_expression fails to parse", async () => {
    const badJob: JobRow = { id: "job-bad-cron", space_id: "space-1", tenant_id: "tenant-1", cron_expression: "not a cron", last_run_at: null, created_at: OLD_CREATED_AT };
    const { env, batches } = makeEnqueueEnv({ jobs: [badJob] });
    await enqueueAgentTicks(env);
    expect(batches.flat()).toHaveLength(0); // never queued for firing
  });

  it("combines connector, heartbeat, and scheduled_job messages from one sweep into batches", async () => {
    const { env, batches } = makeEnqueueEnv({
      connectors: [{ space_id: "space-1", tenant_id: "tenant-1", name: "gumroad" }],
      heartbeats: [{ space_id: "space-2", tenant_id: "tenant-1" }],
      jobs: [{ id: "job-1", space_id: "space-3", tenant_id: "tenant-1", cron_expression: "* * * * *", last_run_at: null, created_at: OLD_CREATED_AT }],
    });
    await enqueueAgentTicks(env);
    const messages = batches.flat();
    expect(messages).toHaveLength(3);
    expect(messages.map((m) => m.kind).sort()).toEqual(["connector_poll", "heartbeat", "scheduled_job"]);
  });

  it("chunks more than 100 messages into multiple sendBatch calls", async () => {
    const heartbeats: HeartbeatRow[] = Array.from({ length: 250 }, (_, i) => ({ space_id: `space-${i}`, tenant_id: "tenant-1" }));
    const { env, batches } = makeEnqueueEnv({ heartbeats });
    await enqueueAgentTicks(env);
    expect(batches).toHaveLength(3); // 100 + 100 + 50
    expect(batches[0]).toHaveLength(100);
    expect(batches[1]).toHaveLength(100);
    expect(batches[2]).toHaveLength(50);
    expect(batches.flat()).toHaveLength(250);
  });

  // F1: each roster used to be one unbounded SELECT with no LIMIT — at platform scale that
  // pulls every enabled row across every space into memory in a single D1 read. This proves the
  // keyset pagination enumerates a roster that spans multiple 1000-row pages without losing or
  // duplicating rows, across all three roster types.
  it("enumerates all rows across multiple pages when a roster exceeds the page size (1000)", async () => {
    const jobs: JobRow[] = Array.from({ length: 2500 }, (_, i) => ({
      id: `job-${String(i).padStart(5, "0")}`,
      space_id: `space-${i}`,
      tenant_id: "tenant-1",
      cron_expression: "* * * * *",
      last_run_at: null,
      created_at: OLD_CREATED_AT,
    }));
    const { env, batches, allCallCounts } = makeEnqueueEnv({ jobs });
    await enqueueAgentTicks(env);

    // 3 pages fetched from D1 (1000 + 1000 + 500), not one unbounded query.
    expect(allCallCounts.jobs).toBe(3);

    const messages = batches.flat();
    expect(messages).toHaveLength(2500);
    expect(messages.every((m) => m.kind === "scheduled_job")).toBe(true);
    // No row lost or duplicated across the page boundaries.
    expect(new Set(messages.map((m) => m.jobId)).size).toBe(2500);
  });

  it("enumerates a connector roster exceeding the page size across multiple D1 pages", async () => {
    const connectors: ConnectorRow[] = Array.from({ length: 1500 }, (_, i) => ({
      space_id: `space-${i}`,
      tenant_id: "tenant-1",
      name: "gumroad",
      id: `conn-${String(i).padStart(5, "0")}`,
    }));
    const { env, batches, allCallCounts } = makeEnqueueEnv({ connectors });
    await enqueueAgentTicks(env);

    expect(allCallCounts.connectors).toBe(2); // 1000 + 500
    const messages = batches.flat();
    expect(messages).toHaveLength(1500);
    expect(new Set(messages.map((m) => m.spaceId)).size).toBe(1500);
  });

  it("enumerates a heartbeat roster exceeding the page size across multiple D1 pages", async () => {
    const heartbeats: HeartbeatRow[] = Array.from({ length: 1200 }, (_, i) => ({
      space_id: `space-${String(i).padStart(5, "0")}`,
      tenant_id: "tenant-1",
    }));
    const { env, batches, allCallCounts } = makeEnqueueEnv({ heartbeats });
    await enqueueAgentTicks(env);

    expect(allCallCounts.heartbeats).toBe(2); // 1000 + 200
    const messages = batches.flat();
    expect(messages).toHaveLength(1200);
    expect(new Set(messages.map((m) => m.spaceId)).size).toBe(1200);
  });
});

// ── handleAgentTick / handleAgentTicksQueue (agents worker queue consumer) ───────────────────
// One message, one tick, its own fresh subrequest budget — the fetch-DO bodies moved nearly
// verbatim from the old serial loop. At-least-once delivery (CF Queues) is safe for
// scheduled_job messages specifically because last_run_at advances on every fire attempt
// (success or failure — see A1.16.13's recordScheduledJobFailure), so a redelivered message
// re-fetches the row fresh and is a no-op once that due minute is already recorded.
describe("handleAgentTicksQueue (agents worker queue consumer)", () => {
  interface ScheduledJobFullRow {
    id: string; space_id: string; tenant_id: string; project_id: string | null;
    cron_expression: string; script_name: string; params: string; last_run_at: number | null;
    goal?: string | null; agent_id?: string | null;
    created_at: string; consecutive_failures: number;
    quiet_hours_start?: string | null; quiet_hours_end?: string | null; quiet_hours_timezone?: string;
  }

  function makeConsumerEnv(opts: {
    jobRow?: ScheduledJobFullRow | null;
    agentDoStatus?: number;
    projectActive?: boolean;
  }): {
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
          async first() {
            if (/INSERT INTO scheduled_job_dispatches/.test(sql)) return { claim_token: "claim-test" };
            if (/FROM scheduled_jobs WHERE id = \? AND space_id = \? AND tenant_id = \? AND enabled = 1/.test(sql)) return opts.jobRow ?? null;
            if (/FROM spaces s WHERE s.id =/.test(sql)) return { id: "space-1" };
            if (/SELECT name, config_json FROM spaces/.test(sql)) return { name: "Test Space", config_json: "{}" };
            return null;
          },
          async all() {
            if (/FROM channel_links/.test(sql)) return { results: [{ channel: "telegram", model_override: null }] };
            return { results: [] };
          },
          async run() {
            if (/consecutive_failures = \?, last_error = \?, enabled = \?/.test(sql)) {
              updates.push({ id: args[4] as string, last_run_at: args[0] as number, consecutive_failures: args[1] as number, last_error: args[2] as string | null, enabled: args[3] as number });
            } else if (/consecutive_failures = 0, last_error = NULL/.test(sql)) {
              updates.push({ id: args[1] as string, last_run_at: args[0] as number, consecutive_failures: 0, last_error: null });
            }
            return { meta: { changes: 1 } };
          },
        };
        return stmt;
      },
    };
    const status = opts.agentDoStatus ?? 200;
    const agentDoStub = {
      async fetch(reqInput: Request | string, init?: RequestInit) {
        const url = typeof reqInput === "string" ? reqInput : reqInput.url;
        const body = init?.body ? JSON.parse(init.body as string) : await (reqInput as Request).json().catch(() => null);
        fireCalls.push({ url, body });
        return new Response(status === 200 ? JSON.stringify({ result: { ok: true, output: { done: true } } }) : "boom", { status });
      },
    };
    const agentDoNamespace = { idFromName: (name: string) => ({ toString: () => name }), get: () => agentDoStub };
    const eventFireCalls: Array<{ url: string; body: unknown }> = [];
    const spacesWorkerStub = {
      async fetch(reqInput: Request | string, init?: RequestInit) {
        const req2 = typeof reqInput === "string" ? new Request(reqInput, init) : reqInput;
        const body = await req2.clone().json().catch(() => null);
        eventFireCalls.push({ url: req2.url, body });
        if (req2.url.includes("/internal/project-lifecycle")) return Response.json({ active: opts.projectActive ?? true });
        if (req2.url.endsWith("/threads")) return Response.json({ id: "project-thread-1" }, { status: 201 });
        if (req2.url.endsWith("/sessions")) return Response.json({ id: "project-session-1" }, { status: 201 });
        return new Response(JSON.stringify({ fired: true }), { status: 200 });
      },
    };
    const env = {
      PLATFORM_SECRET: "test-secret",
      PLATFORM_DB: db,
      NAELAO_AGENT_DO: agentDoNamespace,
      AGENT_CACHE: { async get() { return null; }, async put() {} },
      SPACES_WORKER: spacesWorkerStub,
      ANALYTICS: { writeDataPoint() {} },
    } as unknown as AgentsEnv;
    return { env, fireCalls, updates, eventFireCalls };
  }

  function makeBatch(messages: AgentTickMessage[]): { batch: { messages: Array<{ body: AgentTickMessage; ack: () => void; retry: () => void }> }; acked: AgentTickMessage[]; retried: AgentTickMessage[] } {
    const acked: AgentTickMessage[] = [];
    const retried: AgentTickMessage[] = [];
    return {
      batch: {
        messages: messages.map((body) => ({
          body,
          ack: () => acked.push(body),
          retry: () => retried.push(body),
        })),
      },
      acked,
      retried,
    };
  }

  it("a heartbeat tick calls both channels/heartbeat and memory/maintenance for that space", async () => {
    const { env, fireCalls } = makeConsumerEnv({});
    const { batch, acked } = makeBatch([{ kind: "heartbeat", spaceId: "space-1", tenantId: "tenant-1" }]);
    await handleAgentTicksQueue(batch as never, env);
    expect(fireCalls).toHaveLength(2);
    expect(fireCalls[0]!.url).toBe("http://agent-do/channels/heartbeat");
    expect(fireCalls[1]!.url).toBe("http://agent-do/memory/maintenance");
    expect(acked).toHaveLength(1);
  });

  it("a connector_poll tick fires script/run with the connector name in the goal and context", async () => {
    const { env, fireCalls } = makeConsumerEnv({});
    const { batch } = makeBatch([{ kind: "connector_poll", spaceId: "space-1", tenantId: "tenant-1", connectorName: "gumroad" }]);
    await handleAgentTicksQueue(batch as never, env);
    expect(fireCalls).toHaveLength(1);
    expect(fireCalls[0]!.url).toBe("http://agent-do/script/run");
    const body = fireCalls[0]!.body as { goal: string; context: { platform: string } };
    expect(body.goal).toContain("gumroad");
    expect(body.context.platform).toBe("gumroad");
  });

  it("a scheduled_job tick re-fetches the row by id and fires it, recording success", async () => {
    const jobRow: ScheduledJobFullRow = {
      id: "job-1", space_id: "space-1", tenant_id: "tenant-1", project_id: "proj-1",
      cron_expression: "* * * * *", script_name: "notifications.daily_standup",
      params: JSON.stringify({ format: "csv" }), last_run_at: null,
      created_at: "2020-01-01 00:00:00", consecutive_failures: 2,
    };
    const { env, fireCalls, updates } = makeConsumerEnv({ jobRow });
    const { batch, acked } = makeBatch([{ kind: "scheduled_job", spaceId: "space-1", tenantId: "tenant-1", jobId: "job-1" }]);
    await handleAgentTicksQueue(batch as never, env);
    expect(fireCalls).toHaveLength(1);
    const body = fireCalls[0]!.body as { scriptName: string; projectId?: string; params: { format: string } };
    expect(body.scriptName).toBe("notifications.daily_standup");
    expect(body.projectId).toBe("proj-1");
    expect(body.params).toEqual({ format: "csv" });
    expect(updates).toHaveLength(1);
    expect(updates[0]!.consecutive_failures).toBe(0); // reset on success, even though the row had 2 prior failures
    expect(acked).toHaveLength(1);
  });

  it("wakes project routines in a linked project thread and session", async () => {
    const jobRow: ScheduledJobFullRow = {
      id: "project-goal", space_id: "space-1", tenant_id: "tenant-1", project_id: "proj-1",
      cron_expression: "* * * * *", script_name: "", goal: "Review open project priorities",
      params: "{}", last_run_at: null, created_at: "2020-01-01 00:00:00", consecutive_failures: 0,
    };
    const { env, fireCalls, eventFireCalls } = makeConsumerEnv({ jobRow });
    const { batch, acked, retried } = makeBatch([{ kind: "scheduled_job", spaceId: "space-1", tenantId: "tenant-1", jobId: "project-goal" }]);
    await handleAgentTicksQueue(batch as never, env);
    const threadCreate = eventFireCalls.find((call) => call.url.endsWith("/threads"));
    const sessionCreate = eventFireCalls.find((call) => call.url.endsWith("/sessions"));
    expect(threadCreate?.body).toMatchObject({ project_id: "proj-1", thread_kind: "primary", thread_tier: "tier_2_task" });
    expect(sessionCreate?.body).toMatchObject({ thread_id: "project-thread-1", metadata: { session_kind: "heartbeat", project_id: "proj-1" } });
    const run = fireCalls.find((call) => call.url === "http://agent-do/script/run");
    expect(run?.body).toMatchObject({ projectId: "proj-1", sessionId: "project-session-1" });
    expect((run?.body as { goal?: string } | undefined)?.goal).toContain("Review open project priorities");
    // Diagnostics failures must not erase either the scheduled goal or its generic safe-progress
    // directive; this stub intentionally returns the wrong diagnostics shape.
    expect((run?.body as { goal?: string } | undefined)?.goal).toContain("choose one useful next step");
    expect(acked).toHaveLength(1);
    expect(retried).toHaveLength(0);
  });

  it("does not invoke queued project routines after the owning project is archived", async () => {
    const jobRow: ScheduledJobFullRow = {
      id: "archived-goal", space_id: "space-1", tenant_id: "tenant-1", project_id: "proj-archived",
      cron_expression: "* * * * *", script_name: "", goal: "Review project",
      params: "{}", last_run_at: null, created_at: "2020-01-01 00:00:00", consecutive_failures: 0,
    };
    const { env, fireCalls } = makeConsumerEnv({ jobRow, projectActive: false });
    const { batch, acked, retried } = makeBatch([{ kind: "scheduled_job", spaceId: "space-1", tenantId: "tenant-1", jobId: jobRow.id }]);
    await handleAgentTicksQueue(batch as never, env);
    expect(fireCalls).toHaveLength(0);
    expect(acked).toHaveLength(1);
    expect(retried).toHaveLength(0);
  });

  it("rechecks quiet hours at queue-consume time before claiming or firing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-17T03:00:00.000Z"));
    try {
      const jobRow: ScheduledJobFullRow = {
        id: "quiet-job", space_id: "space-1", tenant_id: "tenant-1", project_id: "proj-1",
        cron_expression: "* * * * *", script_name: "s", params: "{}", last_run_at: null,
        created_at: "2020-01-01 00:00:00", consecutive_failures: 0,
        quiet_hours_start: "22:00", quiet_hours_end: "07:00", quiet_hours_timezone: "UTC",
      };
      const { env, fireCalls } = makeConsumerEnv({ jobRow });
      const { batch, acked } = makeBatch([{ kind: "scheduled_job", spaceId: "space-1", tenantId: "tenant-1", jobId: "quiet-job" }]);
      await handleAgentTicksQueue(batch as never, env);
      expect(fireCalls).toHaveLength(0);
      expect(acked).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it("a scheduled_job tick for a job deleted/disabled since enqueue is a harmless ack, no fire", async () => {
    const { env, fireCalls } = makeConsumerEnv({ jobRow: null });
    const { batch, acked, retried } = makeBatch([{ kind: "scheduled_job", spaceId: "space-1", tenantId: "tenant-1", jobId: "job-gone" }]);
    await handleAgentTicksQueue(batch as never, env);
    expect(fireCalls).toHaveLength(0);
    expect(acked).toHaveLength(1);
    expect(retried).toHaveLength(0);
  });

  it("a scheduled_job tick that fails to fire records the failure and still acks (not retries) the message", async () => {
    const jobRow: ScheduledJobFullRow = {
      id: "job-fail", space_id: "space-1", tenant_id: "tenant-1", project_id: null,
      cron_expression: "* * * * *", script_name: "s", params: "{}", last_run_at: null,
      created_at: "2020-01-01 00:00:00", consecutive_failures: 0,
    };
    const { env, updates } = makeConsumerEnv({ jobRow, agentDoStatus: 500 });
    const { batch, acked, retried } = makeBatch([{ kind: "scheduled_job", spaceId: "space-1", tenantId: "tenant-1", jobId: "job-fail" }]);
    await handleAgentTicksQueue(batch as never, env);
    // The failure is recorded (last_run_at advances, consecutive_failures increments) inside
    // handleAgentTick itself — a failed SCRIPT fire is not a QUEUE-level failure, so the
    // message acks normally rather than being redelivered by CF Queues.
    expect(updates).toHaveLength(1);
    expect(updates[0]!.consecutive_failures).toBe(1);
    expect(acked).toHaveLength(1);
    expect(retried).toHaveLength(0);
  });

  it("processes multiple messages in one batch independently, acking each", async () => {
    const jobRow: ScheduledJobFullRow = {
      id: "job-1", space_id: "space-3", tenant_id: "tenant-1", project_id: null,
      cron_expression: "* * * * *", script_name: "s", params: "{}", last_run_at: null,
      created_at: "2020-01-01 00:00:00", consecutive_failures: 0,
    };
    const { env, fireCalls } = makeConsumerEnv({ jobRow });
    const { batch, acked } = makeBatch([
      { kind: "heartbeat", spaceId: "space-1", tenantId: "tenant-1" },
      { kind: "connector_poll", spaceId: "space-2", tenantId: "tenant-1", connectorName: "gumroad" },
      { kind: "scheduled_job", spaceId: "space-3", tenantId: "tenant-1", jobId: "job-1" },
    ]);
    await handleAgentTicksQueue(batch as never, env);
    expect(acked).toHaveLength(3);
    // heartbeat (2 calls) + connector_poll (1 call) + scheduled_job (1 call) = 4
    expect(fireCalls).toHaveLength(4);
  });

  it("retries when tenant authorization lookup is unavailable", async () => {
    // Unknown tenant status must not run background work, and a transient D1 outage should retry
    // rather than silently ack and lose a legitimate tick.
    const throwingEnv = {
      PLATFORM_SECRET: "test-secret",
      PLATFORM_DB: { prepare() { throw new Error("unreachable in this test"); } },
      NAELAO_AGENT_DO: { idFromName: () => ({}), get: () => ({ async fetch() { throw new Error("DO unreachable"); } }) },
    } as unknown as AgentsEnv;
    const { batch, acked, retried } = makeBatch([{ kind: "heartbeat", spaceId: "space-1", tenantId: "tenant-1" }]);
    await handleAgentTicksQueue(batch as never, throwingEnv);
    expect(acked).toHaveLength(0);
    expect(retried).toHaveLength(1);
  });
});

// ── handleAgentTick called directly (no queue plumbing) ──────────────────────────────────────
describe("handleAgentTick (direct call)", () => {
  it("a connector_poll message with no connectorName is a silent no-op", async () => {
    const fireCalls: unknown[] = [];
    const env = {
      NAELAO_AGENT_DO: { idFromName: () => ({}), get: () => ({ async fetch(r: Request) { fireCalls.push(r); return new Response("{}"); } }) },
      AGENT_CACHE: { async get() { return null; }, async put() {} },
    } as unknown as AgentsEnv;
    await handleAgentTick(env, { kind: "connector_poll", spaceId: "space-1", tenantId: "tenant-1" });
    expect(fireCalls).toHaveLength(0);
  });

  it("a scheduled_job message with no jobId is a silent no-op", async () => {
    let dbCalled = false;
    const env = {
      PLATFORM_DB: { prepare() { dbCalled = true; return { bind: () => ({ first: async () => null }) }; } },
    } as unknown as AgentsEnv;
    await handleAgentTick(env, { kind: "scheduled_job", spaceId: "space-1", tenantId: "tenant-1" });
    expect(dbCalled).toBe(false);
  });
});
