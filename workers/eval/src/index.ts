// G-Q03: Evaluation Suites Worker — create/run LLM-judged eval suites for Spaces
import { Hono } from "hono";
import { errorResponse, requestId } from "@naelao/http";

interface Env {
  ENVIRONMENT: string;
  PLATFORM_SECRET: string;
  EVAL_LLM_KEY: string; // Anthropic API key for judge
  EVAL_LLM_URL: string;
  PLATFORM_DB: D1Database;
}

interface EvalCase {
  input: string;
  expected_output?: string;
  criteria?: string;
}

interface EvalSuite {
  id: string;
  name: string;
  space_id: string;
  tenant_id: string;
  cases_json: string;
  created_at: string;
}

interface LLMResponse {
  content?: Array<{ type: string; text?: string }>;
}

interface JudgeResult {
  score?: number;
  reason?: string;
}

function validateEnv(env: Env): void {
  if (!env.PLATFORM_SECRET) throw new Error("Missing required secret: PLATFORM_SECRET");
  if (!env.EVAL_LLM_KEY) throw new Error("Missing required secret: EVAL_LLM_KEY");
}

function getCallerIdentity(c: { req: { header: (h: string) => string | undefined } }): { tenantId: string } {
  return { tenantId: c.req.header("x-naelao-tenant-id") ?? "" };
}

const app = new Hono<{ Bindings: Env }>();
app.use("*", requestId);
app.use("*", async (c, next) => { validateEnv(c.env); await next(); });

// POST /v1/evals — create an eval suite
app.post("/v1/evals", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);

  const body = await c.req.json<{
    name: string;
    space_id: string;
    cases: EvalCase[];
  }>();

  if (!body.name || !body.space_id || !Array.isArray(body.cases) || body.cases.length === 0) {
    return c.json({ error_code: "bad_request", message: "name, space_id, and cases are required" }, 400);
  }

  if (body.cases.length > 100) {
    return c.json({ error_code: "bad_request", message: "Maximum 100 eval cases per suite" }, 400);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await c.env.PLATFORM_DB.prepare(
    `INSERT INTO eval_suites (id, name, space_id, tenant_id, cases_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, body.name, body.space_id, tenantId, JSON.stringify(body.cases), now, now).run();

  return c.json({ id, name: body.name, space_id: body.space_id, case_count: body.cases.length, created_at: now }, 201);
});

// GET /v1/evals — list eval suites for tenant
app.get("/v1/evals", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const url = new URL(c.req.url);
  const spaceId = url.searchParams.get("space_id");

  let results: unknown[];
  if (spaceId !== null) {
    const { results: rows } = await c.env.PLATFORM_DB.prepare(
      "SELECT id, name, space_id, created_at FROM eval_suites WHERE tenant_id = ? AND space_id = ? ORDER BY created_at DESC"
    ).bind(tenantId, spaceId).all();
    results = rows;
  } else {
    const { results: rows } = await c.env.PLATFORM_DB.prepare(
      "SELECT id, name, space_id, created_at FROM eval_suites WHERE tenant_id = ? ORDER BY created_at DESC"
    ).bind(tenantId).all();
    results = rows;
  }

  return c.json({ data: results });
});

// POST /v1/evals/:id/run — run an eval suite (LLM judge)
app.post("/v1/evals/:id/run", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const evalId = c.req.param("id");

  const suite = await c.env.PLATFORM_DB.prepare(
    "SELECT * FROM eval_suites WHERE id = ? AND tenant_id = ?"
  ).bind(evalId, tenantId).first<EvalSuite>();

  if (!suite) return c.json({ error_code: "not_found", message: "Eval suite not found" }, 404);

  const cases: EvalCase[] = JSON.parse(suite.cases_json) as EvalCase[];
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();

  // Score each case with LLM judge (Claude Haiku)
  const results: Array<{ case_index: number; score: number; reason: string }> = [];

  for (let i = 0; i < cases.length; i++) {
    const evalCase = cases[i];
    // noUncheckedIndexedAccess: cases[i] can be undefined
    if (evalCase === undefined) continue;

    const judgePrompt = evalCase.expected_output !== undefined
      ? `Input: ${evalCase.input}\nExpected: ${evalCase.expected_output}\nCriteria: ${evalCase.criteria ?? "accuracy and helpfulness"}\n\nScore from 0-10 and explain briefly. Reply as JSON: {"score": N, "reason": "..."}`
      : `Input: ${evalCase.input}\nCriteria: ${evalCase.criteria ?? "helpfulness and safety"}\n\nScore from 0-10. Reply as JSON: {"score": N, "reason": "..."}`;

    try {
      const resp = await fetch(`${c.env.EVAL_LLM_URL}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": c.env.EVAL_LLM_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 200,
          messages: [{ role: "user", content: judgePrompt }],
        }),
        signal: AbortSignal.timeout(15_000),
      });

      if (resp.ok) {
        const data = await resp.json() as LLMResponse;
        const firstContent = data.content?.[0];
        const text = firstContent?.text ?? '{"score":5,"reason":"no response"}';
        const parsed = JSON.parse(text) as JudgeResult;
        results.push({ case_index: i, score: parsed.score ?? 5, reason: parsed.reason ?? "" });
      } else {
        results.push({ case_index: i, score: 0, reason: `LLM error: ${resp.status}` });
      }
    } catch (err) {
      results.push({ case_index: i, score: 0, reason: `Error: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  const avgScore = results.length > 0
    ? results.reduce((sum, r) => sum + r.score, 0) / results.length
    : 0;

  const now = new Date().toISOString();
  await c.env.PLATFORM_DB.prepare(
    `INSERT INTO eval_results (id, eval_suite_id, tenant_id, results_json, avg_score, started_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(runId, evalId, tenantId, JSON.stringify(results), avgScore, startedAt, now).run();

  return c.json({ run_id: runId, eval_suite_id: evalId, avg_score: avgScore, results, started_at: startedAt, completed_at: now });
});

// GET /v1/evals/:id/results — get latest eval results
app.get("/v1/evals/:id/results", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const evalId = c.req.param("id");

  const { results } = await c.env.PLATFORM_DB.prepare(
    "SELECT id, avg_score, started_at, completed_at FROM eval_results WHERE eval_suite_id = ? AND tenant_id = ? ORDER BY started_at DESC LIMIT 10"
  ).bind(evalId, tenantId).all();

  return c.json({ data: results });
});

app.onError((err, c) => errorResponse(err, c.get("requestId") ?? "unknown"));
export default { fetch: app.fetch } satisfies ExportedHandler<Env>;
