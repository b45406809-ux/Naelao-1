// ── Agents Worker Entry Point ─────────────────────────────────────────────────
// Fulfills G-D01 through G-D25: Agent worker routes with DO forwarding
//
// Routes:
//   POST   /spaces/:spaceId/sessions/:sessionId/agent/run          — start agent run
//   GET    /spaces/:spaceId/sessions/:sessionId/agent/runs/:runId  — get run status
//   POST   /spaces/:spaceId/sessions/:sessionId/agent/runs/:runId/cancel

import { Hono } from "hono";
import { errorResponse, requestId, notFound, badRequest, unauthorized } from "@naelao/http";
import { EntitlementsChecker, getPlanLimits } from "@naelao/entitlements";
import { getDOName, verifyDOTenantPrefix } from "@naelao/crypto";
import { detectPromptInjection } from "@naelao/moderation";
import { NaelaoAgentDO } from "./do/NaelaoAgentDO.js";
import { HITLApprovalDO } from "./do/HITLApprovalDO.js";
import { TaskDO } from "./do/TaskDO.js";
import { ProductDO } from "./do/ProductDO.js";
import { BusinessDO } from "./do/BusinessDO.js";
import { observeWhopBusiness, createWhopProduct, registerAffiliate } from "./whop/client.js";

export { NaelaoAgentDO } from "./do/NaelaoAgentDO.js";
export { HITLApprovalDO } from "./do/HITLApprovalDO.js";
export { TaskDO } from "./do/TaskDO.js";
export { ProductDO } from "./do/ProductDO.js";
export { BusinessDO } from "./do/BusinessDO.js";
export { AgentTaskWorkflow } from "./workflows/AgentTaskWorkflow.js";

// ── Env interface ─────────────────────────────────────────────────────────────

export interface AgentsEnv {
  ENVIRONMENT: string;
  ANTHROPIC_API_KEY: string;
  PLATFORM_SECRET: string;
  WHOP_API_KEY: string;
  NAELAO_WHOP_COMPANY_ID: string;
  PLATFORM_DB: D1Database;
  NAELAO_AGENT_DO: DurableObjectNamespace<NaelaoAgentDO>;
  HITL_APPROVAL_DO: DurableObjectNamespace<HITLApprovalDO>;
  TASK_DO: DurableObjectNamespace<TaskDO>;
  PRODUCT_DO: DurableObjectNamespace<ProductDO>;
  BUSINESS_DO: DurableObjectNamespace<BusinessDO>;
  BUSINESS_R2: R2Bucket;
  KNOWLEDGE_WORKER: Fetcher;
  SPACES_WORKER: Fetcher;
  AGENTS_WORKER: Fetcher;
  AGENT_CACHE: KVNamespace;
  ANALYTICS: AnalyticsEngineDataset;
  AGENT_TASK_WORKFLOW: { create(opts: { id?: string; params?: unknown }): Promise<void> };
}

// ── DB row types ──────────────────────────────────────────────────────────────

interface SpaceRow {
  id: string;
  tenant_id: string;
  spacetype_id: string;
  name: string;
  status: string;
  config_json: string;
}

interface SpaceTypeRow {
  id: string;
  name: string;
  system_prompt_template: string;
  model_config: string;
  tools_config: string;
}

// ── Hono app ──────────────────────────────────────────────────────────────────

// G-A11: Validate required secrets at startup
function validateEnv(env: AgentsEnv): void {
  const required = ["ANTHROPIC_API_KEY", "PLATFORM_SECRET", "WHOP_API_KEY", "NAELAO_WHOP_COMPANY_ID"] as const;
  for (const key of required) {
    if (!env[key]) throw new Error(`Missing required secret: ${key}`);
  }
}

const app = new Hono<{ Bindings: AgentsEnv }>();
app.use("*", requestId);
app.use("*", async (c, next) => { validateEnv(c.env); await next(); });

// Extract caller identity from request headers (set by router after JWT validation)
function getCallerIdentity(c: {
  req: { header: (h: string) => string | undefined };
}) {
  return {
    tenantId: c.req.header("x-naelao-tenant-id") ?? "",
    userId: c.req.header("x-naelao-user-id") ?? "",
    role: c.req.header("x-naelao-role") ?? "viewer",
  };
}

// G-BA01: Log cross-tenant DO probe attempts and apply best-effort rate alerting.
// Uses AGENT_CACHE KV with 5-min TTL windows.
async function recordCrossTenantProbe(
  env: AgentsEnv,
  tenantId: string,
  doName: string,
  requestId: string
): Promise<void> {
  const windowKey = `security:cross_tenant_probe:${tenantId}:${Math.floor(Date.now() / 300_000)}`;
  try {
    const raw = await env.AGENT_CACHE.get(windowKey);
    const count = raw ? parseInt(raw, 10) + 1 : 1;
    await env.AGENT_CACHE.put(windowKey, String(count), { expirationTtl: 300 });
    const severity = count > 3 ? "CRITICAL" : "WARN";
    console.error(
      `[Security][${severity}] G-BA01 cross-tenant DO probe: tenantId=${tenantId} doName=${doName} requestId=${requestId} probeCount=${count}`
    );
  } catch {
    console.error(`[Security][WARN] G-BA01 probe detected but count tracking failed: tenantId=${tenantId}`);
  }
}

// Get DO stub for agent session
// G-BA01: HMAC-derived name prevents cross-tenant DO enumeration; prefix verified before access
async function getAgentDO(
  env: AgentsEnv,
  tenantId: string,
  sessionId: string,
  reqId?: string
): Promise<DurableObjectStub<NaelaoAgentDO>> {
  const doName = await getDOName("agent", sessionId, tenantId, env.PLATFORM_SECRET);
  const valid = await verifyDOTenantPrefix(doName, tenantId, env.PLATFORM_SECRET);
  if (!valid) {
    await recordCrossTenantProbe(env, tenantId, doName, reqId ?? "unknown");
    throw new Error("Cross-tenant DO access denied");
  }
  const doId = env.NAELAO_AGENT_DO.idFromName(doName);
  return env.NAELAO_AGENT_DO.get(doId);
}

// G-AX04: Get TaskDO stub — one DO per space for task state management
function getTaskDO(env: AgentsEnv, spaceId: string): DurableObjectStub<TaskDO> {
  const doId = env.TASK_DO.idFromName(`tasks:${spaceId}`);
  return env.TASK_DO.get(doId);
}

// ── POST /spaces/:spaceId/sessions/:sessionId/agent/run ───────────────────────

app.post("/spaces/:spaceId/sessions/:sessionId/agent/run", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  if (!tenantId) {
    throw unauthorized("Missing tenant identity");
  }

  const spaceId = c.req.param("spaceId");
  const sessionId = c.req.param("sessionId");

  const body = await c.req.json<{ goal: string }>();
  if (!body.goal || typeof body.goal !== "string") {
    throw badRequest("goal is required and must be a string");
  }
  if (body.goal.length > 10_000) {
    throw badRequest("goal must not exceed 10,000 characters");
  }

  // G-AO17: Runtime prompt injection detection — silent detection, no oracle
  const { userId } = getCallerIdentity(c);
  const injectionFlags = detectPromptInjection(body.goal);
  if (injectionFlags.length > 0) {
    // Record attempt and check rate-limit without revealing detection to user
    try {
      const injRes = await c.env.SPACES_WORKER.fetch(
        new Request(`http://spaces-worker/spaces/${spaceId}/me/injection`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-naelao-tenant-id": tenantId,
          },
          body: JSON.stringify({ end_user_id: userId, space_id: spaceId }),
        })
      );
      if (injRes.ok) {
        const injData = await injRes.json<{ rate_limited?: boolean; attempts_last_hour?: number }>();
        if (injData.rate_limited) {
          // Return generic error — do not reveal injection detection
          return c.json({ error_code: "rate_limited", message: "Too many requests" }, 429);
        }
      }
    } catch {
      // Best-effort — never block legitimate users due to injection tracking failures
    }
  }

  // Fetch space from D1 (validate tenant ownership)
  const spaceRow = await c.env.PLATFORM_DB.prepare(
    "SELECT * FROM spaces WHERE id = ? AND tenant_id = ?"
  )
    .bind(spaceId, tenantId)
    .first<SpaceRow>();

  if (!spaceRow) {
    throw notFound("Space");
  }

  if (spaceRow.status !== "active") {
    throw badRequest(`Space is ${spaceRow.status}, cannot run agent`);
  }

  // Fetch space type from D1
  const spaceTypeRow = await c.env.PLATFORM_DB.prepare(
    "SELECT * FROM spacetypes WHERE id = ?"
  )
    .bind(spaceRow.spacetype_id)
    .first<SpaceTypeRow>();

  if (!spaceTypeRow) {
    throw notFound("SpaceType");
  }

  // Parse space type configuration
  let modelConfig: {
    model?: string;
    maxTokens?: number;
    temperature?: number;
  } = {};
  let toolsConfig: Array<{
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
  }> = [];

  try {
    modelConfig = JSON.parse(spaceTypeRow.model_config ?? "{}") as typeof modelConfig;
  } catch {
    modelConfig = {};
  }

  try {
    toolsConfig = JSON.parse(spaceTypeRow.tools_config ?? "[]") as typeof toolsConfig;
  } catch {
    toolsConfig = [];
  }

  // Resolve system prompt template
  const systemPrompt =
    spaceTypeRow.system_prompt_template ??
    "You are a helpful assistant. Answer the user's questions accurately and concisely.";

  // Fetch KB context from knowledge worker (G-D04)
  let kbContext = "";
  try {
    const kbResp = await c.env.KNOWLEDGE_WORKER.fetch(
      `http://knowledge-worker/spaces/${spaceId}/kb/search?q=${encodeURIComponent(body.goal)}&top_k=5`,
      {
        method: "GET",
        headers: {
          "x-naelao-tenant-id": tenantId,
          "x-naelao-user-id": c.req.header("x-naelao-user-id") ?? "",
        },
      }
    );

    if (kbResp.ok) {
      const kbData = await kbResp.json<{
        data?: Array<{ content: string; score?: number }>;
      }>();
      if (kbData.data && kbData.data.length > 0) {
        kbContext = kbData.data
          .map((chunk) => chunk.content)
          .join("\n\n---\n\n");
      }
    }
  } catch {
    // KB context is best-effort — continue without it
    console.warn("Failed to fetch KB context, continuing without it");
  }

  // G-X04: Pre-run token quota check — reject if monthly limit exceeded
  // This prevents unbounded overspend from async billing lag
  try {
    const checker = new EntitlementsChecker(c.env.PLATFORM_DB);
    const tier = await checker.getTenantTier(tenantId);
    const limits = getPlanLimits(tier);
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const tokenUsageRow = await c.env.PLATFORM_DB.prepare(
      `SELECT COALESCE(SUM(quantity), 0) as total FROM usage_events
       WHERE org_id = ? AND event_type = 'llm_tokens' AND recorded_at >= ?`
    ).bind(tenantId, monthStart.toISOString()).first<{ total: number }>();
    const tokensUsed = tokenUsageRow?.total ?? 0;
    if (tokensUsed >= limits.monthly_tokens) {
      return c.json({
        error_code: "quota_exceeded",
        message: `Monthly token limit (${limits.monthly_tokens}) reached for ${tier} plan`,
      }, 429);
    }
  } catch {
    // Best-effort — don't block runs if quota check fails
  }

  // G-AZ19: Semantic response cache check — skip for async tasks (checked per-request only)
  try {
    const cacheResp = await c.env.KNOWLEDGE_WORKER.fetch(
      new Request("http://knowledge-worker/internal/semantic-cache/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: body.goal, spaceId }),
      })
    );
    if (cacheResp.ok) {
      const cacheData = await cacheResp.json<{ hit: boolean; response?: string; similarity?: number }>();
      if (cacheData.hit && cacheData.response) {
        console.log(`[SemanticCache] Cache hit for spaceId=${spaceId} similarity=${cacheData.similarity}`);
        return c.json(
          JSON.parse(cacheData.response),
          200,
          { "X-Cache": "HIT", "X-Cache-Similarity": String(cacheData.similarity ?? 0) }
        );
      }
    }
  } catch {
    // Cache lookup errors must never block the main request
  }

  // G-AX04: Async task dispatch — if client sends Prefer: respond-async, return 202 immediately
  const preferAsync = (c.req.header("prefer") ?? "").toLowerCase().includes("respond-async");
  const callbackUrl = (body as Record<string, unknown>)["callback_url"] as string | undefined;

  if (preferAsync && c.env.AGENT_TASK_WORKFLOW && c.env.TASK_DO) {
    const taskId = crypto.randomUUID();
    const taskDoName = `tasks:${spaceId}`;
    const taskStub = getTaskDO(c.env, spaceId);

    // Create task record
    const createResp = await taskStub.fetch("http://task-do/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: taskId,
        space_id: spaceId,
        session_id: sessionId,
        tenant_id: tenantId,
        goal: body.goal,
        callback_url: callbackUrl ?? null,
      }),
    });
    if (!createResp.ok) {
      throw new Error("Failed to create async task record");
    }

    // Start workflow for background execution
    await c.env.AGENT_TASK_WORKFLOW.create({
      id: taskId,
      params: {
        taskId,
        spaceId,
        sessionId,
        tenantId,
        goal: body.goal,
        systemPrompt,
        tools: toolsConfig,
        kbContext,
        model: modelConfig.model ?? "claude-sonnet-4-6",
        taskDoName,
      },
    });

    return c.json(
      {
        task_id: taskId,
        status: "queued",
        status_url: `/spaces/${spaceId}/tasks/${taskId}`,
      },
      202,
    );
  }

  // Get agent DO stub and forward the run request
  const stub = await getAgentDO(c.env, tenantId, sessionId, c.get("requestId"));

  const doResponse = await stub.fetch(
    new Request("http://agent-do/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goal: body.goal,
        sessionId,
        spaceId,
        tenantId,
        systemPrompt,
        tools: toolsConfig,
        kbContext,
        apiKey: c.env.ANTHROPIC_API_KEY,
        model: modelConfig.model ?? "claude-sonnet-4-6",
        allowedDomains: [],
      }),
    })
  );

  const doBody = await doResponse.json<unknown>();

  // G-AZ19: Store successful agent response in semantic cache for future hits
  if (doResponse.ok) {
    c.executionCtx.waitUntil(
      c.env.KNOWLEDGE_WORKER.fetch(
        new Request("http://knowledge-worker/internal/semantic-cache/store", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: body.goal, spaceId, response: JSON.stringify(doBody) }),
        })
      ).catch(() => {})
    );
  }

  return c.json(doBody, doResponse.status as 200 | 201 | 400 | 404 | 422 | 500);
});

// ── GET /spaces/:spaceId/sessions/:sessionId/agent/runs/:runId ────────────────

app.get(
  "/spaces/:spaceId/sessions/:sessionId/agent/runs/:runId",
  async (c) => {
    const { tenantId } = getCallerIdentity(c);
    if (!tenantId) throw unauthorized("Missing tenant identity");

    const spaceId = c.req.param("spaceId");
    const sessionId = c.req.param("sessionId");
    const runId = c.req.param("runId");

    // Validate space ownership
    const space = await c.env.PLATFORM_DB.prepare(
      "SELECT id FROM spaces WHERE id = ? AND tenant_id = ?"
    )
      .bind(spaceId, tenantId)
      .first<{ id: string }>();

    if (!space) throw notFound("Space");

    const stub = await getAgentDO(c.env, tenantId, sessionId, c.get("requestId"));
    const doResponse = await stub.fetch(
      new Request(`http://agent-do/runs/${runId}`, { method: "GET" })
    );

    const doBody = await doResponse.json<unknown>();
    return c.json(doBody, doResponse.status as 200 | 404 | 500);
  }
);

// ── POST /spaces/:spaceId/sessions/:sessionId/agent/runs/:runId/cancel ────────

app.post(
  "/spaces/:spaceId/sessions/:sessionId/agent/runs/:runId/cancel",
  async (c) => {
    const { tenantId } = getCallerIdentity(c);
    if (!tenantId) throw unauthorized("Missing tenant identity");

    const spaceId = c.req.param("spaceId");
    const sessionId = c.req.param("sessionId");
    const runId = c.req.param("runId");

    // Validate space ownership
    const space = await c.env.PLATFORM_DB.prepare(
      "SELECT id FROM spaces WHERE id = ? AND tenant_id = ?"
    )
      .bind(spaceId, tenantId)
      .first<{ id: string }>();

    if (!space) throw notFound("Space");

    const stub = await getAgentDO(c.env, tenantId, sessionId, c.get("requestId"));
    const doResponse = await stub.fetch(
      new Request(`http://agent-do/runs/${runId}/cancel`, { method: "POST" })
    );

    const doBody = await doResponse.json<unknown>();
    return c.json(doBody, doResponse.status as 200 | 400 | 404 | 500);
  }
);

// ── GET /spaces/:spaceId/sessions/:sessionId/agent/runs/:runId/stream ─────────
// G-AF08: SSE streaming for live agent run updates

app.get(
  "/spaces/:spaceId/sessions/:sessionId/agent/runs/:runId/stream",
  async (c) => {
    const { tenantId } = getCallerIdentity(c);
    if (!tenantId) throw unauthorized("Missing tenant identity");

    const spaceId = c.req.param("spaceId");
    const sessionId = c.req.param("sessionId");
    const runId = c.req.param("runId");

    // Validate space ownership
    const space = await c.env.PLATFORM_DB.prepare(
      "SELECT id FROM spaces WHERE id = ? AND tenant_id = ?"
    )
      .bind(spaceId, tenantId)
      .first<{ id: string }>();
    if (!space) throw notFound("Space");

    // G-D12: Enforce SSE streaming feature gate at the API layer
    await new EntitlementsChecker(c.env.PLATFORM_DB).requireFeature(tenantId, "sse_streaming");

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const enc = new TextEncoder();

    const sendEvent = async (event: string, data: unknown): Promise<void> => {
      const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      await writer.write(enc.encode(line));
    };

    const stub = await getAgentDO(c.env, tenantId, sessionId, c.get("requestId"));

    // Poll the DO until the run terminates (max 2 minutes)
    const pollTask = async (): Promise<void> => {
      try {
        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline) {
          const resp = await stub.fetch(
            new Request(`http://agent-do/runs/${runId}`, { method: "GET" })
          );
          const run = await resp.json<{
            status: string;
            final_answer?: string;
            error?: string;
            react_steps?: unknown[];
          }>();

          await sendEvent("status", {
            run_id: runId,
            status: run.status,
            steps: run.react_steps?.length ?? 0,
          });

          if (
            run.status === "completed" ||
            run.status === "failed" ||
            run.status === "cancelled"
          ) {
            await sendEvent("done", { run_id: runId, status: run.status, final_answer: run.final_answer, error: run.error });
            break;
          }

          await new Promise<void>((r) => setTimeout(r, 1000));
        }
      } catch (err) {
        try {
          await sendEvent("error", { message: err instanceof Error ? err.message : String(err) });
        } catch { /* ignore write error after close */ }
      } finally {
        try { await writer.close(); } catch { /* already closed */ }
      }
    };

    c.executionCtx.waitUntil(pollTask());

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-store",
        "X-Accel-Buffering": "no",
        "Connection": "keep-alive",
      },
    });
  }
);

// ── G-AX04: Async Task routes ─────────────────────────────────────────────────
// GET  /spaces/:spaceId/tasks             — list tasks for space
// GET  /spaces/:spaceId/tasks/:taskId     — poll task status (optional ?timeout=30)
// POST /internal/tasks/:taskId/run        — internal: invoked by AgentTaskWorkflow

app.get("/spaces/:spaceId/tasks", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  if (!tenantId) throw unauthorized("Missing tenant identity");
  const spaceId = c.req.param("spaceId");

  const space = await c.env.PLATFORM_DB.prepare(
    "SELECT id FROM spaces WHERE id = ? AND tenant_id = ?"
  ).bind(spaceId, tenantId).first<{ id: string }>();
  if (!space) throw notFound("Space");

  const stub = getTaskDO(c.env, spaceId);
  return stub.fetch(`http://task-do/tasks?space_id=${spaceId}`);
});

app.get("/spaces/:spaceId/tasks/:taskId", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  if (!tenantId) throw unauthorized("Missing tenant identity");
  const spaceId = c.req.param("spaceId");
  const taskId = c.req.param("taskId");

  const space = await c.env.PLATFORM_DB.prepare(
    "SELECT id FROM spaces WHERE id = ? AND tenant_id = ?"
  ).bind(spaceId, tenantId).first<{ id: string }>();
  if (!space) throw notFound("Space");

  const timeout = c.req.query("timeout") ?? "0";
  const stub = getTaskDO(c.env, spaceId);
  return stub.fetch(`http://task-do/tasks/${taskId}?timeout=${timeout}`);
});

// Internal route: AgentTaskWorkflow calls this to execute the agent synchronously
app.post("/internal/tasks/:taskId/run", async (c) => {
  const taskId = c.req.param("taskId");
  const body = await c.req.json<{
    taskId: string;
    spaceId: string;
    sessionId: string;
    tenantId: string;
    goal: string;
    systemPrompt: string;
    tools: unknown[];
    kbContext: string;
    model: string;
  }>();

  try {
    const stub = await getAgentDO(c.env, body.tenantId, body.sessionId);
    const doResponse = await stub.fetch(
      new Request("http://agent-do/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          goal: body.goal,
          sessionId: body.sessionId,
          spaceId: body.spaceId,
          tenantId: body.tenantId,
          systemPrompt: body.systemPrompt,
          tools: body.tools,
          kbContext: body.kbContext,
          apiKey: c.env.ANTHROPIC_API_KEY,
          model: body.model,
          allowedDomains: [],
        }),
      })
    );
    const result = await doResponse.json<{ final_answer?: string; error?: string }>();
    return c.json(result, doResponse.status as 200 | 201 | 400 | 500);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

// ── G-AY01: HITL Approval routes ──────────────────────────────────────────────
// GET  /spaces/:spaceId/sessions/:sessionId/approvals          — list pending
// PUT  /spaces/:spaceId/sessions/:sessionId/approvals/:id/approve
// PUT  /spaces/:spaceId/sessions/:sessionId/approvals/:id/reject

function getHitlDo(env: AgentsEnv, spaceId: string) {
  const doId = env.HITL_APPROVAL_DO.idFromName(`hitl:${spaceId}`);
  return env.HITL_APPROVAL_DO.get(doId);
}

app.get("/spaces/:spaceId/sessions/:sessionId/approvals", async (c) => {
  const { spaceId, sessionId } = c.req.param();
  const stub = getHitlDo(c.env, spaceId);
  const runId = c.req.query("run_id");
  const url = runId ? `/requests?run_id=${runId}` : `/requests?session_id=${sessionId}`;
  return stub.fetch(`http://do${url}`);
});

app.put("/spaces/:spaceId/sessions/:sessionId/approvals/:approvalId/approve", async (c) => {
  const { spaceId, approvalId } = c.req.param();
  const stub = getHitlDo(c.env, spaceId);
  return stub.fetch(`http://do/requests/${approvalId}/approve`, { method: "PUT" });
});

app.put("/spaces/:spaceId/sessions/:sessionId/approvals/:approvalId/reject", async (c) => {
  const { spaceId, approvalId } = c.req.param();
  const body = await c.req.json<{ reason?: string }>().catch(() => ({}));
  const stub = getHitlDo(c.env, spaceId);
  return stub.fetch(`http://do/requests/${approvalId}/reject`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
});

// ── ProductDO routes — /product/* ─────────────────────────────────────────────

function getProductDO(env: AgentsEnv) {
  const id = env.PRODUCT_DO.idFromName("product");
  return env.PRODUCT_DO.get(id);
}

function getBusinessDO(env: AgentsEnv, userId: string) {
  const id = env.BUSINESS_DO.idFromName(`business:${userId}`);
  return env.BUSINESS_DO.get(id);
}

app.get("/product/config", async (c) => {
  return getProductDO(c.env).fetch(new Request("http://do/config"));
});

app.patch("/product/config", async (c) => {
  return getProductDO(c.env).fetch(new Request("http://do/config", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(await c.req.json()),
  }));
});

app.get("/product/signup-gate", async (c) => {
  return getProductDO(c.env).fetch(new Request("http://do/signup-gate"));
});

// Business registry (for nightly cron iteration)
app.get("/product/businesses", async (c) => {
  return getProductDO(c.env).fetch(new Request("http://do/businesses"));
});

app.post("/product/businesses", async (c) => {
  return getProductDO(c.env).fetch(new Request("http://do/businesses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(await c.req.json()),
  }));
});

app.delete("/product/businesses/:userId", async (c) => {
  const { userId } = c.req.param();
  return getProductDO(c.env).fetch(new Request(`http://do/businesses/${userId}`, { method: "DELETE" }));
});

// ── BusinessDO routes — /business/:userId/* ───────────────────────────────────

app.get("/business/:userId/status", async (c) => {
  const { userId } = c.req.param();
  return getBusinessDO(c.env, userId).fetch(new Request("http://do/status"));
});

app.patch("/business/:userId/config", async (c) => {
  const { userId } = c.req.param();
  return getBusinessDO(c.env, userId).fetch(new Request("http://do/config", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(await c.req.json()),
  }));
});

app.post("/business/:userId/cycle", async (c) => {
  const { userId } = c.req.param();
  return getBusinessDO(c.env, userId).fetch(new Request("http://do/cycle", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...(await c.req.json<Record<string, unknown>>()), api_key: c.env.ANTHROPIC_API_KEY }),
  }));
});

app.get("/business/:userId/outcome-log", async (c) => {
  const { userId } = c.req.param();
  const limit = c.req.query("limit") ?? "50";
  return getBusinessDO(c.env, userId).fetch(new Request(`http://do/outcome-log?limit=${limit}`));
});

app.get("/business/:userId/scripts", async (c) => {
  const { userId } = c.req.param();
  return getBusinessDO(c.env, userId).fetch(new Request("http://do/scripts"));
});

app.post("/business/:userId/scripts", async (c) => {
  const { userId } = c.req.param();
  return getBusinessDO(c.env, userId).fetch(new Request("http://do/scripts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(await c.req.json()),
  }));
});

app.get("/business/:userId/scripts/:name", async (c) => {
  const { userId, name } = c.req.param();
  return getBusinessDO(c.env, userId).fetch(new Request(`http://do/scripts/${name}`));
});

app.patch("/business/:userId/scripts/:name", async (c) => {
  const { userId, name } = c.req.param();
  return getBusinessDO(c.env, userId).fetch(new Request(`http://do/scripts/${name}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(await c.req.json()),
  }));
});

app.delete("/business/:userId/scripts/:name", async (c) => {
  const { userId, name } = c.req.param();
  return getBusinessDO(c.env, userId).fetch(new Request(`http://do/scripts/${name}`, { method: "DELETE" }));
});

app.get("/business/:userId/autonomy", async (c) => {
  const { userId } = c.req.param();
  return getBusinessDO(c.env, userId).fetch(new Request("http://do/autonomy"));
});

app.patch("/business/:userId/autonomy", async (c) => {
  const { userId } = c.req.param();
  return getBusinessDO(c.env, userId).fetch(new Request("http://do/autonomy", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(await c.req.json()),
  }));
});

// POST /business/:userId/scripts/seed — pre-populate script registry
app.post("/business/:userId/scripts/seed", async (c) => {
  const { userId } = c.req.param();
  return getBusinessDO(c.env, userId).fetch(new Request("http://do/scripts/seed", { method: "POST" }));
});

// POST /business/:userId/onboard — full onboarding flow (§06)
// 1. Check signup gate   2. Create Whop product   3. Register affiliate
// 4. Save IDs to BusinessDO   5. Register user in ProductDO businesses list
app.post("/business/:userId/onboard", async (c) => {
  const { userId } = c.req.param();
  const env = c.env;

  // 1. Signup gate
  const gateResp = await getProductDO(env).fetch(new Request("http://do/signup-gate"));
  if (!gateResp.ok) {
    const body = await gateResp.json<{ allowed: boolean; reason?: string }>();
    return Response.json({ error: body.reason ?? "Signups are closed" }, { status: 403 });
  }

  const body = await c.req.json<{
    product_name: string;
    product_description: string;
    price_usd: number;
    billing_period: "monthly" | "one_time";
  }>();

  if (!body.product_name || !body.price_usd) {
    return Response.json({ error: "product_name and price_usd required" }, { status: 400 });
  }

  const whopConfig = { apiKey: env.WHOP_API_KEY };
  const idBase = `${userId}:${Date.now()}`;

  // 2. Create Whop product
  let product;
  try {
    product = await createWhopProduct(whopConfig, {
      name: body.product_name,
      description: body.product_description ?? "",
      price_usd: body.price_usd,
      billing_period: body.billing_period ?? "monthly",
      idempotency_key: `create-product:${idBase}`,
    });
  } catch (err) {
    return Response.json({ error: `Whop product creation failed: ${String(err)}` }, { status: 502 });
  }

  // 3. Register Naelao as affiliate-of-record
  let affiliate;
  try {
    affiliate = await registerAffiliate(whopConfig, {
      product_id: product.id,
      affiliate_company_id: env.NAELAO_WHOP_COMPANY_ID,
      commission_percentage: 20,
      idempotency_key: `affiliate:${idBase}`,
    });
  } catch (err) {
    // Non-fatal: product is created; log and continue
    console.warn(`[onboard] Affiliate registration failed for ${userId}:`, err);
  }

  // 4. Save Whop product ID + affiliate ID to BusinessDO
  const bizDO = getBusinessDO(env, userId);
  await bizDO.fetch(new Request("http://do/config", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      whop_product_id: product.id,
      affiliate_registration_id: affiliate?.id ?? null,
      template_id: "whop-businesses-v1",
      template_version: "1",
      user_id: userId,
    }),
  }));

  // 5. Seed script registry with common action types
  await bizDO.fetch(new Request("http://do/scripts/seed", { method: "POST" }));

  // 6. Register user in ProductDO businesses list (for nightly cron)
  await getProductDO(env).fetch(new Request("http://do/businesses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId }),
  }));

  // Emit analytics
  try {
    env.ANALYTICS.writeDataPoint({
      blobs: ["business.onboarded", userId, product.id],
      doubles: [Date.now()],
      indexes: [userId],
    });
  } catch { /* best-effort */ }

  return Response.json({
    product_id: product.id,
    affiliate_id: affiliate?.id ?? null,
    template_version: "1",
    autonomy_tier: 1,
  }, { status: 201 });
});

// ── Error handler ─────────────────────────────────────────────────────────────

app.onError((err, c) =>
  errorResponse(err, c.get("requestId") ?? "unknown")
);

// ── Scheduled handler — nightly cycle cron (§09 Build Sequence) ───────────────
// Fires at 02:00 UTC daily. Iterates all registered businesses and triggers
// the script-first execution cycle for each one.

async function handleScheduled(env: AgentsEnv): Promise<void> {
  // Fetch all registered business user IDs from ProductDO
  const productDO = env.PRODUCT_DO.get(env.PRODUCT_DO.idFromName("product"));
  let userIds: string[] = [];
  try {
    const resp = await productDO.fetch(new Request("http://do/businesses"));
    if (resp.ok) {
      const data = await resp.json<{ user_ids: string[] }>();
      userIds = data.user_ids ?? [];
    }
  } catch (err) {
    console.error("[scheduled] Failed to fetch business list:", err);
    return;
  }

  // Fire nightly cycle for each business (observe snapshot from Whop, then run)
  const whopConfig = { apiKey: env.WHOP_API_KEY };

  for (const userId of userIds) {
    try {
      const bizDO = env.BUSINESS_DO.get(env.BUSINESS_DO.idFromName(`business:${userId}`));

      // Get the whop_product_id from this business
      const statusResp = await bizDO.fetch(new Request("http://do/status"));
      if (!statusResp.ok) continue;
      const status = await statusResp.json<{ whop_product_id: string | null; fiber_status: string }>();
      if (!status.whop_product_id) continue;

      // Skip if a cycle is already running
      if (status.fiber_status === "running") continue;

      // OBSERVE: pull current Whop snapshot
      let snapshot: Record<string, unknown> = {};
      try {
        snapshot = await observeWhopBusiness(whopConfig, status.whop_product_id) as unknown as Record<string, unknown>;
      } catch (err) {
        console.warn(`[scheduled] Observe failed for ${userId}:`, err);
      }

      // Trigger the cycle with the fresh snapshot
      await bizDO.fetch(new Request("http://do/cycle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: env.ANTHROPIC_API_KEY,
          observe_snapshot: snapshot,
          task_description: "Nightly cycle: review community engagement, post an update if warranted, check revenue delta",
        }),
      }));
    } catch (err) {
      console.error(`[scheduled] Cycle failed for user ${userId}:`, err);
    }
  }
}

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: AgentsEnv, _ctx: ExecutionContext): Promise<void> {
    await handleScheduled(env);
  },
} satisfies ExportedHandler<AgentsEnv>;
