import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
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

async function waitForCorrelatedAgentActivity(rootRunId, expectedAssistantScope) {
  let trace = { data: [] };
  for (let attempt = 0; attempt < 40; attempt++) {
    trace = await jsonRequest(agentsBaseUrl, `/__test/agent-activity?root_run_id=${encodeURIComponent(rootRunId)}`, "GET");
    const scopes = new Set((trace.data ?? []).map((row) => row.assistant_scope));
    if (scopes.has(expectedAssistantScope) && scopes.has("worker")) return trace;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return trace;
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

test("Space Assistant uses the shared planner, verified leaf worker and Space workspace", async () => {
  const before = await (await fetch(`${modelGatewayBaseUrl}/__test/metrics`)).json();
  const result = await jsonRequest(agentsBaseUrl, "/__test/space-assistant-goal", "POST", {}, 90_000);
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(result.dispatch?.result?.ok, true, JSON.stringify(result.dispatch));
  assert.equal(result.goalActivityStatus, 200, JSON.stringify(result));
  const tasks = result.goalActivity?.goals?.[0]?.tasks ?? [];
  assert.deepEqual(tasks.map(task => [task.status, task.verification?.outcome]), [["completed", "passed"]], JSON.stringify({ tasks, dispatch: result.dispatch, gateway: result.gateway }));
  assert.equal(result.artifact, "space assistant leaf worker completed\n");
  assert.equal(result.gateway.decisions.calls, 1);
  assert.deepEqual(result.gateway.decisions.billingEvents.map(event => event.kind), ["reserve", "settle"]);
  assert.ok(result.gateway.totalRequests > before.totalRequests);
  assert.equal(result.gateway.totalRequests - before.totalRequests, 4, JSON.stringify({ before, after: result.gateway }));
  const correlatedTrace = await waitForCorrelatedAgentActivity(result.runId, "space_assistant");
  assert.ok(correlatedTrace.data?.some((row) => row.root_run_id === result.runId && row.assistant_scope === "space_assistant"), JSON.stringify(correlatedTrace));
  assert.ok(correlatedTrace.data?.some((row) => row.root_run_id === result.runId && row.assistant_scope === "worker" && row.worker_id), JSON.stringify(correlatedTrace));
  assert.ok(correlatedTrace.data.filter((row) => row.root_run_id === result.runId).every((row) => row.project_id === null), JSON.stringify(correlatedTrace));
  metrics.space_assistant_verified_worker_run = {
    evidence_class: "integrated-local-synthetic-model",
    task_status: tasks[0].status,
    verification: tasks[0].verification.outcome,
    artifact_workspace: "Space Assistant workspace",
    decisions_requests: result.gateway.decisions.calls,
    billing_events: result.gateway.decisions.billingEvents.map(event => event.kind),
    correlated_trace: (correlatedTrace.data ?? []).map(({ assistant_scope, root_run_id, parent_run_id, worker_id, run_id }) => ({ assistant_scope, root_run_id, parent_run_id, worker_id, run_id })),
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
  assert.equal(result.goalActivity.goals[0]?.tasks[0]?.dispatch?.status, "acknowledged", JSON.stringify(result.goalActivity));
  assert.equal(result.goalActivity.goals[0]?.tasks[0]?.verification?.outcome, "passed");
  assert.match(result.goalActivity.goals[0]?.tasks[0]?.verification?.reason ?? "", /agrees with deterministic host evidence/i);
  assert.equal(after.decisions.calls - before.decisions.calls, 1, JSON.stringify(after.decisions));
  assert.deepEqual(after.decisions.billingEvents.map(event => event.kind), ["reserve", "settle"]);
  assert.equal(after.decisions.billingEvents[1]?.outcome, "confirmed");
  assert.ok(after.decisions.timeline.findIndex(event => event.kind === "billing_reserve") < after.decisions.timeline.findIndex(event => event.kind === "decision"));
  assert.ok(after.decisions.timeline.findIndex(event => event.kind === "decision") < after.decisions.timeline.findIndex(event => event.kind === "billing_settle"));
  const correlatedTrace = await waitForCorrelatedAgentActivity(result.goalActivityRunId, "project_assistant");
  assert.ok(correlatedTrace.data?.some((row) => row.root_run_id === result.goalActivityRunId && row.assistant_scope === "project_assistant" && row.project_id === project.id), JSON.stringify(correlatedTrace));
  assert.ok(correlatedTrace.data?.some((row) => row.root_run_id === result.goalActivityRunId && row.assistant_scope === "worker" && row.worker_id && row.parent_run_id), JSON.stringify(correlatedTrace));
  assert.ok(correlatedTrace.data.filter((row) => row.root_run_id === result.goalActivityRunId).every((row) => row.project_id === project.id), JSON.stringify(correlatedTrace));
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
  assert.equal(persistedGoal.goals?.[0]?.tasks?.[0]?.dispatch?.status, "acknowledged", JSON.stringify(persistedGoal));
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
    correlated_trace: (correlatedTrace.data ?? []).map(({ assistant_scope, root_run_id, parent_run_id, worker_id, run_id }) => ({ assistant_scope, root_run_id, parent_run_id, worker_id, run_id })),
    verification_reason: result.goalActivity.goals[0].tasks[0].verification.reason,
    decisions_requests: after.decisions.calls - before.decisions.calls,
    decision_billing_events: after.decisions.billingEvents.map((event) => event.kind),
  };
});

test("an AgentDO process crash during delivery is reconciled to review without launching a worker", async () => {
  const project = await jsonRequest(spacesBaseUrl, `/spaces/${identity.spaceId}/projects`, "POST", { name: "Interrupted AgentDO Dispatch Boundary" });
  const configure = await fetch(`${modelGatewayBaseUrl}/__test/configure`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ leafWorkerMode: true, dependentTaskMode: true, decisionOutcome: "passed", resetDecisionTelemetry: true }),
  });
  assert.equal(configure.status, 200, await configure.clone().text());
  const modelBefore = await (await fetch(`${modelGatewayBaseUrl}/__test/metrics`)).json();
  const pause = await jsonRequest(agentsBaseUrl, "/__test/pause-goal-dispatch", "POST", { pause: true });
  assert.deepEqual(pause, { ok: true, paused: true, stored: true });

  const wakeRequest = fetch(`${agentsBaseUrl}/__test/wake`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: project.id, mockModelRun: true }),
  }).then(async response => ({ status: response.status, body: await response.text() })).catch(error => ({ error: String(error) }));
  const eventId = `runtime-e2e:${project.id}:pending`;
  const runId = `blackboard-${createHash("sha256").update(JSON.stringify([
    "tenant-blackboard-runtime-test", identity.spaceId, project.id, eventId,
  ])).digest("hex")}`;
  let beforeCrash;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    beforeCrash = await jsonRequest(agentsBaseUrl, `/__test/goal-activity?run_id=${encodeURIComponent(runId)}`, "GET");
    const tasks = beforeCrash.goals?.[0]?.tasks ?? [];
    if (tasks[0]?.dispatch?.status === "delivering") break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (beforeCrash?.goals?.[0]?.tasks?.[0]?.dispatch?.status !== "delivering") {
    await restartAgentsWorker();
    await jsonRequest(agentsBaseUrl, "/__test/pause-goal-dispatch", "POST", { pause: false });
  }
  assert.equal(beforeCrash?.goals?.[0]?.tasks?.[0]?.dispatch?.status, "delivering", JSON.stringify(beforeCrash));
  assert.equal(beforeCrash?.goals?.[0]?.tasks?.[0]?.status, "running");

  const restartMs = await restartAgentsWorker();
  // The original inbound fetch may take a while to observe that its DO continuation was lost.
  // Drain it before starting later scenarios; otherwise its eventual wake response can overlap
  // and contend with the next test's project resources.
  const interruptedWake = await Promise.race([
    wakeRequest,
    new Promise(resolve => setTimeout(() => resolve({ timeout: true }), 30_000)),
  ]);
  assert.notEqual(interruptedWake.timeout, true, "the interrupted wake must settle before the next acceptance scenario");
  const resetPause = await jsonRequest(agentsBaseUrl, "/__test/pause-goal-dispatch", "POST", { pause: false });
  assert.equal(resetPause.paused, false);
  const afterRestart = await jsonRequest(agentsBaseUrl, `/__test/goal-activity?run_id=${encodeURIComponent(runId)}`, "GET");
  const activeRun = await jsonRequest(agentsBaseUrl, "/__test/active-run", "GET");
  assert.deepEqual(activeRun, { active: false }, "a reconstructed AgentDO must not retain a ghost active-run lease");
  const tasks = afterRestart.goals?.[0]?.tasks ?? [];
  assert.deepEqual(tasks.map(task => [task.id, task.status, task.dispatch?.status]), [
    ["write-report", "needs_review", "review"],
    ["write-follow-up", "blocked", undefined],
  ], JSON.stringify(afterRestart));
  const model = await (await fetch(`${modelGatewayBaseUrl}/__test/metrics`)).json();
  assert.equal(model.totalRequests - modelBefore.totalRequests, 1, "only the planner request should occur; child worker must not launch before the injected crash");
  assert.equal(model.decisions.calls, 0);
  metrics.agents_dispatch_crash_recovery = {
    evidence_class: "local-wrangler-process-restart",
    outbox_before_restart: "delivering",
    outbox_after_restart: tasks[0].dispatch.status,
    task_after_restart: tasks[0].status,
    dependent_after_restart: tasks[1].status,
    active_run_after_restart: activeRun.active,
    inference_requests_before_and_after: model.totalRequests - modelBefore.totalRequests,
    worker_launches_after_restart: 0,
    restart_ms: restartMs,
    interrupted_wake_settled: true,
    external_provider_requests: 0,
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
  assert.equal(result.goalActivity.goals[0]?.tasks[0]?.dispatch?.status, "acknowledged", JSON.stringify(result.goalActivity));
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
  assert.equal(persistedGoal.goals?.[0]?.tasks?.[0]?.dispatch?.status, "acknowledged", JSON.stringify(persistedGoal));
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

test("only a verified Project Bot prerequisite dispatches its dependent leaf worker", async () => {
  const project = await jsonRequest(
    spacesBaseUrl,
    `/spaces/${identity.spaceId}/projects`,
    "POST",
    { name: "Project Bot Verified Dependency Gate" }
  );
  const configure = async (decisionOutcome) => {
    const response = await fetch(`${modelGatewayBaseUrl}/__test/configure`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ leafWorkerMode: true, dependentTaskMode: true, decisionOutcome, resetDecisionTelemetry: true }),
    });
    assert.equal(response.status, 200, await response.clone().text());
  };

  await configure("passed");
  const beforePass = await (await fetch(`${modelGatewayBaseUrl}/__test/metrics`)).json();
  const passed = await jsonRequest(agentsBaseUrl, "/__test/wake", "POST", {
    projectId: project.id,
    mockModelRun: true,
  }, 90_000);
  const afterPass = await (await fetch(`${modelGatewayBaseUrl}/__test/metrics`)).json();
  const passedTasks = passed.goalActivity?.goals?.[0]?.tasks ?? [];
  assert.equal(passed.wake.status, "completed", JSON.stringify({ wake: passed.wake, tasks: passedTasks, dispatch: passed.dispatchResponses, model: afterPass }));
  assert.deepEqual(passedTasks.map(task => [task.id, task.status, task.verification?.outcome]), [
    ["write-report", "completed", "passed"],
    ["write-follow-up", "completed", "passed"],
  ]);
  assert.ok(passed.workspaceArtifact?.workspaceKeys?.some(key => key.endsWith("/reports/blackboard-worker-followup.txt")), JSON.stringify(passed.workspaceArtifact));
  assert.equal(afterPass.decisions.calls, 2);
  assert.deepEqual(afterPass.decisions.billingEvents.map(event => event.kind), ["reserve", "settle", "reserve", "settle"]);

  const message = await jsonRequest(agentsBaseUrl, "/__test/task-blackboard/publish", "POST", {
    goalId: passed.goalActivity.goals[0].id,
    runId: passed.goalActivityRunId,
    projectId: project.id,
    senderTaskId: "write-report",
    recipientTaskId: "write-follow-up",
  });
  assert.equal(message.status, 200, JSON.stringify(message));
  assert.equal(message.body?.message?.text, "Persisted worker handoff for the restart acceptance.");
  const blackboardRestartMs = await restartAgentsWorker();
  const persistedMessages = await jsonRequest(agentsBaseUrl, `/__test/goal-activity?run_id=${encodeURIComponent(passed.goalActivityRunId)}`, "GET");
  assert.equal(persistedMessages.goals?.[0]?.messages?.length, 2, JSON.stringify(persistedMessages));
  assert.ok(persistedMessages.goals?.[0]?.messages?.some((item) => item.text === "Persisted worker handoff for the restart acceptance."));
  assert.ok(persistedMessages.goals?.[0]?.messages?.some((item) => item.id === "completion:write-report" && item.kind === "completion"));

  const reviewProject = await jsonRequest(
    spacesBaseUrl,
    `/spaces/${identity.spaceId}/projects`,
    "POST",
    { name: "Project Bot Uncertain Dependency Gate" }
  );
  await configure("uncertain");
  const beforeReview = await (await fetch(`${modelGatewayBaseUrl}/__test/metrics`)).json();
  const review = await jsonRequest(agentsBaseUrl, "/__test/wake", "POST", {
    projectId: reviewProject.id,
    mockModelRun: true,
  }, 90_000);
  const afterReview = await (await fetch(`${modelGatewayBaseUrl}/__test/metrics`)).json();
  const reviewTasks = review.goalActivity?.goals?.[0]?.tasks ?? [];
  assert.equal(review.wake.status, "held", JSON.stringify({ wake: review.wake, tasks: reviewTasks }));
  assert.deepEqual(reviewTasks.map(task => [task.id, task.status, task.verification?.outcome]), [
    ["write-report", "needs_review", "uncertain"],
    ["write-follow-up", "blocked", undefined],
  ]);
  assert.ok(!review.workspaceArtifact?.workspaceKeys?.some(key => key.endsWith("/reports/blackboard-worker-followup.txt")), JSON.stringify(review.workspaceArtifact));
  assert.equal(afterReview.decisions.calls, 1);
  assert.deepEqual(afterReview.decisions.billingEvents.map(event => event.kind), ["reserve", "settle"]);
  assert.ok(afterReview.totalRequests > beforeReview.totalRequests);
  assert.ok(afterPass.totalRequests > beforePass.totalRequests);
  metrics.project_bot_dependency_gate = {
    evidence_class: "integrated-local-synthetic-model",
    passed_prerequisite: passedTasks[0].verification.outcome,
    passed_dependent_status: passedTasks[1].status,
    followup_artifact_after_pass: true,
    uncertain_prerequisite: reviewTasks[0].verification.outcome,
    uncertain_dependent_status: reviewTasks[1].status,
    followup_artifact_after_uncertain: false,
    external_provider_requests: 0,
    blackboard_message_survived_agents_restart: true,
    blackboard_restart_ms: blackboardRestartMs,
  };
});

test("metered Decisions peer routing grants a finding, wakes an independent worker, and exposes the scoped read route", async () => {
  const project = await jsonRequest(spacesBaseUrl, `/spaces/${identity.spaceId}/projects`, "POST", { name: "Project Bot Decisions Blackboard Route" });
  const configure = await fetch(`${modelGatewayBaseUrl}/__test/configure`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ leafWorkerMode: true, sharePeerTasks: true, decisionOutcome: "passed", resetDecisionTelemetry: true }),
  });
  assert.equal(configure.status, 200, await configure.clone().text());
  const before = await (await fetch(`${modelGatewayBaseUrl}/__test/metrics`)).json();
  const result = await jsonRequest(agentsBaseUrl, "/__test/wake", "POST", { projectId: project.id, mockModelRun: true }, 120_000);
  const after = await (await fetch(`${modelGatewayBaseUrl}/__test/metrics`)).json();
  const goal = result.goalActivity?.goals?.[0];
  assert.equal(result.wake.status, "completed", JSON.stringify({ wake: result.wake, goal, dispatch: result.dispatchResponses }));
  assert.deepEqual(goal?.tasks?.map(task => [task.id, task.status, task.verification?.outcome]), [
    ["write-report", "completed", "passed"],
    ["write-follow-up", "completed", "passed"],
  ]);
  assert.deepEqual(goal?.tasks?.map(task => task.communication_recipients), [["write-follow-up"], []]);
  assert.ok(goal?.messages?.some(message => message.id === "completion:write-report" && message.kind === "completion"), JSON.stringify(goal?.messages));
  assert.ok(result.workspaceArtifact?.workspaceKeys?.some(key => key.endsWith("/reports/blackboard-worker-followup.txt")), JSON.stringify(result.workspaceArtifact));
  const recipientRead = await jsonRequest(agentsBaseUrl, "/__test/task-blackboard/read", "POST", {
    goalId: goal.id, runId: result.goalActivityRunId, projectId: project.id,
    senderTaskId: "write-report", recipientTaskId: "write-follow-up",
  });
  assert.ok(recipientRead.messages?.some(message => message.id === "completion:write-report" && message.kind === "completion"), JSON.stringify(recipientRead));
  assert.equal(after.decisions.calls - before.decisions.calls, 3, "one batched peer classification plus one metered evidence decision per task");
  assert.deepEqual(after.decisions.billingEvents.map(event => event.kind), ["reserve", "settle", "reserve", "settle", "reserve", "settle"]);
  assert.ok(after.decisions.timeline.findIndex(event => event.kind === "billing_reserve") < after.decisions.timeline.findIndex(event => event.kind === "decision"));
  const modelRequests = after.totalRequests - before.totalRequests;
  assert.ok(modelRequests >= 4, `planner and both independent workers should execute through the normal runtime: ${modelRequests}`);
  metrics.project_bot_decisions_blackboard_route = {
    evidence_class: "four-worker-local-wrangler-with-synthetic-decisions",
    classifier_and_verifier_decisions: after.decisions.calls - before.decisions.calls,
    model_requests: modelRequests,
    billing_events: after.decisions.billingEvents.map(event => event.kind),
    routed_edges: goal.tasks.filter(task => task.communication_recipients.length).flatMap(task => task.communication_recipients.map(recipient => [task.id, recipient])),
    recipient_read_host_completion: recipientRead.messages.some(message => message.id === "completion:write-report"),
    tasks_completed_and_verified: goal.tasks.every(task => task.status === "completed" && task.verification?.outcome === "passed"),
    external_provider_requests: 0,
  };
});

test("1, 2, 8, and 32 concurrent wake sweepers claim each Project Bot event exactly once", async () => {
  const contention = [];
  for (const contenders of [1, 2, 8, 32]) {
    const project = await jsonRequest(
      spacesBaseUrl,
      `/spaces/${identity.spaceId}/projects`,
      "POST",
      { name: `Concurrent Wake Claim Project (${contenders})` }
    );
    const wakeResult = await jsonRequest(agentsBaseUrl, "/__test/wake", "POST", {
      projectId: project.id,
      concurrentSweepCount: contenders,
    });

    assert.equal(wakeResult.concurrentSweeps.length, contenders);
    assert.ok(
      wakeResult.concurrentSweeps.every((result) => result.checked <= 1),
      `each of ${contenders} concurrent sweeps should inspect at most the one fixture wake`
    );
    assert.equal(wakeResult.dispatchResponses.length, 1, `${contenders} sweepers must produce one dispatch`);
    assert.equal(wakeResult.wake.attempts, 1, `${contenders} sweepers must persist one attempt`);
    assert.equal(wakeResult.wake.status, "held");
    assert.equal(wakeResult.dispatchResponses[0].status, 403);
    assert.equal(wakeResult.dispatchResponses[0].body?.error_code, "compliance_violation");
    assert.equal(wakeResult.repeatSweep.checked, 0);
    contention.push({ contenders, dispatches: wakeResult.dispatchResponses.length, attempts: wakeResult.wake.attempts, repeat_dispatches: wakeResult.repeatSweep.checked });
  }
  metrics.blackboard_wake_contention = contention;
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

test("real local D1 and SpaceDO blackboard search follows cursors through 100, 1k, and 10k visible cards", async () => {
  const resultByScale = [];
  for (const count of [100, 1_000, 10_000]) {
    const seedStarted = performance.now();
    const seeded = await jsonRequest(spacesBaseUrl, "/__test/blackboard-scale-seed", "POST", {
      tenantId: identity.tenantId,
      spaceId: identity.spaceId,
      count,
    }, 120_000);
    assert.equal(seeded.seeded_projects, count);
    assert.equal(seeded.seeded_cards, count);
    const targetProjectId = `00000000-0000-4000-8000-${(count - 1).toString(16).padStart(12, "0")}`;
    const search = await jsonRequest(agentsBaseUrl, "/__test/blackboard/search-all", "POST", {
      query: `ref${String(count - 1).padStart(5, "0")}`,
      projectId: targetProjectId,
      maxPages: 150,
    }, 180_000);
    assert.equal(search.found, true, `last seeded card was not found at ${count}`);
    assert.equal(search.truncated, false, `search stopped before exhausting cards at ${count}`);
    assert.equal(search.pages, Math.ceil(count / 90), `cursor/page count drift at ${count}`);
    const sorted = [...search.page_latencies_ms].sort((a, b) => a - b);
    const percentile = (p) => sorted[Math.ceil(p * sorted.length) - 1] ?? 0;
    const measurement = {
      visible_cards: count,
      target_position: count,
      target_found: search.found,
      pages_followed: search.pages,
      page_size: 90,
      end_to_end_ms: search.elapsed_ms,
      page_latency_p50_ms: percentile(0.5),
      page_latency_p95_ms: percentile(0.95),
      seed_ms: Math.round(performance.now() - seedStarted) - search.elapsed_ms,
      provider_calls: 0,
      evidence_class: "integrated-local-wrangler-d1-spacedo-sdk-operation",
    };
    resultByScale.push(measurement);
  }
  metrics.benchmarks.push({
    name: "blackboard-cursor-pagination-local-wrangler",
    evidence_class: "integrated-local-wrangler-d1-spacedo-sdk-operation",
    query_cases: resultByScale,
    note: "Each query targets the last lexically ordered card and follows the SDK operation cursor until exhausted; this proves the client loop, not that an LLM autonomously chooses to continue.",
  });
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
