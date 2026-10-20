import { describe, expect, it } from "vitest";
import { mintInternalToken } from "@naelao/http";
import spacesWorker from "../../workers/spaces/src/index.js";
import { createFakeD1 } from "../stubs/d1-sqlite.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SECRET = "steward-test-secret";
const SPACE = "space-1";
const TENANT = "tenant-1";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function database() {
  const db = createFakeD1([
    `CREATE TABLE spaces (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL, parent_space_id TEXT, name TEXT, spacetype_id TEXT, config_json TEXT);`,
    readFileSync(join(__dirname, "../../infra/migrations/0041_scheduled_jobs.sql"), "utf8"),
    readFileSync(join(__dirname, "../../infra/migrations/0042_scheduled_jobs_failures.sql"), "utf8"),
    readFileSync(join(__dirname, "../../infra/migrations/0043_scheduled_jobs_agent_goal.sql"), "utf8"),
    readFileSync(join(__dirname, "../../infra/migrations/0107_project_steward_daily_runs.sql"), "utf8"),
    readFileSync(join(__dirname, "../../infra/migrations/0108_project_steward_decisions.sql"), "utf8"),
    readFileSync(join(__dirname, "../../infra/migrations/0112_extension_provider_connections.sql"), "utf8"),
    readFileSync(join(__dirname, "../../infra/migrations/0113_whatsapp_extension_phone_routing.sql"), "utf8"),
  ]);
  db.db.exec(`INSERT INTO spaces (id,tenant_id,status,name,spacetype_id) VALUES ('${SPACE}','${TENANT}','active','Test Space','launchpad')`);
  db.db.exec(`INSERT INTO scheduled_jobs (id,space_id,tenant_id,project_id,name,cron_expression,script_name,consecutive_failures) VALUES
    ('visible-job','${SPACE}','${TENANT}','project-visible','Review','0 * * * *','review',2),
    ('hidden-job','${SPACE}','${TENANT}','project-hidden','Review','0 * * * *','review',5)`);
  return db;
}

describe("project steward review route", () => {
  it("returns only visible project facts and never includes lifecycle actions", async () => {
    const platformDb = database();
    const visibleProjects = [{ id: "project-visible", name: "Visible project", status: "active", created_at: "2025-01-01T00:00:00Z", last_activity_at: null }];
    const env = {
      PLATFORM_SECRET: SECRET,
      ENVIRONMENT: "test",
      PLATFORM_DB: platformDb,
      SPACE_DO: {
        idFromName: (name: string) => name,
        get: () => ({ fetch: async (request: Request) => request.url.includes("project-steward-facts")
          ? Response.json({ data: [{ project_id: "project-visible", project_name: "Visible project", created_at: "2025-01-01T00:00:00Z", last_activity_at: null, pending_task_count: 0, in_progress_task_count: 0, blocked_task_count: 0, active_extension_count: 0 }] })
          : Response.json({ data: visibleProjects }) }),
      },
    };
    const token = await mintInternalToken(SECRET, TENANT);
    const res = await spacesWorker.fetch(new Request(`https://spaces.naelao.com/spaces/${SPACE}/project-steward/reviews`, {
      headers: {
        "x-naelao-tenant-id": TENANT,
        "x-naelao-user-id": "member-1",
        "x-naelao-role": "viewer",
        "x-naelao-internal-token": token,
      },
    }), env as never, ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<{ project_id: string; recommendation: string; confidence: string; evidence: unknown[] }>; advisory_only: boolean };
    expect(body.advisory_only).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ project_id: "project-visible", recommendation: "inspect_routine", confidence: "high" });
    expect(JSON.stringify(body.data)).not.toContain("project-hidden");
    expect(JSON.stringify(body.data)).not.toMatch(/archive|delete|pause|shutdown/i);
    platformDb.db.close();
  });

  it("exposes only typed portfolio summaries to an authenticated read-only steward grant", async () => {
    const platformDb = database();
    const projects = [
      { id: "project-visible", name: "Visible", status: "active", created_at: "2025-01-01T00:00:00Z", last_activity_at: null },
      { id: "project-archived", name: "Archived", status: "archived", created_at: "2025-01-01T00:00:00Z", last_activity_at: null },
    ];
    const env = {
      PLATFORM_SECRET: SECRET, ENVIRONMENT: "test", PLATFORM_DB: platformDb,
      SPACE_DO: { idFromName: (name: string) => name, get: () => ({ fetch: async (request: Request) => request.url.includes("project-steward-facts")
        ? Response.json({ data: [{ project_id: "project-visible", project_name: "Visible", created_at: "2025-01-01T00:00:00Z", last_activity_at: null, pending_task_count: 0, in_progress_task_count: 0, blocked_task_count: 0, active_extension_count: 0 }] })
        : Response.json({ data: projects }) }) },
    };
    const path = `https://spaces.naelao.com/internal/spaces/${SPACE}/project-steward/summary`;
    const denied = await spacesWorker.fetch(new Request(path), env as never, ctx);
    expect(denied.status).toBe(403);
    const token = await mintInternalToken(SECRET, TENANT);
    const response = await spacesWorker.fetch(new Request(path, { headers: { "x-naelao-tenant-id": TENANT, "x-naelao-internal-token": token } }), env as never, ctx);
    expect(response.status).toBe(200);
    const body = await response.json() as { grant: string; data: Array<Record<string, unknown>> };
    expect(body.grant).toBe("space.project_steward.read_summary.v1");
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ project_id: "project-visible", project_name: "Visible", failed_routines: [{ routine_id: "visible-job", consecutive_failures: 2 }] });
    expect(JSON.stringify(body)).not.toMatch(/project-hidden|Archived|member|message|workspace|archive|delete|pause/i);
    platformDb.db.close();
  });

  it("serves saved daily reports only for projects the caller can still see", async () => {
    const platformDb = database();
    platformDb.db.exec(`INSERT INTO project_steward_runs(space_id,tenant_id,last_successful_run_at,report_json,updated_at)
      VALUES ('${SPACE}','${TENANT}',1792195200000,'{"run_day":"2026-10-17","generated_at":1792195200000,"advisory_only":true,"data":[{"project_id":"project-visible","project_name":"Visible project","recommendation":"owner_check_in","confidence":"low","priority":30,"evidence":[{"kind":"inactivity","days":30,"last_activity_at":null}]},{"project_id":"project-hidden","project_name":"Hidden project","recommendation":"inspect_routine","confidence":"high","priority":100,"evidence":[{"kind":"routine_failures","count":2}]}]}',1792195200000)`);
    const env = {
      PLATFORM_SECRET: SECRET, ENVIRONMENT: "test", PLATFORM_DB: platformDb,
      SPACE_DO: { idFromName: (name: string) => name, get: () => ({ fetch: async (request: Request) => request.url.includes("project-steward-facts")
        ? Response.json({ data: [{ project_id: "project-visible", project_name: "Visible", created_at: "2025-01-01T00:00:00Z", last_activity_at: null, pending_task_count: 0, in_progress_task_count: 0, blocked_task_count: 0, active_extension_count: 0 }] })
        : Response.json({ data: [{ id: "project-visible", name: "Visible", status: "active", created_at: "2025-01-01T00:00:00Z", last_activity_at: null }] }) }) },
    };
    const token = await mintInternalToken(SECRET, TENANT);
    const response = await spacesWorker.fetch(new Request(`https://spaces.naelao.com/spaces/${SPACE}/project-steward/reviews`, {
      headers: { "x-naelao-tenant-id": TENANT, "x-naelao-user-id": "member-1", "x-naelao-role": "viewer", "x-naelao-internal-token": token },
    }), env as never, ctx);
    expect(response.status).toBe(200);
    const body = await response.json() as { run_day: string; advisory_only: boolean; data: Array<{ project_id: string }> };
    expect(body.run_day).toBe("2026-10-17");
    expect(body.advisory_only).toBe(true);
    expect(body.data.map((row) => row.project_id)).toEqual(["project-visible"]);
    platformDb.db.close();
  });

  it("records owner-attributed review decisions and hides only the matching snoozed or dismissed evidence", async () => {
    const platformDb = database();
    const env = {
      PLATFORM_SECRET: SECRET, ENVIRONMENT: "test", PLATFORM_DB: platformDb,
      SPACE_DO: { idFromName: (name: string) => name, get: () => ({ fetch: async (request: Request) => request.url.includes("project-steward-facts")
        ? Response.json({ data: [{ project_id: "project-visible", project_name: "Visible project", created_at: "2025-01-01T00:00:00Z", last_activity_at: null, pending_task_count: 0, in_progress_task_count: 0, blocked_task_count: 0, active_extension_count: 0 }] })
        : Response.json({ data: [{ id: "project-visible", name: "Visible project", status: "active", created_at: "2025-01-01T00:00:00Z", last_activity_at: null }] }) }) },
    };
    const token = await mintInternalToken(SECRET, TENANT);
    const headers = { "content-type": "application/json", "x-naelao-tenant-id": TENANT, "x-naelao-user-id": "owner-1", "x-naelao-role": "owner", "x-naelao-internal-token": token };
    const reviewsUrl = `https://spaces.naelao.com/spaces/${SPACE}/project-steward/reviews`;
    const initial = await spacesWorker.fetch(new Request(reviewsUrl, { headers }), env as never, ctx);
    const initialBody = await initial.json() as { data: Array<{ project_id: string; review_key: string; recommendation: string }> };
    expect(initialBody.data).toHaveLength(1);
    const review = initialBody.data[0]!;
    const decisionUrl = `${reviewsUrl}/decision`;
    const denied = await spacesWorker.fetch(new Request(decisionUrl, { method: "POST", headers: { ...headers, "x-naelao-role": "member" },
      body: JSON.stringify({ project_id: review.project_id, review_key: review.review_key, recommendation: review.recommendation, action: "dismiss" }) }), env as never, ctx);
    expect(denied.status).toBe(403);
    const saved = await spacesWorker.fetch(new Request(decisionUrl, { method: "POST", headers,
      body: JSON.stringify({ project_id: review.project_id, review_key: review.review_key, recommendation: review.recommendation, action: "acknowledge", note: "Checked with the project lead" }) }), env as never, ctx);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ action: "acknowledge", actor_id: "owner-1" });
    const after = await spacesWorker.fetch(new Request(reviewsUrl, { headers }), env as never, ctx);
    expect(await after.json()).toMatchObject({ data: [{ decision: { action: "acknowledge", actor_id: "owner-1", note: "Checked with the project lead" } }] });
    const dismissed = await spacesWorker.fetch(new Request(decisionUrl, { method: "POST", headers,
      body: JSON.stringify({ project_id: review.project_id, review_key: review.review_key, recommendation: review.recommendation, action: "dismiss" }) }), env as never, ctx);
    expect(dismissed.status).toBe(200);
    const hiddenAuthorized = await spacesWorker.fetch(new Request(reviewsUrl, { headers: { ...headers, "x-naelao-internal-token": token } }), env as never, ctx);
    expect(await hiddenAuthorized.json()).toMatchObject({ data: [], count: 0 });
    platformDb.db.close();
  });

  it("provisions a platform-managed Space-wide Steward via the normal extension install lifecycle", async () => {
    const platformDb = database();
    let forwarded: Record<string, unknown> | undefined;
    const env = {
      PLATFORM_SECRET: SECRET, ENVIRONMENT: "test", PLATFORM_DB: platformDb,
      SPACE_DO: { idFromName: (name: string) => name, get: () => ({ fetch: async (request: Request) => {
        forwarded = await request.json() as Record<string, unknown>;
        return Response.json({ installationId: "installation-steward-1" }, { status: 201 });
      } }) },
    };
    const path = `https://spaces.naelao.com/internal/spaces/${SPACE}/project-steward/installation`;
    const denied = await spacesWorker.fetch(new Request(path, { method: "POST" }), env as never, ctx);
    expect(denied.status).toBe(403);
    const token = await mintInternalToken(SECRET, TENANT);
    const response = await spacesWorker.fetch(new Request(path, { method: "POST", headers: { "x-naelao-tenant-id": TENANT, "x-naelao-internal-token": token } }), env as never, ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ extension_id: "ext_project_steward", installation_id: "installation-steward-1", scope: "SPACE_SHARED", platform_managed: true });
    expect(forwarded).toMatchObject({ installedBy: "naelao-platform", scope: "SPACE_SHARED", gatekeeperCapabilities: ["space.project_steward.read_summary"] });
    expect(forwarded?.manifest).toMatchObject({ id: "ext_project_steward", declaredPermissions: [], gadgets: [], daemons: [], commands: [] });
    platformDb.db.close();
  });
});
