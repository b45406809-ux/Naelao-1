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
let modelGatewayWorker;
let artifactWorker;
let persistPath;
let spacesBaseUrl;
let agentsBaseUrl;
let modelGatewayBaseUrl;
let artifactBaseUrl;
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
  model_gateway_start_ms: 0,
  artifact_worker_start_ms: 0,
  agents_worker_start_ms: 0,
  agents_goal_journal_restarts: [],
  requests: [],
  benchmarks: [],
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
    {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        WRANGLER_WRITE_LOGS: "false",
        WRANGLER_LOG_PATH: path.join(os.tmpdir(), "naelao-wrangler-logs"),
      },
    }
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
      const response = await fetch(`${baseUrl}/__runtime_ready`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) return;
      lastError = new Error(`readiness endpoint returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
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
  spacesBaseUrl = `http://127.0.0.1:${spacesPort}`;
  const spacesStarted = performance.now();
  spacesWorker = startWorker(
    path.join(repoRoot, "tests/plan/runtime/spaces.wrangler.toml"),
    spacesPort
  );
  await waitForWorker(spacesWorker, spacesBaseUrl);
  const spacesWorkerStartMs = Math.round(performance.now() - spacesStarted);
  // Keep each selected port occupied before asking the OS for the next. Allocating four free
  // ports up front and closing each probe socket can return the same port repeatedly, making
  // Wrangler workers race to bind it and causing requests to reach the wrong test service.
  const modelGatewayPort = await availablePort();
  modelGatewayBaseUrl = `http://127.0.0.1:${modelGatewayPort}`;
  const modelGatewayStarted = performance.now();
  modelGatewayWorker = startWorker(
    path.join(repoRoot, "tests/plan/runtime/model-gateway.wrangler.toml"),
    modelGatewayPort
  );
  await waitForWorker(modelGatewayWorker, modelGatewayBaseUrl);
  const modelGatewayStartMs = Math.round(performance.now() - modelGatewayStarted);
  const artifactPort = await availablePort();
  artifactBaseUrl = `http://127.0.0.1:${artifactPort}`;
  const artifactStarted = performance.now();
  artifactWorker = startWorker(
    path.join(repoRoot, "tests/plan/runtime/artifacts.wrangler.toml"),
    artifactPort
  );
  await waitForWorker(artifactWorker, artifactBaseUrl);
  const artifactWorkerStartMs = Math.round(performance.now() - artifactStarted);
  const agentsPort = await availablePort();
  agentsBaseUrl = `http://127.0.0.1:${agentsPort}`;
  const agentsStarted = performance.now();
  agentsWorker = startWorker(
    path.join(repoRoot, "tests/plan/runtime/agents.wrangler.toml"),
    agentsPort
  );
  await waitForWorker(agentsWorker, agentsBaseUrl);
  const agentsWorkerStartMs = Math.round(performance.now() - agentsStarted);
  return {
    spacesWorkerStartMs,
    modelGatewayStartMs,
    artifactWorkerStartMs,
    agentsWorkerStartMs,
    totalWorkerStartMs: spacesWorkerStartMs + modelGatewayStartMs + artifactWorkerStartMs + agentsWorkerStartMs,
  };
}

async function restartAgentsWorker() {
  const port = Number(new URL(agentsBaseUrl).port);
  const started = performance.now();
  await stopWorker(agentsWorker);
  agentsWorker = startWorker(
    path.join(repoRoot, "tests/plan/runtime/agents.wrangler.toml"),
    port
  );
  await waitForWorker(agentsWorker, agentsBaseUrl);
  runtimeRestartCount++;
  return Math.round(performance.now() - started);
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
    metrics.model_gateway_start_ms = workerStart.modelGatewayStartMs;
    metrics.artifact_worker_start_ms = workerStart.artifactWorkerStartMs;
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
  await stopWorker(modelGatewayWorker);
  await stopWorker(artifactWorker);
  if (persistPath && process.env.NAELAO_RUNTIME_KEEP_PERSIST !== "1") await rm(persistPath, { recursive: true, force: true });
  else if (persistPath) console.log(`NAELAO_RUNTIME_PERSIST_PATH ${persistPath}`);
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

async function jsonRequest(baseUrl, pathname, method, body, timeoutMs = 120_000) {
  const started = performance.now();
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: headers(),
    signal: AbortSignal.timeout(timeoutMs),
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
  await stopWorker(modelGatewayWorker);
  await stopWorker(artifactWorker);
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

test("a Project Bot wake completes through the local model adapter without external provider calls", async () => {
  const project = await jsonRequest(
    spacesBaseUrl,
    `/spaces/${identity.spaceId}/projects`,
    "POST",
    { name: "Deterministic Project Bot Completion" }
  );
  const before = await (await fetch(`${modelGatewayBaseUrl}/__test/metrics`)).json();
  const started = performance.now();
  const result = await jsonRequest(agentsBaseUrl, "/__test/wake", "POST", {
    projectId: project.id,
    mockModelRun: true,
  }, 90_000);
  const elapsedMs = Math.round(performance.now() - started);
  const after = await (await fetch(`${modelGatewayBaseUrl}/__test/metrics`)).json();
  assert.deepEqual(result.sweep, { checked: 1 });
  assert.equal(result.wake.status, "completed");
  assert.equal(result.wake.attempts, 1);
  assert.equal(result.dispatchResponses.length, 1);
  assert.equal(result.dispatchResponses[0].status, 200);
  assert.equal(result.dispatchResponses[0].body?.result?.ok, true, JSON.stringify(result.dispatchResponses[0].body));
  assert.ok(after.totalRequests > before.totalRequests, `the authorized local model endpoint should receive an inference request; before=${JSON.stringify(before)} after=${JSON.stringify(after)} dispatch=${JSON.stringify(result.dispatchResponses)}`);
  assert.ok(Object.keys(after.modelCounts).some((model) => model.startsWith("@cf/")));
  assert.ok(result.threads.data?.some((thread) => thread.project_id === project.id && thread.title.startsWith("Project routine") && thread.session_id));
  metrics.project_assistant_mock_run = {
    evidence_class: "integrated-local-mock-model",
    outcome: "completed",
    duration_ms: elapsedMs,
    model_requests: after.totalRequests - before.totalRequests,
    model_ids: Object.keys(after.modelCounts),
    external_provider_requests: 0,
  };
});

test("Project Bot planning dispatches a real leaf AgentDO and writes its scoped workspace artifact", async () => {
  const project = await jsonRequest(
    spacesBaseUrl,
    `/spaces/${identity.spaceId}/projects`,
    "POST",
    { name: "Project Bot Leaf Worker Journey" }
  );
  const configure = await fetch(`${modelGatewayBaseUrl}/__test/configure`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ leafWorkerMode: true, decisionOutcome: "passed", resetDecisionTelemetry: true }),
  });
  assert.equal(configure.status, 200, await configure.clone().text());
  const before = await (await fetch(`${modelGatewayBaseUrl}/__test/metrics`)).json();
  const started = performance.now();
  const result = await jsonRequest(agentsBaseUrl, "/__test/wake", "POST", {
    projectId: project.id,
    mockModelRun: true,
  });
  const elapsedMs = Math.round(performance.now() - started);
  const after = await (await fetch(`${modelGatewayBaseUrl}/__test/metrics`)).json();
  assert.equal(result.wake.status, "completed", JSON.stringify({ wake: result.wake, dispatchResponses: result.dispatchResponses, gateway: after }));
  assert.equal(result.wake.attempts, 1);
  assert.equal(result.dispatchResponses[0]?.body?.result?.ok, true, JSON.stringify(result.dispatchResponses[0]?.body));
  assert.ok(after.totalRequests - before.totalRequests >= 3, `planner and leaf worker should each reason through the local adapter: ${JSON.stringify({ before, after })}`);
  assert.equal(result.workspaceArtifact?.exists, true, JSON.stringify({ workspaceArtifact: result.workspaceArtifact, dispatchResponses: result.dispatchResponses, modelRequests: after.totalRequests - before.totalRequests }));
  assert.equal(result.workspaceArtifact?.contentMatches, true, JSON.stringify(result.workspaceArtifact));
  assert.match(result.workspaceArtifact?.sha256 ?? "", /^[a-f0-9]{64}$/);
  assert.match(result.workspaceArtifact?.branch ?? "", /^task\/[a-f0-9]{48}$/);
  assert.equal(result.goalActivity?.goals?.length, 1, JSON.stringify({ goalActivity: result.goalActivity, wake: result.wake, dispatch: result.dispatchResponses, decisions: after.decisions }));
  assert.equal(result.goalActivity.goals[0]?.verificationRequired, true);
  assert.equal(result.goalActivity.goals[0]?.tasks[0]?.status, "completed");
  assert.equal(result.goalActivity.goals[0]?.tasks[0]?.verification?.outcome, "passed");
  assert.match(result.goalActivity.goals[0]?.tasks[0]?.verification?.reason ?? "", /agrees with deterministic host evidence/i);
  assert.equal(after.decisions.calls - before.decisions.calls, 1, JSON.stringify(after.decisions));
  assert.deepEqual(after.decisions.billingEvents.map(event => event.kind), ["reserve", "settle"]);
  assert.equal(after.decisions.billingEvents[1]?.outcome, "confirmed");
  assert.ok(after.decisions.timeline.findIndex(event => event.kind === "billing_reserve") < after.decisions.timeline.findIndex(event => event.kind === "decision"));
  assert.ok(after.decisions.timeline.findIndex(event => event.kind === "decision") < after.decisions.timeline.findIndex(event => event.kind === "billing_settle"));
  const tasks = await jsonRequest(
    spacesBaseUrl,
    `/spaces/${identity.spaceId}/tasks?project_id=${encodeURIComponent(project.id)}`,
    "GET"
  );
  assert.ok(tasks.data?.some((task) => task.project_id === project.id && task.status === "completed"));
  const restartMs = await restartAgentsWorker();
  const persistedGoal = await jsonRequest(
    agentsBaseUrl,
    `/__test/goal-activity?run_id=${encodeURIComponent(result.goalActivityRunId)}`,
    "GET"
  );
  assert.equal(persistedGoal.goals?.[0]?.tasks?.[0]?.status, "completed", JSON.stringify(persistedGoal));
  assert.equal(persistedGoal.goals?.[0]?.tasks?.[0]?.verification?.outcome, "passed", JSON.stringify(persistedGoal));
  metrics.agents_goal_journal_restarts.push({
    outcome: "completed",
    verification: "passed",
    duration_ms: restartMs,
  });
  metrics.project_bot_leaf_worker_run = {
    evidence_class: "integrated-local-synthetic-model",
    outcome: "completed",
    duration_ms: elapsedMs,
    inference_requests: after.totalRequests - before.totalRequests,
    task_status: "completed",
    artifact_path: "reports/blackboard-worker-smoke.txt",
    artifact_branch: result.workspaceArtifact.branch,
    external_provider_requests: 0,
    host_evidence_verification: result.goalActivity.goals[0].tasks[0].verification.outcome,
    verification_reason: result.goalActivity.goals[0].tasks[0].verification.reason,
    decisions_requests: after.decisions.calls - before.decisions.calls,
    decision_billing_events: after.decisions.billingEvents.map((event) => event.kind),
  };
});

test("a cautious Decisions verdict remains visible as review instead of being promoted to a pass", async () => {
  const project = await jsonRequest(
    spacesBaseUrl,
    `/spaces/${identity.spaceId}/projects`,
    "POST",
    { name: "Project Bot Verification Review" }
  );
  const configure = await fetch(`${modelGatewayBaseUrl}/__test/configure`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ leafWorkerMode: true, decisionOutcome: "uncertain", resetDecisionTelemetry: true }),
  });
  assert.equal(configure.status, 200, await configure.clone().text());
  const result = await jsonRequest(agentsBaseUrl, "/__test/wake", "POST", {
    projectId: project.id,
    mockModelRun: true,
  });
  const after = await (await fetch(`${modelGatewayBaseUrl}/__test/metrics`)).json();
  assert.equal(result.wake.status, "held", JSON.stringify({ wake: result.wake, dispatch: result.dispatchResponses }));
  assert.equal(result.dispatchResponses[0]?.body?.steps_completed?.some((step) => step.ok === false), true);
  assert.equal(result.workspaceArtifact?.exists, true);
  assert.equal(result.goalActivity?.goals?.length, 1, JSON.stringify({ goalActivity: result.goalActivity, dispatch: result.dispatchResponses }));
  assert.equal(result.goalActivity.goals[0]?.tasks[0]?.status, "needs_review");
  assert.equal(result.goalActivity.goals[0]?.tasks[0]?.verification?.outcome, "uncertain");
  assert.match(result.goalActivity.goals[0]?.tasks[0]?.verification?.reason ?? "", /review required/i);
  assert.equal(after.decisions.calls, 1);
  assert.deepEqual(after.decisions.billingEvents.map((event) => event.kind), ["reserve", "settle"]);
  assert.equal(after.decisions.billingEvents[1]?.outcome, "confirmed");
  const restartMs = await restartAgentsWorker();
  const persistedGoal = await jsonRequest(
    agentsBaseUrl,
    `/__test/goal-activity?run_id=${encodeURIComponent(result.goalActivityRunId)}`,
    "GET"
  );
  assert.equal(persistedGoal.goals?.[0]?.tasks?.[0]?.status, "needs_review", JSON.stringify(persistedGoal));
  assert.equal(persistedGoal.goals?.[0]?.tasks?.[0]?.verification?.outcome, "uncertain", JSON.stringify(persistedGoal));
  metrics.agents_goal_journal_restarts.push({
    outcome: "needs_review",
    verification: "uncertain",
    duration_ms: restartMs,
  });
  metrics.project_bot_uncertain_verification = {
    evidence_class: "integrated-local-synthetic-model",
    task_status: result.goalActivity.goals[0].tasks[0].status,
    verification_outcome: result.goalActivity.goals[0].tasks[0].verification.outcome,
    decisions_requests: after.decisions.calls,
    decision_billing_events: after.decisions.billingEvents.map((event) => event.kind),
    artifact_exists: result.workspaceArtifact.exists,
    external_provider_requests: 0,
  };
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

test("measures 30 local blackboard-to-Project-Bot admission attempts", async () => {
  const samples = [];
  const iterations = 30;
  for (let index = 0; index < iterations; index++) {
    const project = await jsonRequest(
      spacesBaseUrl,
      `/spaces/${identity.spaceId}/projects`,
      "POST",
      { name: `Wake latency sample ${index + 1}` }
    );
    const started = performance.now();
    const wakeResult = await jsonRequest(
      agentsBaseUrl,
      "/__test/wake",
      "POST",
      { projectId: project.id }
    );
    samples.push(Math.round(performance.now() - started));
    assert.equal(wakeResult.wake.status, "held");
    assert.equal(wakeResult.wake.attempts, 1);
    assert.equal(wakeResult.dispatchResponses.length, 1);
    assert.equal(wakeResult.dispatchResponses[0].status, 403);
    assert.equal(
      wakeResult.dispatchResponses[0].body?.error_code,
      "compliance_violation"
    );
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (value) => sorted[Math.ceil(value * sorted.length) - 1];
  metrics.benchmarks.push({
    name: "local-blackboard-project-bot-admission",
    evidence_class: "integrated-local",
    samples: iterations,
    p50_ms: percentile(0.5),
    p95_ms: percentile(0.95),
    provider_attempts: 0,
    terminal_boundary: "air-gap compliance_violation before model/provider execution",
  });
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
