// G-Q03: Evaluation Suites Worker — create/run LLM-judged eval suites for Spaces
//
// §A1 Harness Excellence Phase HX3: this worker used to only ever judge a case's raw `input`
// text as if it WERE the agent's answer — it never actually invoked an agent, so an eval suite
// could never catch a real regression in the reasoning loop, tool routing, or a skill. It also
// called api.anthropic.com directly with a hardcoded model, bypassing the CF AI Gateway vendor
// cutover (item 45) that every other LLM call site in the platform already went through — a real,
// previously-undetected gap in that migration. Both are fixed here: `mode: "agent"` dispatches a
// real /agent/run against a designated eval space+session before judging; the judge itself now
// routes through @naelao/llm-gateway's callLlm (CF AI Gateway, gateway-held key, no local
// ANTHROPIC_API_KEY needed) instead of a raw fetch. The judge also now scores semantic validity
// separately from correctness — a reward-hacked answer that stuffs matching keywords without
// actually doing the task should score low on semantic_validity even if correctness looks high
// (research finding: ~20% of "solved" SWE-bench entries are reward-hacked; a validation gate that
// only pattern-matches text is not a real gate).
import { Hono } from "hono";
import { errorResponse, requestId, mintInternalToken } from "@naelao/http";
import { callLlm, LlmGatewayError } from "@naelao/llm-gateway";
import type { LlmRequest } from "@naelao/llm-gateway";

interface Env {
  ENVIRONMENT: string;
  PLATFORM_SECRET: string;
  EVAL_LLM_KEY?: string; // Anthropic API key for judge — optional when NAELAO_AIG_TOKEN is set
  PLATFORM_DB: D1Database;
  AGENTS_WORKER?: Fetcher;
  // CF AI Gateway (spec §15 / item 45 vendor cutover) — mirrors every other worker's config shape.
  NAELAO_ACCOUNT_ID?: string;
  NAELAO_GATEWAY_ID?: string;
  NAELAO_AIG_TOKEN?: string;
}

interface EvalCase {
  input: string;
  expected_output?: string;
  criteria?: string;
  tags?: string[];
}

interface EvalSuite {
  id: string;
  name: string;
  space_id: string;
  tenant_id: string;
  cases_json: string;
  created_at: string;
}

interface JudgeResult {
  score?: number;
  correctness?: number;
  semantic_validity?: number;
  reason?: string;
}

function validateEnv(env: Env): void {
  if (!env.PLATFORM_SECRET) throw new Error("Missing required secret: PLATFORM_SECRET");
  if (!env.EVAL_LLM_KEY && !env.NAELAO_AIG_TOKEN) {
    throw new Error("Missing LLM credentials: set EVAL_LLM_KEY or NAELAO_AIG_TOKEN (CF AI Gateway stored key)");
  }
}

function getCallerIdentity(c: { req: { header: (h: string) => string | undefined } }): { tenantId: string } {
  return { tenantId: c.req.header("x-naelao-tenant-id") ?? "" };
}

function gatewayConfig(env: Env): { accountId: string; gatewayId: string; aigToken?: string } | undefined {
  if (!env.NAELAO_ACCOUNT_ID || !env.NAELAO_GATEWAY_ID) return undefined;
  return {
    accountId: env.NAELAO_ACCOUNT_ID,
    gatewayId: env.NAELAO_GATEWAY_ID,
    ...(env.NAELAO_AIG_TOKEN ? { aigToken: env.NAELAO_AIG_TOKEN } : {}),
  };
}

// Judge a candidate answer (either the raw case input in "text" mode, or a real agent's final
// answer in "agent" mode) against the case's expected_output/criteria. Returns two subscores so
// a reward-hacked answer (matches keywords but doesn't actually solve the task) is caught by
// semantic_validity even when correctness looks fine on a shallow read.
async function judgeAnswer(
  env: Env,
  evalCase: EvalCase,
  candidateAnswer: string
): Promise<{ score: number; correctness: number; semantic_validity: number; reason: string }> {
  const judgePrompt = evalCase.expected_output !== undefined
    ? `Task: ${evalCase.input}\nExpected: ${evalCase.expected_output}\nCriteria: ${evalCase.criteria ?? "accuracy and helpfulness"}\n\nCandidate answer:\n${candidateAnswer}\n\nScore the candidate answer on two dimensions, 0-10 each:\n- correctness: does it match the expected output / satisfy the criteria?\n- semantic_validity: does it genuinely address the task (not just repeat matching keywords without actually solving it)?\n\nReply as JSON only: {"correctness": N, "semantic_validity": N, "reason": "..."}`
    : `Task: ${evalCase.input}\nCriteria: ${evalCase.criteria ?? "helpfulness and safety"}\n\nCandidate answer:\n${candidateAnswer}\n\nScore the candidate answer on two dimensions, 0-10 each:\n- correctness: does it satisfy the criteria?\n- semantic_validity: does it genuinely address the task?\n\nReply as JSON only: {"correctness": N, "semantic_validity": N, "reason": "..."}`;

  const request: LlmRequest = {
    model: "claude-haiku-4-5-20251001",
    max_tokens: 250,
    messages: [{ role: "user", content: judgePrompt }],
  };

  try {
    const response = await callLlm(env.EVAL_LLM_KEY ?? "", request, AbortSignal.timeout(15_000), gatewayConfig(env));
    const firstBlock = response.content.find((b: { type: string }) => b.type === "text");
    const text = firstBlock && "text" in firstBlock ? firstBlock.text : undefined;
    const parsed = text ? (JSON.parse(text) as JudgeResult) : {};
    const correctness = parsed.correctness ?? parsed.score ?? 5;
    const semanticValidity = parsed.semantic_validity ?? correctness;
    // The overall score is the MIN of the two subscores, not their average — a high-correctness,
    // low-semantic-validity answer (the reward-hacking pattern) must not average out to a passing
    // grade.
    return {
      score: Math.min(correctness, semanticValidity),
      correctness,
      semantic_validity: semanticValidity,
      reason: parsed.reason ?? "",
    };
  } catch (err: unknown) {
    const message = err instanceof LlmGatewayError ? err.message : (err instanceof Error ? err.message : String(err));
    return { score: 0, correctness: 0, semantic_validity: 0, reason: `Judge error: ${message}` };
  }
}

// Dispatch a real agent run for this case's `input` as the goal, against the eval suite's own
// designated space+session, and return the agent's final answer. Uses Prefer: respond-sync so
// the eval can judge synchronously rather than polling — same escape hatch every other
// programmatic /agent/run caller in this codebase uses for a blocking result.
async function runAgentForCase(
  env: Env,
  tenantId: string,
  spaceId: string,
  sessionId: string,
  agentDefinitionId: string | undefined,
  evalCase: EvalCase
): Promise<{ answer: string; runId: string | null; error?: string }> {
  if (!env.AGENTS_WORKER) {
    return { answer: "", runId: null, error: "AGENTS_WORKER binding not configured" };
  }
  const token = await mintInternalToken(env.PLATFORM_SECRET, tenantId);
  const resp = await env.AGENTS_WORKER.fetch(
    new Request(`http://agents-worker/spaces/${spaceId}/sessions/${sessionId}/agent/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": tenantId,
        "x-naelao-internal-token": token,
        "prefer": "respond-sync",
      },
      body: JSON.stringify({
        goal: evalCase.input,
        ...(agentDefinitionId ? { agent_definition_id: agentDefinitionId } : {}),
      }),
      signal: AbortSignal.timeout(60_000),
    })
  );

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    return { answer: "", runId: null, error: `agent/run HTTP ${resp.status}: ${errText.slice(0, 500)}` };
  }

  const body = await resp.json<{ finalAnswer?: string | null; final_answer?: string | null; runId?: string; status?: string; error?: string }>();
  if (body.status === "failed" || body.error) {
    return { answer: "", runId: body.runId ?? null, error: body.error ?? "agent run failed" };
  }
  const answer = body.finalAnswer ?? body.final_answer ?? "";
  return { answer, runId: body.runId ?? null };
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

// POST /v1/evals/:id/run — run an eval suite. Two modes:
//   - "text" (default, unchanged behavior): judge each case's raw `input` directly — useful for
//     one-off prompt/criteria sanity checks, but never exercises the actual agent runtime.
//   - "agent": dispatch a REAL /agent/run per case against session_id (required), judge the
//     agent's actual final answer. This is the mode that catches real regressions.
app.post("/v1/evals/:id/run", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const evalId = c.req.param("id");

  const suite = await c.env.PLATFORM_DB.prepare(
    "SELECT * FROM eval_suites WHERE id = ? AND tenant_id = ?"
  ).bind(evalId, tenantId).first<EvalSuite>();

  if (!suite) return c.json({ error_code: "not_found", message: "Eval suite not found" }, 404);

  const runBody = await c.req.json<{ mode?: "text" | "agent"; session_id?: string; agent_definition_id?: string }>().catch(() => ({} as { mode?: "text" | "agent"; session_id?: string; agent_definition_id?: string }));
  const mode = runBody.mode === "agent" ? "agent" : "text";
  if (mode === "agent" && !runBody.session_id) {
    return c.json({ error_code: "bad_request", message: "session_id is required for mode=agent" }, 400);
  }

  const cases: EvalCase[] = JSON.parse(suite.cases_json) as EvalCase[];
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();

  const results: Array<{ case_index: number; score: number; correctness: number; semantic_validity: number; reason: string; agent_run_id?: string | null; agent_error?: string }> = [];

  for (let i = 0; i < cases.length; i++) {
    const evalCase = cases[i];
    // noUncheckedIndexedAccess: cases[i] can be undefined
    if (evalCase === undefined) continue;

    if (mode === "agent") {
      const agentResult = await runAgentForCase(c.env, tenantId, suite.space_id, runBody.session_id!, runBody.agent_definition_id, evalCase);
      if (agentResult.error) {
        results.push({ case_index: i, score: 0, correctness: 0, semantic_validity: 0, reason: agentResult.error, agent_run_id: agentResult.runId, agent_error: agentResult.error });
        continue;
      }
      const judged = await judgeAnswer(c.env, evalCase, agentResult.answer);
      results.push({ case_index: i, ...judged, agent_run_id: agentResult.runId });
    } else {
      const judged = await judgeAnswer(c.env, evalCase, evalCase.input);
      results.push({ case_index: i, ...judged });
    }
  }

  const avgScore = results.length > 0
    ? results.reduce((sum, r) => sum + r.score, 0) / results.length
    : 0;

  const now = new Date().toISOString();
  await c.env.PLATFORM_DB.prepare(
    `INSERT INTO eval_results (id, eval_suite_id, tenant_id, results_json, avg_score, started_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(runId, evalId, tenantId, JSON.stringify({ mode, results }), avgScore, startedAt, now).run();

  return c.json({ run_id: runId, eval_suite_id: evalId, mode, avg_score: avgScore, results, started_at: startedAt, completed_at: now });
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
export { app };
export type { Env, EvalCase };
export default { fetch: app.fetch } satisfies ExportedHandler<Env>;
