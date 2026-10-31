import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { after, before, test } from "node:test";

const require = createRequire(import.meta.url);
const { unstable_dev } = require("wrangler");
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.."
);
let worker;
let persistPath;
let identity;
const runStartedAt = new Date().toISOString();
const runStarted = performance.now();
const metrics = {
  schema_version: 1,
  runtime: "local-wrangler",
  started_at: runStartedAt,
  migration_sql_files: 0,
  migration_apply_ms: 0,
  worker_start_ms: 0,
  requests: [],
};

before(
  async () => {
    persistPath = await mkdtemp(
      path.join(os.tmpdir(), "naelao-blackboard-do-")
    );
    metrics.migration_sql_files = (
      await readdir(path.join(repoRoot, "infra/migrations"))
    ).filter((file) => file.endsWith(".sql")).length;
    const migrationStarted = performance.now();
    execFileSync(
      path.join(repoRoot, "node_modules/.bin/wrangler"),
      [
        "d1",
        "migrations",
        "apply",
        "naelao-blackboard-test",
        "--local",
        "--config",
        path.join(repoRoot, "tests/plan/runtime/spaces.wrangler.toml"),
        "--persist-to",
        persistPath,
      ],
      { cwd: repoRoot, stdio: "ignore" }
    );
    metrics.migration_apply_ms = Math.round(
      performance.now() - migrationStarted
    );
    const workerStarted = performance.now();
    worker = await unstable_dev(
      path.join(repoRoot, "tests/plan/runtime/spaces-worker-test-entry.ts"),
      {
        config: path.join(repoRoot, "tests/plan/runtime/spaces.wrangler.toml"),
        local: true,
        persistTo: persistPath,
        logLevel: "error",
        experimental: { disableExperimentalWarning: true, forceLocal: true },
      }
    );
    metrics.worker_start_ms = Math.round(performance.now() - workerStarted);
    const bootstrapStarted = performance.now();
    const response = await worker.fetch("http://worker/__test/bootstrap", {
      method: "POST",
    });
    assert.equal(response.status, 200, await response.clone().text());
    metrics.requests.push({
      route: "POST /__test/bootstrap",
      status: response.status,
      duration_ms: Math.round(performance.now() - bootstrapStarted),
    });
    identity = await response.json();
  },
  { timeout: 180_000 }
);

after(async () => {
  await worker?.stop();
  if (persistPath) await rm(persistPath, { recursive: true, force: true });
  metrics.finished_at = new Date().toISOString();
  metrics.total_duration_ms = Math.round(performance.now() - runStarted);
  const serializedMetrics = `${JSON.stringify(metrics, null, 2)}\n`;
  console.log(`NAELAO_RUNTIME_METRICS ${JSON.stringify(metrics)}`);
  if (process.env.NAELAO_RUNTIME_RESULTS_PATH) {
    const resultPath = path.resolve(process.env.NAELAO_RUNTIME_RESULTS_PATH);
    await mkdir(path.dirname(resultPath), { recursive: true });
    await writeFile(resultPath, serializedMetrics);
  }
});

function headers(userId = identity.userId, role = "owner") {
  return {
    "content-type": "application/json",
    "x-naelao-tenant-id": identity.tenantId,
    "x-naelao-user-id": userId,
    "x-naelao-role": role,
    "x-naelao-internal-token": identity.token,
  };
}

async function jsonRequest(pathname, method, body) {
  const started = performance.now();
  const response = await worker.fetch(`http://worker${pathname}`, {
    method,
    headers: headers(),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  metrics.requests.push({
    route: `${method} ${pathname}`,
    status: response.status,
    duration_ms: Math.round(performance.now() - started),
  });
  assert.ok(response.ok, `${method} ${pathname}: ${response.status} ${text}`);
  return parsed;
}

test("migrated D1 drives a provider-free blackboard wake through real Spaces and Agent Durable Objects", async () => {
  const { spaceId } = identity;
  const project = await jsonRequest(`/spaces/${spaceId}/projects`, "POST", {
    name: "Runtime Acceptance Project",
    description: "Local D1 and SpaceDO integration fixture",
  });
  assert.ok(project.id, "project ID should be issued by SpaceDO");

  const wakeResult = await jsonRequest("/__test/wake", "POST", {
    projectId: project.id,
  });
  assert.deepEqual(wakeResult.sweep, { checked: 1 });
  assert.equal(wakeResult.wake.status, "held");
  assert.equal(wakeResult.wake.attempts, 1);
  assert.equal(wakeResult.dispatchResponses.length, 1);
  metrics.blackboard_dispatch = wakeResult.dispatchResponses;
  metrics.blackboard_wake_status = wakeResult.wake.status;
  assert.ok(
    wakeResult.dispatchResponses[0].status >= 400,
    "air-gapped fixture must stop before a cloud-model call"
  );
  assert.equal(wakeResult.dispatchResponses[0].status, 403);
  assert.equal(
    wakeResult.dispatchResponses[0].body?.error_code,
    "compliance_violation"
  );
  assert.notEqual(
    wakeResult.dispatchResponses[0].status,
    404,
    "the dispatch must reach a registered AgentDO script-run handler"
  );
  assert.notEqual(
    wakeResult.dispatchResponses[0].body?.error_code,
    "heartbeat_scope_mismatch",
    "the AgentDO must reach the real Spaces Worker to verify its heartbeat session"
  );
  assert.ok(
    wakeResult.threads.data?.some(
      (thread) =>
        thread.project_id === project.id &&
        thread.title.startsWith("Project routine") &&
        Boolean(thread.session_id)
    ),
    "the production wake coordinator should create a durable Project Bot thread/session before fail-closed local model admission"
  );

  const access = await jsonRequest(
    `/spaces/${spaceId}/projects/${project.id}/assistant-access?user_id=${identity.userId}`,
    "GET"
  );
  assert.ok(
    access.effective_role,
    "assistant access should resolve through SpaceDO"
  );

  const thread = await jsonRequest(`/spaces/${spaceId}/threads`, "POST", {
    project_id: project.id,
    title: "Blackboard wake — runtime acceptance",
    thread_kind: "primary",
    thread_tier: "tier_2_task",
  });
  assert.ok(thread.id, "Project Bot thread should be created by SpaceDO");
  assert.equal(thread.project_id, project.id);

  const session = await jsonRequest(`/spaces/${spaceId}/sessions`, "POST", {
    thread_id: thread.id,
    metadata: {
      session_kind: "heartbeat",
      project_id: project.id,
      title: "Blackboard wake — runtime acceptance",
    },
  });
  assert.ok(session.id, "heartbeat session should be created by SpaceDO");

  const reopenedThread = await jsonRequest(
    `/spaces/${spaceId}/threads/${thread.id}`,
    "GET"
  );
  assert.equal(reopenedThread.project_id, project.id);
  assert.equal(reopenedThread.session_id, session.id);

  const persistedSession = await jsonRequest(
    `/spaces/${spaceId}/sessions/${session.id}`,
    "GET"
  );
  assert.equal(persistedSession.id, session.id);
  assert.deepEqual(JSON.parse(persistedSession.metadata), {
    session_kind: "heartbeat",
    project_id: project.id,
    title: "Blackboard wake — runtime acceptance",
  });
});

test("real D1 membership data denies a viewer permission to create Project Bot threads", async () => {
  const started = performance.now();
  const response = await worker.fetch(
    `http://worker/spaces/${identity.spaceId}/threads`,
    {
      method: "POST",
      headers: headers(identity.viewerId, "product_end_user"),
      body: JSON.stringify({
        project_id: "project-that-should-not-be-created",
        title: "unauthorized viewer request",
      }),
    }
  );
  metrics.requests.push({
    route: "POST /spaces/:spaceId/threads (viewer denial)",
    status: response.status,
    duration_ms: Math.round(performance.now() - started),
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    error_code: "forbidden",
    message: "Insufficient role for this action",
  });
});
