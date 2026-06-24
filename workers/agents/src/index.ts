// ── Agents Worker Entry Point ─────────────────────────────────────────────────
// Fulfills G-D01 through G-D25: Agent worker routes with DO forwarding
//
// Routes:
//   POST   /spaces/:spaceId/sessions/:sessionId/agent/run          — start agent run
//   GET    /spaces/:spaceId/sessions/:sessionId/agent/runs/:runId  — get run status
//   POST   /spaces/:spaceId/sessions/:sessionId/agent/runs/:runId/cancel

import { Hono } from "hono";
import { errorResponse, requestId, notFound, badRequest, unauthorized } from "@naelao/http";
import { NaelaoAgentDO } from "./do/NaelaoAgentDO.js";

export { NaelaoAgentDO } from "./do/NaelaoAgentDO.js";

// ── Env interface ─────────────────────────────────────────────────────────────

export interface AgentsEnv {
  ENVIRONMENT: string;
  ANTHROPIC_API_KEY: string;
  PLATFORM_SECRET: string;
  PLATFORM_DB: D1Database;
  NAELAO_AGENT_DO: DurableObjectNamespace<NaelaoAgentDO>;
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
function getAgentDO(
  env: AgentsEnv,
  tenantId: string,
  sessionId: string
): DurableObjectStub<NaelaoAgentDO> {
  const doId = env.NAELAO_AGENT_DO.idFromName(
    `${tenantId}:agent:${sessionId}`
  );
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

  // Get agent DO stub and forward the run request
  const stub = getAgentDO(c.env, tenantId, sessionId);

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

    const stub = getAgentDO(c.env, tenantId, sessionId);
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

    const stub = getAgentDO(c.env, tenantId, sessionId);
    const doResponse = await stub.fetch(
      new Request(`http://agent-do/runs/${runId}/cancel`, { method: "POST" })
    );

    const doBody = await doResponse.json<unknown>();
    return c.json(doBody, doResponse.status as 200 | 400 | 404 | 500);
  }
);

// ── Error handler ─────────────────────────────────────────────────────────────

app.onError((err, c) =>
  errorResponse(err, c.get("requestId") ?? "unknown")
);

export default { fetch: app.fetch } satisfies ExportedHandler<AgentsEnv>;
