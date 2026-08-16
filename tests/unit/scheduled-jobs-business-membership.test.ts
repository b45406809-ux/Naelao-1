import { describe, it, expect } from "vitest";
import spacesWorker from "../../workers/spaces/src/index.js";
import { mintInternalToken } from "@naelao/http";
import { createFakeD1 } from "../stubs/d1-sqlite.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 3 item 27/28's own Crons editing UI needed real write access for a business's own
// admin/owner end user — POST used to forbid every product_end_user outright (mirrored in the
// older scheduled-jobs.test.ts's own "product_end_user floor (WS-2)" describe block), which left
// every end-user-created business with no self-serve way to create/edit/delete a scheduled job
// at all. This mirrors assistant-policy-and-model-config-business-membership.test.ts's exact
// harness — same requireBusinessMembership pattern, same fake D1, no SpaceDO needed since these
// routes operate directly on PLATFORM_DB.

const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const PLATFORM_SECRET = "test-platform-secret";

const SCHEDULED_JOBS_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0041_scheduled_jobs.sql"), "utf8");
const SCHEDULED_JOBS_FAILURES_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0042_scheduled_jobs_failures.sql"), "utf8");
const SCHEDULED_JOBS_AGENT_GOAL_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0043_scheduled_jobs_agent_goal.sql"), "utf8");
const SCHEDULED_JOB_RUNS_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0071_scheduled_job_runs.sql"), "utf8");
const BUSINESS_MEMBERSHIPS_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0047_business_memberships.sql"), "utf8");

const SPACES_TABLE_SQL = `
  CREATE TABLE spaces (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    name TEXT NOT NULL DEFAULT '', spacetype_id TEXT NOT NULL DEFAULT 'launchpad',
    config_json TEXT, parent_space_id TEXT
  );
`;

function makeEnv() {
  const fakeDb = createFakeD1([
    SPACES_TABLE_SQL,
    SCHEDULED_JOBS_MIGRATION,
    SCHEDULED_JOBS_FAILURES_MIGRATION,
    SCHEDULED_JOBS_AGENT_GOAL_MIGRATION,
    SCHEDULED_JOB_RUNS_MIGRATION,
    BUSINESS_MEMBERSHIPS_MIGRATION,
  ]);
  fakeDb.db.exec("INSERT INTO spaces (id, tenant_id, status, name) VALUES ('prod-root', 'tenant-1', 'active', 'Product')");
  fakeDb.db.exec("INSERT INTO spaces (id, tenant_id, status, name, parent_space_id) VALUES ('biz-alice', 'tenant-1', 'active', 'Alice Biz', 'prod-root')");
  fakeDb.db.exec("INSERT INTO business_memberships (business_space_id, product_space_id, end_user_id, role, status) VALUES ('biz-alice', 'prod-root', 'alice', 'admin', 'active')");
  fakeDb.db.exec("INSERT INTO business_memberships (business_space_id, product_space_id, end_user_id, role, status) VALUES ('biz-alice', 'prod-root', 'alice-member', 'member', 'active')");
  return { PLATFORM_SECRET, ENVIRONMENT: "test", PLATFORM_DB: fakeDb };
}

async function endUserHeaders(tenantId: string, endUserId: string): Promise<Record<string, string>> {
  const token = await mintInternalToken(PLATFORM_SECRET, tenantId);
  return {
    "content-type": "application/json",
    "x-naelao-tenant-id": tenantId,
    "x-naelao-internal-token": token,
    "x-naelao-role": "product_end_user",
    "x-naelao-user-id": endUserId,
  };
}

function req(path: string, headers: Record<string, string>, init?: RequestInit): Request {
  return new Request(`https://spaces.naelao.com${path}`, { ...init, headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) } });
}

describe("scheduled-jobs POST — business membership gate", () => {
  it("a business admin end user CAN create a scheduled job on their own business", async () => {
    const env = makeEnv();
    const headers = await endUserHeaders("tenant-1", "alice");
    const res = await spacesWorker.fetch(
      req("/spaces/biz-alice/scheduled-jobs", headers, {
        method: "POST",
        body: JSON.stringify({ name: "Weekly review", cron_expression: "0 9 * * 1", goal: "Review the business" }),
      }),
      env as never, execCtx
    );
    expect(res.status).toBe(201);
  });

  it("a plain member (not admin) cannot create one", async () => {
    const env = makeEnv();
    const headers = await endUserHeaders("tenant-1", "alice-member");
    const res = await spacesWorker.fetch(
      req("/spaces/biz-alice/scheduled-jobs", headers, {
        method: "POST",
        body: JSON.stringify({ name: "Sneaky cron", cron_expression: "0 9 * * *", goal: "x" }),
      }),
      env as never, execCtx
    );
    expect(res.status).toBe(403);
  });

  it("a non-member of this business cannot create one", async () => {
    const env = makeEnv();
    const headers = await endUserHeaders("tenant-1", "someone-else");
    const res = await spacesWorker.fetch(
      req("/spaces/biz-alice/scheduled-jobs", headers, {
        method: "POST",
        body: JSON.stringify({ name: "Sneaky cron", cron_expression: "0 9 * * *", goal: "x" }),
      }),
      env as never, execCtx
    );
    expect(res.status).toBe(403);
  });

  it("on the PRODUCT ROOT, a product_end_user only ever gets implicit 'member' — never enough to create", async () => {
    const env = makeEnv();
    const headers = await endUserHeaders("tenant-1", "alice"); // alice has no membership row on prod-root itself
    const res = await spacesWorker.fetch(
      req("/spaces/prod-root/scheduled-jobs", headers, {
        method: "POST",
        body: JSON.stringify({ name: "Root cron", cron_expression: "0 9 * * *", goal: "x" }),
      }),
      env as never, execCtx
    );
    expect(res.status).toBe(403);
  });

  it("a builder JWT-style caller (no x-naelao-role) is unaffected", async () => {
    const env = makeEnv();
    const token = await mintInternalToken(PLATFORM_SECRET, "tenant-1");
    const builderHeaders = { "content-type": "application/json", "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token };
    const res = await spacesWorker.fetch(
      req("/spaces/biz-alice/scheduled-jobs", builderHeaders, {
        method: "POST",
        body: JSON.stringify({ name: "Builder cron", cron_expression: "0 9 * * *", goal: "x" }),
      }),
      env as never, execCtx
    );
    expect(res.status).toBe(201);
  });
});

describe("scheduled-jobs PATCH/DELETE :jobId — business membership gate", () => {
  async function createJob(env: ReturnType<typeof makeEnv>): Promise<string> {
    const token = await mintInternalToken(PLATFORM_SECRET, "tenant-1");
    const builderHeaders = { "content-type": "application/json", "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token };
    const res = await spacesWorker.fetch(
      req("/spaces/biz-alice/scheduled-jobs", builderHeaders, {
        method: "POST",
        body: JSON.stringify({ name: "Existing", cron_expression: "0 9 * * *", goal: "x" }),
      }),
      env as never, execCtx
    );
    const body = await res.json<{ id: string }>();
    return body.id;
  }

  it("a business admin end user CAN edit their own business's scheduled job", async () => {
    const env = makeEnv();
    const jobId = await createJob(env);
    const headers = await endUserHeaders("tenant-1", "alice");
    const res = await spacesWorker.fetch(
      req(`/spaces/biz-alice/scheduled-jobs/${jobId}`, headers, { method: "PATCH", body: JSON.stringify({ enabled: false }) }),
      env as never, execCtx
    );
    expect(res.status).toBe(200);
  });

  it("a business admin end user CAN delete their own business's scheduled job", async () => {
    const env = makeEnv();
    const jobId = await createJob(env);
    const headers = await endUserHeaders("tenant-1", "alice");
    const res = await spacesWorker.fetch(
      req(`/spaces/biz-alice/scheduled-jobs/${jobId}`, headers, { method: "DELETE" }),
      env as never, execCtx
    );
    expect(res.status).toBe(200);
  });

  it("a plain member cannot edit or delete", async () => {
    const env = makeEnv();
    const jobId = await createJob(env);
    const headers = await endUserHeaders("tenant-1", "alice-member");
    const patchRes = await spacesWorker.fetch(
      req(`/spaces/biz-alice/scheduled-jobs/${jobId}`, headers, { method: "PATCH", body: JSON.stringify({ enabled: false }) }),
      env as never, execCtx
    );
    expect(patchRes.status).toBe(403);
    const deleteRes = await spacesWorker.fetch(
      req(`/spaces/biz-alice/scheduled-jobs/${jobId}`, headers, { method: "DELETE" }),
      env as never, execCtx
    );
    expect(deleteRes.status).toBe(403);
  });

  it("a builder JWT-style caller is unaffected", async () => {
    const env = makeEnv();
    const jobId = await createJob(env);
    const token = await mintInternalToken(PLATFORM_SECRET, "tenant-1");
    const builderHeaders = { "content-type": "application/json", "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token };
    const res = await spacesWorker.fetch(
      req(`/spaces/biz-alice/scheduled-jobs/${jobId}`, builderHeaders, { method: "PATCH", body: JSON.stringify({ enabled: false }) }),
      env as never, execCtx
    );
    expect(res.status).toBe(200);
  });
});
