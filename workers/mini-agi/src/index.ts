// G-AGI01..G-AGI08: Mini-AGI — hierarchical agent orchestration (planner + child agents, depth ≤ 3)
import { Hono } from "hono";
import { errorResponse, requestId, mintInternalToken, parseBoundedInteger } from "@naelao/http";
import { isSpaceNetworkEgressDenied } from "@naelao/security";

interface Env {
  ENVIRONMENT: string;
  PLATFORM_SECRET: string;
  PLATFORM_DB: D1Database;
  SESSIONS_QUEUE: Queue;
  LLM_GATEWAY_URL: string;
  AGENTS_WORKER_URL: string;
}

interface AgiRun {
  id: string;
  tenant_id: string;
  space_id: string;
  goal: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  depth: number;
  total_tokens_used: number;
  token_budget: number;
  plan: string | null;
  result: string | null;
  error: string | null;
  subtasks: SubTask[];
  created_at: string;
  updated_at: string;
}

interface SubTask {
  id: string;
  run_id: string;
  parent_task_id: string | null;
  description: string;
  status: "pending" | "running" | "completed" | "failed";
  depth: number;
  result: string | null;
  agent_run_id: string | null;
}

const MAX_DEPTH = 3;
const DEFAULT_TOKEN_BUDGET = 50000;

function validateEnv(env: Env): void {
  if (!env.PLATFORM_SECRET) throw new Error("Missing required secret: PLATFORM_SECRET");
  if (!env.LLM_GATEWAY_URL) throw new Error("Missing required var: LLM_GATEWAY_URL");
  if (!env.AGENTS_WORKER_URL) throw new Error("Missing required var: AGENTS_WORKER_URL");
}

function getCallerIdentity(c: { req: { header: (h: string) => string | undefined } }) {
  return {
    tenantId: c.req.header("x-naelao-tenant-id") ?? "",
    userId: c.req.header("x-naelao-user-id") ?? "",
  };
}

const app = new Hono<{ Bindings: Env }>();
app.use("*", requestId);
app.use("*", async (c, next) => { validateEnv(c.env); await next(); });

// Create a new AGI run
app.post("/v1/agi/runs", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const body = await c.req.json<{
    space_id: string;
    goal: string;
    token_budget?: number;
  }>();
  if (!body.space_id || !body.goal) {
    return c.json({ error_code: "bad_request", message: "space_id and goal required" }, 400);
  }
  // Verify space belongs to tenant
  const space = await c.env.PLATFORM_DB.prepare(
    "SELECT id FROM spaces WHERE id = ? AND tenant_id = ?"
  ).bind(body.space_id, tenantId).first<{ id: string }>();
  if (!space) return c.json({ error_code: "not_found", message: "Space not found" }, 404);
  if (await isSpaceNetworkEgressDenied(c.env.PLATFORM_DB, body.space_id)) {
    return c.json({
      error_code: "air_gap_egress_denied",
      message: "This space blocks network and managed-service egress",
    }, 403);
  }

  const runId = crypto.randomUUID();
  const now = new Date().toISOString();
  const tokenBudget = Math.min(body.token_budget ?? DEFAULT_TOKEN_BUDGET, 200000);
  await c.env.PLATFORM_DB.prepare(
    `INSERT INTO agi_runs (id, tenant_id, space_id, goal, status, depth, total_tokens_used, token_budget, plan, result, error, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', 0, 0, ?, NULL, NULL, NULL, ?, ?)`
  ).bind(runId, tenantId, body.space_id, tokenBudget, now, now).run();

  // Kick off async orchestration
  c.executionCtx.waitUntil(orchestrate(runId, tenantId, body.space_id, body.goal, tokenBudget, c.env));

  return c.json({ id: runId, status: "pending", goal: body.goal, token_budget: tokenBudget, created_at: now }, 201);
});

// Get run status
app.get("/v1/agi/runs/:id", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const run = await c.env.PLATFORM_DB.prepare(
    "SELECT * FROM agi_runs WHERE id = ? AND tenant_id = ?"
  ).bind(c.req.param("id"), tenantId).first<Omit<AgiRun, "subtasks">>();
  if (!run) return c.json({ error_code: "not_found", message: "AGI run not found" }, 404);

  const { results: subtasks } = await c.env.PLATFORM_DB.prepare(
    "SELECT id, parent_task_id, description, status, depth, result, agent_run_id FROM agi_subtasks WHERE run_id = ? ORDER BY depth ASC, rowid ASC"
  ).bind(run.id).all<SubTask>();
  return c.json({ data: { ...run, subtasks } });
});

// List runs for tenant
app.get("/v1/agi/runs", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const url = new URL(c.req.url);
  const spaceId = url.searchParams.get("space_id");
  const limit = parseBoundedInteger(url.searchParams.get("limit"), 20, 1, 100);
  const stmt = spaceId
    ? c.env.PLATFORM_DB.prepare(
        "SELECT id, space_id, goal, status, depth, total_tokens_used, token_budget, result, created_at FROM agi_runs WHERE tenant_id = ? AND space_id = ? ORDER BY created_at DESC LIMIT ?"
      ).bind(tenantId, spaceId, limit)
    : c.env.PLATFORM_DB.prepare(
        "SELECT id, space_id, goal, status, depth, total_tokens_used, token_budget, result, created_at FROM agi_runs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?"
      ).bind(tenantId, limit);
  const { results } = await stmt.all();
  return c.json({ data: results });
});

// Cancel a run
app.post("/v1/agi/runs/:id/cancel", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const now = new Date().toISOString();
  const result = await c.env.PLATFORM_DB.prepare(
    "UPDATE agi_runs SET status = 'cancelled', updated_at = ? WHERE id = ? AND tenant_id = ? AND status IN ('pending', 'running')"
  ).bind(now, c.req.param("id"), tenantId).run();
  if (result.meta.changes === 0) return c.json({ error_code: "not_found", message: "Run not found or not cancellable" }, 404);
  return c.json({ id: c.req.param("id"), status: "cancelled" });
});

// Core orchestration logic
async function orchestrate(
  runId: string,
  tenantId: string,
  spaceId: string,
  goal: string,
  tokenBudget: number,
  env: Env
): Promise<void> {
  const now = () => new Date().toISOString();
  try {
    // Re-read policy at the durable execution boundary in case the space changed posture after
    // the run was queued.
    if (await isSpaceNetworkEgressDenied(env.PLATFORM_DB, spaceId)) {
      await env.PLATFORM_DB.prepare(
        "UPDATE agi_runs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?"
      ).bind("air_gap_egress_denied", now(), runId).run();
      return;
    }
    await env.PLATFORM_DB.prepare(
      "UPDATE agi_runs SET status = 'running', updated_at = ? WHERE id = ?"
    ).bind(now(), runId).run();

    // Check if run was cancelled before we started
    const run = await env.PLATFORM_DB.prepare(
      "SELECT status FROM agi_runs WHERE id = ?"
    ).bind(runId).first<{ status: string }>();
    if (run?.status === "cancelled") return;

    // Phase 1: Planning — decompose goal into subtasks
    const plan = await planGoal(goal, env, tokenBudget);
    await env.PLATFORM_DB.prepare(
      "UPDATE agi_runs SET plan = ?, updated_at = ? WHERE id = ?"
    ).bind(JSON.stringify(plan), now(), runId).run();

    // Phase 2: Execute subtasks (depth-first, respecting depth limit)
    const results = await executeSubtasks(runId, tenantId, spaceId, plan.subtasks, null, 1, tokenBudget, env);

    // Phase 3: Aggregate results
    const aggregation = await aggregateResults(goal, results, env);

    await env.PLATFORM_DB.prepare(
      "UPDATE agi_runs SET status = 'completed', result = ?, updated_at = ? WHERE id = ?"
    ).bind(aggregation, now(), runId).run();
  } catch (err) {
    console.error(`[mini-agi] Run ${runId} failed:`, err);
    await env.PLATFORM_DB.prepare(
      "UPDATE agi_runs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?"
    ).bind(String(err), now(), runId).run();
  }
}

interface PlanResult {
  subtasks: PlannedTask[];
}

interface PlannedTask {
  description: string;
  subtasks?: PlannedTask[];
}

async function planGoal(goal: string, env: Env, tokenBudget: number): Promise<PlanResult> {
  const resp = await fetch(`${env.LLM_GATEWAY_URL}/v1/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${env.PLATFORM_SECRET}` },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: `You are a planning agent. Decompose goals into concrete, actionable subtasks.
Return ONLY valid JSON: {"subtasks": [{"description": "...", "subtasks": []}]}
Maximum 5 top-level subtasks, maximum 3 levels deep. Token budget: ${tokenBudget}.`,
      messages: [{ role: "user", content: `Goal: ${goal}\n\nDecompose into subtasks:` }],
    }),
  });
  if (!resp.ok) throw new Error(`Planner LLM failed: ${resp.status}`);
  const data = await resp.json<{ content?: { type: string; text: string }[] }>();
  const block = data.content?.find((b) => b.type === "text");
  const text = block?.text ?? '{"subtasks":[{"description":"Execute goal directly","subtasks":[]}]}';
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) as PlanResult : { subtasks: [{ description: goal }] };
  } catch {
    return { subtasks: [{ description: goal }] };
  }
}

async function executeSubtasks(
  runId: string,
  tenantId: string,
  spaceId: string,
  tasks: PlannedTask[],
  parentTaskId: string | null,
  depth: number,
  tokenBudget: number,
  env: Env
): Promise<string[]> {
  if (depth > MAX_DEPTH) return ["[Depth limit reached]"];

  const results: string[] = [];
  for (const task of tasks.slice(0, 5)) {
    // Check for cancellation
    const runStatus = await env.PLATFORM_DB.prepare(
      "SELECT status FROM agi_runs WHERE id = ?"
    ).bind(runId).first<{ status: string }>();
    if (runStatus?.status === "cancelled") break;

    const taskId = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.PLATFORM_DB.prepare(
      `INSERT INTO agi_subtasks (id, run_id, parent_task_id, description, status, depth, result, agent_run_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'running', ?, NULL, NULL, ?, ?)`
    ).bind(taskId, runId, parentTaskId, task.description, depth, now, now).run();

    let taskResult: string;
    try {
      if (task.subtasks && task.subtasks.length > 0 && depth < MAX_DEPTH) {
        // Recursive decomposition
        const subResults = await executeSubtasks(runId, tenantId, spaceId, task.subtasks, taskId, depth + 1, tokenBudget, env);
        taskResult = await aggregateResults(task.description, subResults, env);
      } else {
        // Leaf node — dispatch to agent
        taskResult = await dispatchToAgent(tenantId, spaceId, task.description, env);
      }

      await env.PLATFORM_DB.prepare(
        "UPDATE agi_subtasks SET status = 'completed', result = ?, updated_at = ? WHERE id = ?"
      ).bind(taskResult.slice(0, 4000), new Date().toISOString(), taskId).run();
      results.push(taskResult);
    } catch (err) {
      const errMsg = String(err);
      await env.PLATFORM_DB.prepare(
        "UPDATE agi_subtasks SET status = 'failed', result = ?, updated_at = ? WHERE id = ?"
      ).bind(errMsg, new Date().toISOString(), taskId).run();
      results.push(`[Failed: ${errMsg}]`);
    }
  }
  return results;
}

// WS-6 (audit plan): this used to send the raw PLATFORM_SECRET as `x-naelao-internal-token` to a
// plain fetch URL — a secret-in-header egress, not a signed token. Now mints a real short-lived
// HMAC token the same way every other internal caller does. Separately (not fixed here — a
// distinct, pre-existing bug documented in CLAUDE.md's Phase 6 log): session/message CRUD lives
// on the SPACES worker's SpaceDO proxy, not on AGENTS_WORKER_URL, which only ever implemented
// agent/run + approvals — this dispatch path likely 404s in any live deployment regardless of
// the token fix. Left as a documented, separate follow-up rather than silently re-pointed at a
// URL this worker isn't configured with.
async function dispatchToAgent(tenantId: string, spaceId: string, task: string, env: Env): Promise<string> {
  const internalToken = await mintInternalToken(env.PLATFORM_SECRET, tenantId);
  // Create a session in the agents worker for this subtask
  const resp = await fetch(`${env.AGENTS_WORKER_URL}/spaces/${spaceId}/sessions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-naelao-tenant-id": tenantId,
      "x-naelao-internal-token": internalToken,
    },
    body: JSON.stringify({ end_user_id: `mini-agi-${crypto.randomUUID()}` }),
  });
  if (!resp.ok) throw new Error(`Agent session creation failed: ${resp.status}`);
  const session = await resp.json<{ id: string }>();

  // Send message to kick off agent run
  const msgResp = await fetch(`${env.AGENTS_WORKER_URL}/spaces/${spaceId}/sessions/${session.id}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-naelao-tenant-id": tenantId,
      "x-naelao-internal-token": internalToken,
    },
    body: JSON.stringify({ content: task }),
  });
  if (!msgResp.ok) throw new Error(`Agent message failed: ${msgResp.status}`);
  const msgResult = await msgResp.json<{ final_answer?: string; content?: string }>();
  return msgResult.final_answer ?? msgResult.content ?? "[No result]";
}

async function aggregateResults(goal: string, results: string[], env: Env): Promise<string> {
  if (results.length === 0) return "No results collected.";
  if (results.length === 1) return results[0] ?? "";

  const context = results.map((r, i) => `Subtask ${i + 1}: ${r}`).join("\n\n");
  try {
    const resp = await fetch(`${env.LLM_GATEWAY_URL}/v1/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${env.PLATFORM_SECRET}` },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 512,
        messages: [{
          role: "user",
          content: `Goal: ${goal}\n\nSubtask results:\n${context}\n\nSynthesize a final answer:`,
        }],
      }),
    });
    if (!resp.ok) return context;
    const data = await resp.json<{ content?: { type: string; text: string }[] }>();
    const block = data.content?.find((b) => b.type === "text");
    return block?.text ?? context;
  } catch {
    return context;
  }
}

app.onError((err, c) => errorResponse(err, c.get("requestId") ?? "unknown"));

export default { fetch: app.fetch } satisfies ExportedHandler<Env>;
