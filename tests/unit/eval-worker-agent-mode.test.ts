import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { app } from "../../workers/eval/src/index.js";
import type { Env } from "../../workers/eval/src/index.js";

// §A1 Harness Excellence Phase HX3: workers/eval used to only ever judge a case's raw `input`
// text and called api.anthropic.com directly with a hardcoded model — it never actually invoked
// an agent, and bypassed the CF AI Gateway vendor cutover (item 45) every other LLM call site
// already went through. These tests drive the real Hono app end-to-end: suite creation, the
// default "text" mode (unchanged behavior), the new "agent" mode (real /agent/run dispatch via
// AGENTS_WORKER + judged against the agent's actual answer, not the raw case text), and the
// judge's own CF AI Gateway routing.

const TENANT = "tenant-a";

function makeDb() {
  const suites: Array<{ id: string; name: string; space_id: string; tenant_id: string; cases_json: string; created_at: string }> = [];
  const results: Array<{ id: string; eval_suite_id: string; tenant_id: string; results_json: string; avg_score: number; started_at: string; completed_at: string }> = [];
  return {
    suites,
    results,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes("FROM eval_suites")) {
                const [id, tenantId] = args as [string, string];
                const row = suites.find((s) => s.id === id && s.tenant_id === tenantId);
                return (row ?? null) as T | null;
              }
              return null;
            },
            async all() {
              return { results: [] };
            },
            async run() {
              if (sql.includes("INSERT INTO eval_suites")) {
                const [id, name, spaceId, tenantId, casesJson, createdAt] = args as [string, string, string, string, string, string, string];
                suites.push({ id, name, space_id: spaceId, tenant_id: tenantId, cases_json: casesJson, created_at: createdAt });
              } else if (sql.includes("INSERT INTO eval_results")) {
                const [id, evalSuiteId, tenantId, resultsJson, avgScore, startedAt, completedAt] = args as [string, string, string, string, number, string, string];
                results.push({ id, eval_suite_id: evalSuiteId, tenant_id: tenantId, results_json: resultsJson, avg_score: avgScore, started_at: startedAt, completed_at: completedAt });
              }
              return { success: true, meta: {} };
            },
          };
        },
      };
    },
  };
}

function makeJudgeResponse(correctness: number, semanticValidity: number, reason = "ok") {
  return {
    id: "msg_1",
    model: "claude-haiku-4-5-20251001",
    role: "assistant",
    content: [{ type: "text", text: JSON.stringify({ correctness, semantic_validity: semanticValidity, reason }) }],
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}

function makeEnv(db: ReturnType<typeof makeDb>, opts: { agentsWorker?: { fetch: (req: Request) => Promise<Response> } } = {}) {
  return {
    ENVIRONMENT: "test",
    PLATFORM_SECRET: "test-secret",
    EVAL_LLM_KEY: "sk-test",
    PLATFORM_DB: db as unknown as D1Database,
    ...(opts.agentsWorker ? { AGENTS_WORKER: opts.agentsWorker as unknown as Fetcher } : {}),
  } as Env;
}

const execCtx = { waitUntil: (p: Promise<unknown>) => { void p; }, passThroughOnException() {} } as unknown as ExecutionContext;

async function req(path: string, init: RequestInit, env: Env) {
  return app.fetch(new Request(`https://eval.naelao.com${path}`, { ...init, headers: { "content-type": "application/json", "x-naelao-tenant-id": TENANT, ...(init.headers ?? {}) } }), env, execCtx);
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("anthropic.com") || url.includes("gateway.ai.cloudflare.com")) {
      return new Response(JSON.stringify(makeJudgeResponse(8, 8)), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "unhandled" }), { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("eval worker — suite creation + text mode (unchanged behavior)", () => {
  it("creates a suite and runs it in default text mode, judging the raw case input", async () => {
    const db = makeDb();
    const env = makeEnv(db);
    const createRes = await req("/v1/evals", { method: "POST", body: JSON.stringify({ name: "s1", space_id: "space-1", cases: [{ input: "2+2?", expected_output: "4" }] }) }, env);
    expect(createRes.status).toBe(201);
    const { id } = await createRes.json<{ id: string }>();

    const runRes = await req(`/v1/evals/${id}/run`, { method: "POST", body: JSON.stringify({}) }, env);
    expect(runRes.status).toBe(200);
    const body = await runRes.json<{ mode: string; avg_score: number; results: Array<{ score: number }> }>();
    expect(body.mode).toBe("text");
    expect(body.results[0]?.score).toBe(8);
    // text mode never touches AGENTS_WORKER — only the judge call goes out.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("eval worker — agent mode dispatches a REAL /agent/run per case", () => {
  it("requires session_id for mode=agent", async () => {
    const db = makeDb();
    const env = makeEnv(db);
    const createRes = await req("/v1/evals", { method: "POST", body: JSON.stringify({ name: "s2", space_id: "space-1", cases: [{ input: "task" }] }) }, env);
    const { id } = await createRes.json<{ id: string }>();

    const runRes = await req(`/v1/evals/${id}/run`, { method: "POST", body: JSON.stringify({ mode: "agent" }) }, env);
    expect(runRes.status).toBe(400);
  });

  it("dispatches to AGENTS_WORKER with Prefer: respond-sync + an internal token, then judges the real answer", async () => {
    const db = makeDb();
    let capturedRequest: Request | null = null;
    const agentsWorker = {
      async fetch(reqIn: Request) {
        capturedRequest = reqIn;
        return Response.json({ runId: "run-xyz", status: "completed", finalAnswer: "the real agent answer", final_answer: "the real agent answer" });
      },
    };
    const env = makeEnv(db, { agentsWorker });
    const createRes = await req("/v1/evals", { method: "POST", body: JSON.stringify({ name: "s3", space_id: "space-1", cases: [{ input: "do the task", expected_output: "expected thing" }] }) }, env);
    const { id } = await createRes.json<{ id: string }>();

    const runRes = await req(`/v1/evals/${id}/run`, { method: "POST", body: JSON.stringify({ mode: "agent", session_id: "sess-1" }) }, env);
    expect(runRes.status).toBe(200);
    const body = await runRes.json<{ mode: string; results: Array<{ score: number; agent_run_id: string | null }> }>();
    expect(body.mode).toBe("agent");
    expect(body.results[0]?.agent_run_id).toBe("run-xyz");
    expect(body.results[0]?.score).toBe(8);

    expect(capturedRequest).not.toBeNull();
    const captured = capturedRequest as unknown as Request;
    expect(captured.url).toContain("/spaces/space-1/sessions/sess-1/agent/run");
    expect(captured.headers.get("prefer")).toBe("respond-sync");
    expect(captured.headers.get("x-naelao-tenant-id")).toBe(TENANT);
    expect(captured.headers.get("x-naelao-internal-token")).toBeTruthy();
    const sentBody = await captured.json<{ goal: string }>();
    expect(sentBody.goal).toBe("do the task");
  });

  it("records a failed agent run as score 0 with agent_error, never fabricating a judged answer", async () => {
    const db = makeDb();
    const agentsWorker = { async fetch() { return Response.json({ status: "failed", error: "script execution failed" }); } };
    const env = makeEnv(db, { agentsWorker });
    const createRes = await req("/v1/evals", { method: "POST", body: JSON.stringify({ name: "s4", space_id: "space-1", cases: [{ input: "task" }] }) }, env);
    const { id } = await createRes.json<{ id: string }>();

    const runRes = await req(`/v1/evals/${id}/run`, { method: "POST", body: JSON.stringify({ mode: "agent", session_id: "sess-1" }) }, env);
    const body = await runRes.json<{ results: Array<{ score: number; agent_error?: string }> }>();
    expect(body.results[0]?.score).toBe(0);
    expect(body.results[0]?.agent_error).toBe("script execution failed");
    // A failed run must never reach the judge — nothing to judge.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes agent_definition_id through to the dispatched run when provided", async () => {
    const db = makeDb();
    let capturedRequest: Request | null = null;
    const agentsWorker = {
      async fetch(reqIn: Request) {
        capturedRequest = reqIn;
        return Response.json({ status: "completed", finalAnswer: "answer" });
      },
    };
    const env = makeEnv(db, { agentsWorker });
    const createRes = await req("/v1/evals", { method: "POST", body: JSON.stringify({ name: "s5", space_id: "space-1", cases: [{ input: "task" }] }) }, env);
    const { id } = await createRes.json<{ id: string }>();

    await req(`/v1/evals/${id}/run`, { method: "POST", body: JSON.stringify({ mode: "agent", session_id: "sess-1", agent_definition_id: "support-agent" }) }, env);
    const sentBody = await (capturedRequest as unknown as Request).json<{ agent_definition_id?: string }>();
    expect(sentBody.agent_definition_id).toBe("support-agent");
  });
});

describe("eval worker — judge scores semantic validity separately (anti-reward-hacking)", () => {
  it("takes the MIN of correctness and semantic_validity as the overall score", async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(makeJudgeResponse(10, 2, "keyword-stuffed but doesn't solve the task")), { status: 200 }));
    const db = makeDb();
    const env = makeEnv(db);
    const createRes = await req("/v1/evals", { method: "POST", body: JSON.stringify({ name: "s6", space_id: "space-1", cases: [{ input: "task", expected_output: "x" }] }) }, env);
    const { id } = await createRes.json<{ id: string }>();

    const runRes = await req(`/v1/evals/${id}/run`, { method: "POST", body: JSON.stringify({}) }, env);
    const body = await runRes.json<{ results: Array<{ score: number; correctness: number; semantic_validity: number }> }>();
    expect(body.results[0]?.correctness).toBe(10);
    expect(body.results[0]?.semantic_validity).toBe(2);
    expect(body.results[0]?.score).toBe(2);
  });
});

describe("eval worker — judge routes through the CF AI Gateway when configured", () => {
  it("calls the gateway URL with cf-aig-authorization when NAELAO_ACCOUNT_ID/GATEWAY_ID/AIG_TOKEN are set", async () => {
    const db = makeDb();
    const env = {
      ...makeEnv(db),
      EVAL_LLM_KEY: undefined,
      NAELAO_ACCOUNT_ID: "acct-1",
      NAELAO_GATEWAY_ID: "naelao-gateway",
      NAELAO_AIG_TOKEN: "aig-token-xyz",
    } as Env;
    const createRes = await req("/v1/evals", { method: "POST", body: JSON.stringify({ name: "s7", space_id: "space-1", cases: [{ input: "task" }] }) }, env);
    const { id } = await createRes.json<{ id: string }>();

    await req(`/v1/evals/${id}/run`, { method: "POST", body: JSON.stringify({}) }, env);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe("https://gateway.ai.cloudflare.com/v1/acct-1/naelao-gateway/anthropic/v1/messages");
    const headers = calledInit.headers as Record<string, string>;
    expect(headers["cf-aig-authorization"]).toBe("Bearer aig-token-xyz");
  });
});
