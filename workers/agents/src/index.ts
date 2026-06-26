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
import { getDOName } from "@naelao/crypto";
import { detectPromptInjection } from "@naelao/moderation";
import { NaelaoAgentDO } from "./do/NaelaoAgentDO.js";
import { HITLApprovalDO } from "./do/HITLApprovalDO.js";

export { NaelaoAgentDO } from "./do/NaelaoAgentDO.js";
export { HITLApprovalDO } from "./do/HITLApprovalDO.js";

// ── Env interface ─────────────────────────────────────────────────────────────

export interface AgentsEnv {
  ENVIRONMENT: string;
  ANTHROPIC_API_KEY: string;
  PLATFORM_SECRET: string;
  PLATFORM_DB: D1Database;
  NAELAO_AGENT_DO: DurableObjectNamespace<NaelaoAgentDO>;
  HITL_APPROVAL_DO: DurableObjectNamespace<HITLApprovalDO>;
  KNOWLEDGE_WORKER: Fetcher;
  SPACES_WORKER: Fetcher;
  AGENT_CACHE: KVNamespace;
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
  const required = ["ANTHROPIC_API_KEY", "PLATFORM_SECRET"] as const;
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

// Get DO stub for agent session
// G-BA01: HMAC-derived name prevents cross-tenant DO enumeration
async function getAgentDO(
  env: AgentsEnv,
  tenantId: string,
  sessionId: string
): Promise<DurableObjectStub<NaelaoAgentDO>> {
  const doName = await getDOName("agent", sessionId, tenantId, env.PLATFORM_SECRET);
  const doId = env.NAELAO_AGENT_DO.idFromName(doName);
  return env.NAELAO_AGENT_DO.get(doId);
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

  // Get agent DO stub and forward the run request
  const stub = await getAgentDO(c.env, tenantId, sessionId);

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

    const stub = await getAgentDO(c.env, tenantId, sessionId);
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

    const stub = await getAgentDO(c.env, tenantId, sessionId);
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

    const stub = await getAgentDO(c.env, tenantId, sessionId);

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

// ── Error handler ─────────────────────────────────────────────────────────────

app.onError((err, c) =>
  errorResponse(err, c.get("requestId") ?? "unknown")
);

export default { fetch: app.fetch } satisfies ExportedHandler<AgentsEnv>;
