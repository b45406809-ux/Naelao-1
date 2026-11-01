import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import net from "node:net";
import { after, before, test } from "node:test";

const require = createRequire(import.meta.url);
const wranglerCli = require.resolve("wrangler");
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.."
);
let spacesWorker;
let agentsWorker;
let persistPath;
let spacesBaseUrl;
let agentsBaseUrl;
let identity;
let runtimeRestartCount = 0;
const runStartedAt = new Date().toISOString();
const runStarted = performance.now();
const metrics = {
  schema_version: 1,
  runtime: "local-wrangler",
  started_at: runStartedAt,
  migration_sql_files: 0,
  migration_apply_ms: 0,
  worker_start_ms: 0,
  spaces_worker_start_ms: 0,
  agents_worker_start_ms: 0,
  requests: [],
};

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  return address.port;
}

function startWorker(configPath, port) {
  const child = spawn(
    process.execPath,
    [
      wranglerCli,
      "dev",
      "--config",
      configPath,
      "--port",
      String(port),
      "--local",
      "--persist-to",
      persistPath,
      "--log-level",
      "error",
    ],
    { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] }
  );
  child.outputTail = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      child.outputTail = `${child.outputTail}${chunk}`.slice(-12_000);
    });
  }
  return child;
}

async function waitForWorker(child, baseUrl) {
  const deadline = Date.now() + 60_000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Wrangler worker exited early:\n${child.outputTail}`);
    }
    try {
      await fetch(`${baseUrl}/__runtime_ready`, {
        signal: AbortSignal.timeout(1000),
      });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  throw new Error(
    `Wrangler worker did not become ready: ${String(lastError)}\n${child.outputTail}`
  );
}

async function stopWorker(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

async function startLocalWorkers() {
  const spacesPort = await availablePort();
  const agentsPort = await availablePort();
  spacesBaseUrl = `http://127.0.0.1:${spacesPort}`;
  agentsBaseUrl = `http://127.0.0.1:${agentsPort}`;
  const spacesStarted = performance.now();
  spacesWorker = startWorker(
    path.join(repoRoot, "tests/plan/runtime/spaces.wrangler.toml"),
    spacesPort
  );
  await waitForWorker(spacesWorker, spacesBaseUrl);
  const spacesWorkerStartMs = Math.round(performance.now() - spacesStarted);
  const agentsStarted = performance.now();
  agentsWorker = startWorker(
    path.join(repoRoot, "tests/plan/runtime/agents.wrangler.toml"),
    agentsPort
  );
  await waitForWorker(agentsWorker, agentsBaseUrl);
  const agentsWorkerStartMs = Math.round(performance.now() - agentsStarted);
  return {
    spacesWorkerStartMs,
    agentsWorkerStartMs,
    totalWorkerStartMs: spacesWorkerStartMs + agentsWorkerStartMs,
  };
}

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
    const workerStart = await startLocalWorkers();
    metrics.spaces_worker_start_ms = workerStart.spacesWorkerStartMs;
    metrics.agents_worker_start_ms = workerStart.agentsWorkerStartMs;
    metrics.worker_start_ms = workerStart.totalWorkerStartMs;
    const bootstrapStarted = performance.now();
    const response = await fetch(`${agentsBaseUrl}/__test/bootstrap`, {
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
  await stopWorker(agentsWorker);
  await stopWorker(spacesWorker);
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

async function jsonRequest(baseUrl, pathname, method, body) {
  const started = performance.now();
  const response = await fetch(`${baseUrl}${pathname}`, {
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

test("separate Spaces and Agents Workers coordinate a provider-free blackboard wake through real Durable Objects", async () => {
  const { spaceId } = identity;
  const project = await jsonRequest(
    spacesBaseUrl,
    `/spaces/${spaceId}/projects`,
    "POST",
    {
      name: "Runtime Acceptance Project",
      description: "Local D1 and SpaceDO integration fixture",
    }
  );
  assert.ok(project.id, "project ID should be issued by SpaceDO");

  const wakeResult = await jsonRequest(agentsBaseUrl, "/__test/wake", "POST", {
    projectId: project.id,
  });
  assert.deepEqual(wakeResult.sweep, { checked: 1 });
  assert.deepEqual(wakeResult.repeatSweep, { checked: 0 });
  assert.equal(wakeResult.wake.status, "held");
  assert.equal(wakeResult.wake.attempts, 1);
  assert.deepEqual(wakeResult.requestCounts, { requests: 1, events: 1 });
  assert.equal(wakeResult.conflictingRequestStatus, 409);
  assert.deepEqual(wakeResult.conflictingRequestBody, {
    error_code: "request_id_conflict",
  });
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
    spacesBaseUrl,
    `/spaces/${spaceId}/projects/${project.id}/assistant-access?user_id=${identity.userId}`,
    "GET"
  );
  assert.ok(
    access.effective_role,
    "assistant access should resolve through SpaceDO"
  );

  const thread = await jsonRequest(
    spacesBaseUrl,
    `/spaces/${spaceId}/threads`,
    "POST",
    {
      project_id: project.id,
      title: "Blackboard wake — runtime acceptance",
      thread_kind: "primary",
      thread_tier: "tier_2_task",
    }
  );
  assert.ok(thread.id, "Project Bot thread should be created by SpaceDO");
  assert.equal(thread.project_id, project.id);

  const session = await jsonRequest(
    spacesBaseUrl,
    `/spaces/${spaceId}/sessions`,
    "POST",
    {
      thread_id: thread.id,
      metadata: {
        session_kind: "heartbeat",
        project_id: project.id,
        title: "Blackboard wake — runtime acceptance",
      },
    }
  );
  assert.ok(session.id, "heartbeat session should be created by SpaceDO");

  const reopenedThread = await jsonRequest(
    spacesBaseUrl,
    `/spaces/${spaceId}/threads/${thread.id}`,
    "GET"
  );
  assert.equal(reopenedThread.project_id, project.id);
  assert.equal(reopenedThread.session_id, session.id);

  const persistedSession = await jsonRequest(
    spacesBaseUrl,
    `/spaces/${spaceId}/sessions/${session.id}`,
    "GET"
  );
  assert.equal(persistedSession.id, session.id);
  assert.deepEqual(JSON.parse(persistedSession.metadata), {
    session_kind: "heartbeat",
    project_id: project.id,
    title: "Blackboard wake — runtime acceptance",
  });

  await stopWorker(agentsWorker);
  await stopWorker(spacesWorker);
  const restartStarted = performance.now();
  const restart = await startLocalWorkers();
  runtimeRestartCount++;
  metrics.runtime_restart_ms = Math.round(performance.now() - restartStarted);
  metrics.restart_worker_start = restart;
  const afterRestartThread = await jsonRequest(
    spacesBaseUrl,
    `/spaces/${spaceId}/threads/${thread.id}`,
    "GET"
  );
  assert.equal(afterRestartThread.session_id, session.id);
  const afterRestartSession = await jsonRequest(
    spacesBaseUrl,
    `/spaces/${spaceId}/sessions/${session.id}`,
    "GET"
  );
  assert.equal(afterRestartSession.id, session.id);
  assert.deepEqual(JSON.parse(afterRestartSession.metadata), {
    session_kind: "heartbeat",
    project_id: project.id,
    title: "Blackboard wake — runtime acceptance",
  });
  metrics.runtime_restart_count = runtimeRestartCount;
});

test("concurrent wake sweepers claim one Project Bot event exactly once", async () => {
  const project = await jsonRequest(
    spacesBaseUrl,
    `/spaces/${identity.spaceId}/projects`,
    "POST",
    { name: "Concurrent Wake Claim Project" }
  );
  const wakeResult = await jsonRequest(agentsBaseUrl, "/__test/wake", "POST", {
    projectId: project.id,
    concurrentSweepCount: 16,
  });

  assert.equal(wakeResult.concurrentSweeps.length, 16);
  assert.ok(
    wakeResult.concurrentSweeps.every((result) => result.checked <= 1),
    "each concurrent sweep should inspect at most the one fixture wake"
  );
  assert.equal(
    wakeResult.dispatchResponses.length,
    1,
    "only one racing sweeper may dispatch the event"
  );
  assert.equal(wakeResult.wake.attempts, 1);
  assert.equal(wakeResult.wake.status, "held");
  assert.equal(wakeResult.dispatchResponses[0].status, 403);
  assert.equal(
    wakeResult.dispatchResponses[0].body?.error_code,
    "compliance_violation"
  );
  assert.equal(wakeResult.repeatSweep.checked, 0);
});

test("real D1 authority revocation holds a pending wake without AgentDO dispatch", async () => {
  const project = await jsonRequest(
    spacesBaseUrl,
    `/spaces/${identity.spaceId}/projects`,
    "POST",
    {
      name: "Revoked Authority Project",
      description: "Revocation failure-injection fixture",
    }
  );
  assert.ok(project.id);

  const wakeResult = await jsonRequest(agentsBaseUrl, "/__test/wake", "POST", {
    projectId: project.id,
    revokeAuthority: true,
  });

  assert.deepEqual(wakeResult.sweep, { checked: 1 });
  assert.deepEqual(wakeResult.repeatSweep, { checked: 0 });
  assert.equal(wakeResult.wake.status, "held");
  assert.equal(wakeResult.wake.attempts, 1);
  assert.deepEqual(wakeResult.dispatchResponses, []);
  assert.deepEqual(wakeResult.requestCounts, { requests: 1, events: 1 });
  assert.equal(wakeResult.conflictingRequestStatus, 409);
});

test("busy Project Bot retries after its backoff and holds the guarded AgentDO result", async () => {
  const project = await jsonRequest(
    spacesBaseUrl,
    `/spaces/${identity.spaceId}/projects`,
    "POST",
    { name: "Busy Assistant Retry Project" }
  );
  const wakeResult = await jsonRequest(agentsBaseUrl, "/__test/wake", "POST", {
    projectId: project.id,
    simulateBusyFirst: true,
  });

  assert.deepEqual(wakeResult.busySweep, { checked: 1 });
  assert.deepEqual(wakeResult.busyResponse, {
    status: 409,
    body: { reason: "assistant_busy" },
  });
  assert.deepEqual(wakeResult.sweep, { checked: 1 });
  assert.deepEqual(wakeResult.repeatSweep, { checked: 0 });
  assert.equal(wakeResult.wake.status, "held");
  assert.equal(wakeResult.wake.attempts, 2);
  assert.equal(wakeResult.dispatchResponses.length, 1);
  assert.equal(
    wakeResult.dispatchResponses[0].body?.error_code,
    "compliance_violation"
  );
});

test("an expired D1 wake lease is held instead of blindly redispatched", async () => {
  const project = await jsonRequest(
    spacesBaseUrl,
    `/spaces/${identity.spaceId}/projects`,
    "POST",
    { name: "Expired Wake Lease Project" }
  );
  const wakeResult = await jsonRequest(agentsBaseUrl, "/__test/wake", "POST", {
    projectId: project.id,
    expireLease: true,
  });

  assert.deepEqual(wakeResult.sweep, { checked: 0 });
  assert.deepEqual(wakeResult.repeatSweep, { checked: 0 });
  assert.equal(wakeResult.wake.status, "held");
  assert.equal(wakeResult.wake.attempts, 1);
  assert.deepEqual(wakeResult.dispatchResponses, []);
});

test("real D1 membership data denies a viewer permission to create Project Bot threads", async () => {
  const started = performance.now();
  const response = await fetch(
    `${spacesBaseUrl}/spaces/${identity.spaceId}/threads`,
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
