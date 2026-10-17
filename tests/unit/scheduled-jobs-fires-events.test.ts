import { describe, it, expect } from "vitest";
import spacesWorker from "../../workers/spaces/src/index.js";
import { SpaceDO } from "../../workers/spaces/src/do/SpaceDO.js";
import { createFakeD1 } from "../stubs/d1-sqlite.js";
import { createDOStorage } from "./helpers/sqlite-do-shim.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mintInternalToken } from "@naelao/http";

// Phase 3 item 29 — a cron's own CONFIG change (created/updated/enabled/paused/deleted) fires an
// event through the same event_triggers path every other structural mutation already uses.
//
// This is the REAL end-to-end regression test the older DO-only harness
// (space-fire-external-event.test.ts) could not provide: it drives the actual spacesWorker Hono
// app's POST/PATCH/DELETE /scheduled-jobs routes, through the real forwardToSpaceDO call, into a
// REAL SpaceDO instance — the exact path that was silently broken (forwardToSpaceDO never
// forwarded x-naelao-tenant-id as a header, so /internal/events/fire always 400'd) until this
// same pass fixed fireExternalEvent to also accept tenant_id via the query string. A test that
// only exercised the DO directly (with a hand-set header) would never have caught that gap.

const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const PLATFORM_SECRET = "test-platform-secret";

const SPACES_TABLE_SQL = `
  CREATE TABLE spaces (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    name TEXT NOT NULL DEFAULT '', spacetype_id TEXT NOT NULL DEFAULT 'launchpad',
    config_json TEXT, parent_space_id TEXT
  );
`;
function readMigration(name: string): string {
  return readFileSync(join(__dirname, "../../infra/migrations", name), "utf8");
}
const SCHEDULED_JOBS_MIGRATION = readMigration("0041_scheduled_jobs.sql");
const SCHEDULED_JOBS_FAILURES_MIGRATION = readMigration("0042_scheduled_jobs_failures.sql");
const SCHEDULED_JOBS_AGENT_GOAL_MIGRATION = readMigration("0043_scheduled_jobs_agent_goal.sql");
const SCHEDULED_JOB_RUNS_MIGRATION = readMigration("0071_scheduled_job_runs.sql");
const SCHEDULED_JOB_QUIET_HOURS_MIGRATION = readMigration("0106_scheduled_job_quiet_hours.sql");

/** A stateful DO namespace like fake-do-namespace.ts's own makeStatefulDoNamespace, but ALSO
 *  injects a fixed env (PLATFORM_SECRET + a capturing AGENTS_WORKER fake) into every SpaceDO
 *  instance it constructs — makeStatefulDoNamespace always builds with {} and has no way to do
 *  this, and fireMatchingTriggers needs both to actually dispatch. Kept local to this file rather
 *  than widening the shared helper's signature for every OTHER test file that uses it. */
function makeStatefulSpaceDoNamespaceWithEnv(env: Record<string, unknown>): { namespace: DurableObjectNamespace; calls: Request[] } {
  const calls: Request[] = [];
  const AGENTS_WORKER = {
    async fetch(reqInput: Request | string, init?: RequestInit) {
      const req = typeof reqInput === "string" ? new Request(reqInput, init) : reqInput;
      calls.push(req);
      return new Response(JSON.stringify({ result: "ok" }), { status: 200 });
    },
  };
  const instances = new Map<string, { instance: SpaceDO; storage: ReturnType<typeof createDOStorage>; seeded: boolean }>();
  function getOrCreate(name: string) {
    let entry = instances.get(name);
    if (!entry) {
      const ctx = { storage: createDOStorage() };
      entry = { instance: new SpaceDO(ctx as never, { ...env, AGENTS_WORKER } as never), storage: ctx.storage, seeded: false };
      instances.set(name, entry);
    }
    return entry;
  }
  const namespace = {
    idFromName(name: string) {
      return { toString: () => name } as unknown as DurableObjectId;
    },
    get(id: DurableObjectId) {
      const entry = getOrCreate(id.toString());
      return { fetch: async (req: Request) => {
        if (!entry.seeded) {
          await entry.instance.fetch(new Request("http://space-do/__initialize"));
          entry.storage.sql.exec(
            "INSERT OR IGNORE INTO projects (id, space_id, name, description, status, created_at) VALUES (?, ?, ?, '', 'active', ?)",
            "project-1", "space-1", "Automation", new Date().toISOString(),
          );
          entry.seeded = true;
        }
        return entry.instance.fetch(req);
      } } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
  return { namespace, calls };
}

function makeEnv() {
  const fakeDb = createFakeD1([
    SPACES_TABLE_SQL,
    SCHEDULED_JOBS_MIGRATION,
    SCHEDULED_JOBS_FAILURES_MIGRATION,
    SCHEDULED_JOBS_AGENT_GOAL_MIGRATION,
    SCHEDULED_JOB_RUNS_MIGRATION,
    SCHEDULED_JOB_QUIET_HOURS_MIGRATION,
  ]);
  fakeDb.db.exec("INSERT INTO spaces (id, tenant_id, status, name) VALUES ('space-1', 'tenant-1', 'active', 'Test Space')");
  const { namespace, calls } = makeStatefulSpaceDoNamespaceWithEnv({ PLATFORM_SECRET, PLATFORM_DB: fakeDb });
  return { env: { PLATFORM_SECRET, ENVIRONMENT: "test", PLATFORM_DB: fakeDb, SPACE_DO: namespace }, calls };
}

async function builderReq(path: string, init?: RequestInit): Promise<Request> {
  const token = await mintInternalToken(PLATFORM_SECRET, "tenant-1");
  return new Request(`https://spaces.naelao.com${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token, ...(init?.headers as Record<string, string> | undefined) },
  });
}

async function registerTrigger(env: ReturnType<typeof makeEnv>["env"], eventType: string, scriptName: string): Promise<void> {
  const res = await spacesWorker.fetch(
    await builderReq("/spaces/space-1/event-triggers", {
      method: "POST",
      body: JSON.stringify({ project_id: "project-1", event_type: eventType, script_name: scriptName, condition: { type: "always" } }),
    }),
    env as never, execCtx
  );
  expect(res.status).toBe(201);
}

function scriptNamesFired(calls: Request[]): Promise<string[]> {
  return Promise.all(calls.map(async (r) => ((await r.clone().json()) as { scriptName: string }).scriptName));
}

describe("scheduled-jobs CRUD fires scheduled_job.* events end to end (through the real worker + DO)", () => {
  it("POST fires scheduled_job.created", async () => {
    const { env, calls } = makeEnv();
    await registerTrigger(env, "scheduled_job.created", "on-cron-created");
    const res = await spacesWorker.fetch(
      await builderReq("/spaces/space-1/scheduled-jobs", {
        method: "POST",
        body: JSON.stringify({ name: "Weekly review", cron_expression: "0 9 * * 1", goal: "Review", project_id: "project-1" }),
      }),
      env as never, execCtx
    );
    expect(res.status).toBe(201);
    expect(await scriptNamesFired(calls)).toEqual(["on-cron-created"]);
  });

  it("PATCH {enabled:false} fires scheduled_job.paused, not scheduled_job.updated", async () => {
    const { env, calls } = makeEnv();
    await registerTrigger(env, "scheduled_job.paused", "on-cron-paused");
    await registerTrigger(env, "scheduled_job.updated", "on-cron-updated");
    const created = await spacesWorker.fetch(
      await builderReq("/spaces/space-1/scheduled-jobs", {
        method: "POST",
        body: JSON.stringify({ name: "Job", cron_expression: "0 9 * * *", goal: "x", project_id: "project-1" }),
      }),
      env as never, execCtx
    ).then((r) => r.json<{ id: string }>());
    calls.length = 0; // ignore the .created firing from the setup POST above

    const res = await spacesWorker.fetch(
      await builderReq(`/spaces/space-1/scheduled-jobs/${created.id}`, { method: "PATCH", body: JSON.stringify({ enabled: false }) }),
      env as never, execCtx
    );
    expect(res.status).toBe(200);
    expect(await scriptNamesFired(calls)).toEqual(["on-cron-paused"]);
  });

  it("PATCH {enabled:true} fires scheduled_job.enabled", async () => {
    const { env, calls } = makeEnv();
    await registerTrigger(env, "scheduled_job.enabled", "on-cron-enabled");
    const created = await spacesWorker.fetch(
      await builderReq("/spaces/space-1/scheduled-jobs", {
        method: "POST",
        body: JSON.stringify({ name: "Job", cron_expression: "0 9 * * *", goal: "x", project_id: "project-1" }),
      }),
      env as never, execCtx
    ).then((r) => r.json<{ id: string }>());
    calls.length = 0;

    await spacesWorker.fetch(
      await builderReq(`/spaces/space-1/scheduled-jobs/${created.id}`, { method: "PATCH", body: JSON.stringify({ enabled: true }) }),
      env as never, execCtx
    );
    expect(await scriptNamesFired(calls)).toEqual(["on-cron-enabled"]);
  });

  it("PATCH of ordinary fields (no `enabled`) fires scheduled_job.updated", async () => {
    const { env, calls } = makeEnv();
    await registerTrigger(env, "scheduled_job.updated", "on-cron-updated");
    const created = await spacesWorker.fetch(
      await builderReq("/spaces/space-1/scheduled-jobs", {
        method: "POST",
        body: JSON.stringify({ name: "Job", cron_expression: "0 9 * * *", goal: "x", project_id: "project-1" }),
      }),
      env as never, execCtx
    ).then((r) => r.json<{ id: string }>());
    calls.length = 0;

    await spacesWorker.fetch(
      await builderReq(`/spaces/space-1/scheduled-jobs/${created.id}`, { method: "PATCH", body: JSON.stringify({ name: "Renamed" }) }),
      env as never, execCtx
    );
    expect(await scriptNamesFired(calls)).toEqual(["on-cron-updated"]);
  });

  it("DELETE fires scheduled_job.deleted", async () => {
    const { env, calls } = makeEnv();
    await registerTrigger(env, "scheduled_job.deleted", "on-cron-deleted");
    const created = await spacesWorker.fetch(
      await builderReq("/spaces/space-1/scheduled-jobs", {
        method: "POST",
        body: JSON.stringify({ name: "Job", cron_expression: "0 9 * * *", goal: "x", project_id: "project-1" }),
      }),
      env as never, execCtx
    ).then((r) => r.json<{ id: string }>());
    calls.length = 0;

    const res = await spacesWorker.fetch(
      await builderReq(`/spaces/space-1/scheduled-jobs/${created.id}`, { method: "DELETE" }),
      env as never, execCtx
    );
    expect(res.status).toBe(200);
    expect(await scriptNamesFired(calls)).toEqual(["on-cron-deleted"]);
  });

  it("firing is best-effort — the CRUD response still succeeds even if event_triggers has nothing configured", async () => {
    const { env, calls } = makeEnv();
    const res = await spacesWorker.fetch(
      await builderReq("/spaces/space-1/scheduled-jobs", {
        method: "POST",
        body: JSON.stringify({ name: "Job", cron_expression: "0 9 * * *", goal: "x", project_id: "project-1" }),
      }),
      env as never, execCtx
    );
    expect(res.status).toBe(201);
    expect(calls).toHaveLength(0);
  });
});
