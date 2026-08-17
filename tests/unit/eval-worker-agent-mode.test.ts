import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createFakeD1 } from "../stubs/d1-sqlite.js";
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

// The REAL migration, not a hand-rolled shape. The previous version of this file used a fake DB
// that accepted any INSERT and remembered whatever columns were passed — which is precisely why
// the worker shipped writing `eval_results (eval_suite_id, results_json, avg_score, ...)`, columns
// that have never existed on that table, and 500'd on every single run against a real D1 while
// every test here passed. Same failure mode CLAUDE.md already documents for `config_schema` vs
// `schema_json`: a test double that diverges from the migration proves nothing.
const EVAL_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0014_eval.sql"), "utf8");
const EVAL_RUN_MODEL_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0068_eval_run_model.sql"), "utf8");

function makeDb() {
  return createFakeD1([EVAL_MIGRATION, EVAL_RUN_MODEL_MIGRATION]);
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
    // The judge now calls the AI REST API (api.cloudflare.com/.../ai/v1/chat/completions), which
    // needs a gateway + a CF API token — it no longer goes through the Anthropic-only
    // @naelao/llm-gateway path, which could never have worked on an account with no Anthropic
    // provider wired (see the worker's own comment).
    NAELAO_ACCOUNT_ID: "acct-1",
    NAELAO_GATEWAY_ID: "naelao-gateway",
    CF_API_TOKEN: "cf-token-test",
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
    if (url.includes("api.cloudflare.com") || url.includes("anthropic.com") || url.includes("gateway.ai.cloudflare.com")) {
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
    const createRes = await req("/evals", { method: "POST", body: JSON.stringify({ name: "s1", space_id: "space-1", cases: [{ input: "2+2?", expected_output: "4" }] }) }, env);
    expect(createRes.status).toBe(201);
    const { id } = await createRes.json<{ id: string }>();

    const runRes = await req(`/evals/${id}/run`, { method: "POST", body: JSON.stringify({}) }, env);
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
    const createRes = await req("/evals", { method: "POST", body: JSON.stringify({ name: "s2", space_id: "space-1", cases: [{ input: "task" }] }) }, env);
    const { id } = await createRes.json<{ id: string }>();

    const runRes = await req(`/evals/${id}/run`, { method: "POST", body: JSON.stringify({ mode: "agent" }) }, env);
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
    const createRes = await req("/evals", { method: "POST", body: JSON.stringify({ name: "s3", space_id: "space-1", cases: [{ input: "do the task", expected_output: "expected thing" }] }) }, env);
    const { id } = await createRes.json<{ id: string }>();

    const runRes = await req(`/evals/${id}/run`, { method: "POST", body: JSON.stringify({ mode: "agent", session_id: "sess-1" }) }, env);
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
    const createRes = await req("/evals", { method: "POST", body: JSON.stringify({ name: "s4", space_id: "space-1", cases: [{ input: "task" }] }) }, env);
    const { id } = await createRes.json<{ id: string }>();

    const runRes = await req(`/evals/${id}/run`, { method: "POST", body: JSON.stringify({ mode: "agent", session_id: "sess-1" }) }, env);
    const body = await runRes.json<{ results: Array<{ score: number; agent_error?: string }> }>();
    expect(body.results[0]?.score).toBe(0);
    expect(body.results[0]?.agent_error).toBe("script execution failed");
    // A failed run must never reach the judge — nothing to judge.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("records a dispatch that throws as THIS case's error, without failing the whole suite", async () => {
    // Reproduces a real live failure during the model matrix: the dispatch carries an
    // AbortSignal.timeout, and a model slow enough to trip it threw straight out of the per-case
    // loop. Nothing caught it, so the run returned an opaque HTTP 500 and every other case that
    // had already scored was discarded — one slow model read as "the harness is broken".
    const db = makeDb();
    let calls = 0;
    const agentsWorker = {
      async fetch() {
        calls++;
        if (calls === 1) {
          const err = new Error("The operation was aborted due to timeout");
          err.name = "TimeoutError";
          throw err;
        }
        return Response.json({ status: "completed", finalAnswer: "second case answer" });
      },
    };
    const env = makeEnv(db, { agentsWorker });
    const createRes = await req("/evals", {
      method: "POST",
      body: JSON.stringify({ name: "s4b", space_id: "space-1", cases: [{ input: "slow task" }, { input: "fast task" }] }),
    }, env);
    const { id } = await createRes.json<{ id: string }>();

    const runRes = await req(`/evals/${id}/run`, { method: "POST", body: JSON.stringify({ mode: "agent", session_id: "sess-1" }) }, env);
    // The whole point: the suite still completes.
    expect(runRes.status).toBe(200);
    const body = await runRes.json<{ results: Array<{ score: number; agent_error?: string }> }>();
    expect(body.results).toHaveLength(2);
    // The timeout is attributed to the case that caused it, and named as a timeout rather than
    // surfacing a bare "TimeoutError" that reads identically to a broken binding.
    expect(body.results[0]?.score).toBe(0);
    expect(body.results[0]?.agent_error).toMatch(/exceeded \d+ms/);
    // And the surviving case is still really scored, not collateral damage.
    expect(body.results[1]?.agent_error).toBeUndefined();
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
    const createRes = await req("/evals", { method: "POST", body: JSON.stringify({ name: "s5", space_id: "space-1", cases: [{ input: "task" }] }) }, env);
    const { id } = await createRes.json<{ id: string }>();

    await req(`/evals/${id}/run`, { method: "POST", body: JSON.stringify({ mode: "agent", session_id: "sess-1", agent_definition_id: "support-agent" }) }, env);
    const sentBody = await (capturedRequest as unknown as Request).json<{ agent_definition_id?: string }>();
    expect(sentBody.agent_definition_id).toBe("support-agent");
  });
});

describe("eval worker — judge scores semantic validity separately (anti-reward-hacking)", () => {
  it("takes the MIN of correctness and semantic_validity as the overall score", async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(makeJudgeResponse(10, 2, "keyword-stuffed but doesn't solve the task")), { status: 200 }));
    const db = makeDb();
    const env = makeEnv(db);
    const createRes = await req("/evals", { method: "POST", body: JSON.stringify({ name: "s6", space_id: "space-1", cases: [{ input: "task", expected_output: "x" }] }) }, env);
    const { id } = await createRes.json<{ id: string }>();

    const runRes = await req(`/evals/${id}/run`, { method: "POST", body: JSON.stringify({}) }, env);
    const body = await runRes.json<{ results: Array<{ score: number; correctness: number; semantic_validity: number }> }>();
    expect(body.results[0]?.correctness).toBe(10);
    expect(body.results[0]?.semantic_validity).toBe(2);
    expect(body.results[0]?.score).toBe(2);
  });
});

describe("eval worker — the judge runs on the AI REST API, not the Anthropic-only path", () => {
  it("posts to the AI REST API endpoint carrying the CF API token", async () => {
    const db = makeDb();
    const env = makeEnv(db);
    const createRes = await req("/evals", { method: "POST", body: JSON.stringify({ name: "s7", space_id: "space-1", cases: [{ input: "task" }] }) }, env);
    const { id } = await createRes.json<{ id: string }>();

    await req(`/evals/${id}/run`, { method: "POST", body: JSON.stringify({}) }, env);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    // The 2026-05-21 migration endpoint — the old gateway.ai.cloudflare.com Universal Endpoint
    // this test used to assert is gone, and on an account with no Anthropic provider the old
    // path could never have produced a verdict at all.
    expect(calledUrl).toBe("https://api.cloudflare.com/client/v4/accounts/acct-1/ai/v1/chat/completions");
    const headers = calledInit.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer cf-token-test");
    expect(headers["cf-aig-gateway-id"]).toBe("naelao-gateway");
  });

  it("runs the judge on EVAL_JUDGE_MODEL rather than a hardcoded Claude id", async () => {
    const db = makeDb();
    const env = { ...makeEnv(db), EVAL_JUDGE_MODEL: "@cf/openai/gpt-oss-120b" } as Env;
    const createRes = await req("/evals", { method: "POST", body: JSON.stringify({ name: "s8", space_id: "space-1", cases: [{ input: "task" }] }) }, env);
    const { id } = await createRes.json<{ id: string }>();

    const runRes = await req(`/evals/${id}/run`, { method: "POST", body: JSON.stringify({}) }, env);
    const body = await runRes.json<{ judge_model: string }>();
    expect(body.judge_model).toBe("@cf/openai/gpt-oss-120b");

    const [, calledInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(calledInit.body as string).model).toBe("@cf/openai/gpt-oss-120b");
  });

  it("parses a verdict a model wrapped in a markdown fence instead of discarding it", async () => {
    const db = makeDb();
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({
      result: { response: '```json\n{"correctness": 9, "semantic_validity": 8, "reason": "fine"}\n```' },
    }), { status: 200 }));
    const env = makeEnv(db);
    const createRes = await req("/evals", { method: "POST", body: JSON.stringify({ name: "s9", space_id: "space-1", cases: [{ input: "task" }] }) }, env);
    const { id } = await createRes.json<{ id: string }>();

    const runRes = await req(`/evals/${id}/run`, { method: "POST", body: JSON.stringify({}) }, env);
    const body = await runRes.json<{ avg_score: number; judge_errors: number }>();
    expect(body.avg_score).toBe(8);
    expect(body.judge_errors).toBe(0);
  });
});

describe("eval worker — a broken judge is reported as an instrument failure, never as a bad score", () => {
  it("excludes judge-errored cases from avg_score and counts them separately", async () => {
    const db = makeDb();
    let call = 0;
    fetchMock.mockImplementation(async () => {
      call++;
      // First case judges fine; second case the judge itself is unavailable.
      if (call === 1) return new Response(JSON.stringify(makeJudgeResponse(8, 8)), { status: 200 });
      return new Response("model not found", { status: 404 });
    });
    const env = makeEnv(db);
    const createRes = await req("/evals", { method: "POST", body: JSON.stringify({ name: "s10", space_id: "space-1", cases: [{ input: "a" }, { input: "b" }] }) }, env);
    const { id } = await createRes.json<{ id: string }>();

    const runRes = await req(`/evals/${id}/run`, { method: "POST", body: JSON.stringify({}) }, env);
    const body = await runRes.json<{ avg_score: number; scored_count: number; judge_errors: number; case_count: number }>();
    // Averaging the failed judge's 0 in would report 4 — a broken instrument reading as "the
    // model did badly", which is the single most misleading thing this tool could do.
    expect(body.avg_score).toBe(8);
    expect(body.scored_count).toBe(1);
    expect(body.judge_errors).toBe(1);
    expect(body.case_count).toBe(2);
  });

  it("still counts an AGENT failure against the model — that is a real failed case", async () => {
    const db = makeDb();
    const agentsWorker = { fetch: async () => new Response("boom", { status: 500 }) };
    const env = makeEnv(db, { agentsWorker });
    const createRes = await req("/evals", { method: "POST", body: JSON.stringify({ name: "s11", space_id: "space-1", cases: [{ input: "a" }] }) }, env);
    const { id } = await createRes.json<{ id: string }>();

    const runRes = await req(`/evals/${id}/run`, { method: "POST", body: JSON.stringify({ mode: "agent", session_id: "sess-1" }) }, env);
    const body = await runRes.json<{ avg_score: number; agent_errors: number; scored_count: number }>();
    expect(body.avg_score).toBe(0);
    expect(body.agent_errors).toBe(1);
    expect(body.scored_count).toBe(1);
  });
});

describe("eval worker — per-run model override (the model comparison matrix)", () => {
  it("passes the requested model through to /agent/run and reports it in the summary", async () => {
    const db = makeDb();
    const seen: Array<Record<string, unknown>> = [];
    const agentsWorker = {
      fetch: async (r: Request) => {
        seen.push(await r.json() as Record<string, unknown>);
        return new Response(JSON.stringify({ runId: "run-1", status: "completed", finalAnswer: "answer" }), { status: 200 });
      },
    };
    const env = makeEnv(db, { agentsWorker });
    const createRes = await req("/evals", { method: "POST", body: JSON.stringify({ name: "s12", space_id: "space-1", cases: [{ input: "a" }] }) }, env);
    const { id } = await createRes.json<{ id: string }>();

    const runRes = await req(`/evals/${id}/run`, { method: "POST", body: JSON.stringify({ mode: "agent", session_id: "sess-1", model: "@cf/qwen/qwen3-30b-a3b-fp8" }) }, env);
    const body = await runRes.json<{ model: string; avg_latency_ms: number | null }>();

    expect(seen[0]!["model"]).toBe("@cf/qwen/qwen3-30b-a3b-fp8");
    expect(body.model).toBe("@cf/qwen/qwen3-30b-a3b-fp8");
    expect(typeof body.avg_latency_ms).toBe("number");
  });

  it("omits `model` entirely when none is requested, so the space's own configured model wins", async () => {
    const db = makeDb();
    const seen: Array<Record<string, unknown>> = [];
    const agentsWorker = {
      fetch: async (r: Request) => {
        seen.push(await r.json() as Record<string, unknown>);
        return new Response(JSON.stringify({ runId: "run-1", status: "completed", finalAnswer: "answer" }), { status: 200 });
      },
    };
    const env = makeEnv(db, { agentsWorker });
    const createRes = await req("/evals", { method: "POST", body: JSON.stringify({ name: "s13", space_id: "space-1", cases: [{ input: "a" }] }) }, env);
    const { id } = await createRes.json<{ id: string }>();

    await req(`/evals/${id}/run`, { method: "POST", body: JSON.stringify({ mode: "agent", session_id: "sess-1" }) }, env);
    expect(seen[0]).not.toHaveProperty("model");
  });
});

describe("eval worker — persistence against the REAL eval schema", () => {
  it("writes an eval_runs row plus one eval_results row per case", async () => {
    const db = makeDb();
    const env = makeEnv(db);
    const createRes = await req("/evals", { method: "POST", body: JSON.stringify({ name: "s14", space_id: "space-1", cases: [{ input: "a" }, { input: "b" }] }) }, env);
    const { id } = await createRes.json<{ id: string }>();
    const runRes = await req(`/evals/${id}/run`, { method: "POST", body: JSON.stringify({}) }, env);
    const { run_id } = await runRes.json<{ run_id: string }>();

    const runs = db.db.prepare("SELECT * FROM eval_runs WHERE id = ?").all(run_id) as Array<Record<string, unknown>>;
    expect(runs).toHaveLength(1);
    expect(runs[0]!["total_cases"]).toBe(2);
    expect(runs[0]!["status"]).toBe("completed");

    const cases = db.db.prepare("SELECT * FROM eval_results WHERE run_id = ? ORDER BY case_index").all(run_id) as Array<Record<string, unknown>>;
    expect(cases).toHaveLength(2);
    expect(cases[0]!["input"]).toBe("a");
    expect(cases[1]!["input"]).toBe("b");
  });

  it("stores NULL score for a judge-failed case so SQL AVG() excludes it, matching the live summary", async () => {
    const db = makeDb();
    let call = 0;
    fetchMock.mockImplementation(async () => {
      call++;
      if (call === 1) return new Response(JSON.stringify(makeJudgeResponse(8, 8)), { status: 200 });
      return new Response("judge unavailable", { status: 503 });
    });
    const env = makeEnv(db);
    const createRes = await req("/evals", { method: "POST", body: JSON.stringify({ name: "s15", space_id: "space-1", cases: [{ input: "a" }, { input: "b" }] }) }, env);
    const { id } = await createRes.json<{ id: string }>();
    const runRes = await req(`/evals/${id}/run`, { method: "POST", body: JSON.stringify({}) }, env);
    const { run_id } = await runRes.json<{ run_id: string }>();

    const scores = (db.db.prepare("SELECT score FROM eval_results WHERE run_id = ? ORDER BY case_index").all(run_id) as Array<{ score: number | null }>).map((r) => r.score);
    expect(scores).toEqual([8, null]);
    // The stored aggregate must agree with what the run itself reported — 8, not 4.
    const [{ avg }] = db.db.prepare("SELECT AVG(score) AS avg FROM eval_results WHERE run_id = ?").all(run_id) as Array<{ avg: number }>;
    expect(avg).toBe(8);
  });

  it("records the run's model, so two runs of one suite are attributable", async () => {
    const db = makeDb();
    const agentsWorker = { fetch: async () => new Response(JSON.stringify({ runId: "r", status: "completed", finalAnswer: "x" }), { status: 200 }) };
    const env = makeEnv(db, { agentsWorker });
    const createRes = await req("/evals", { method: "POST", body: JSON.stringify({ name: "s16", space_id: "space-1", cases: [{ input: "a" }] }) }, env);
    const { id } = await createRes.json<{ id: string }>();

    await req(`/evals/${id}/run`, { method: "POST", body: JSON.stringify({ mode: "agent", session_id: "sess-1", model: "@cf/openai/gpt-oss-120b" }) }, env);
    await req(`/evals/${id}/run`, { method: "POST", body: JSON.stringify({ mode: "agent", session_id: "sess-1", model: "@cf/qwen/qwen3-30b-a3b-fp8" }) }, env);

    const models = (db.db.prepare("SELECT model FROM eval_runs WHERE suite_id = ? ORDER BY started_at").all(id) as Array<{ model: string }>).map((r) => r.model);
    expect(models).toEqual(["@cf/openai/gpt-oss-120b", "@cf/qwen/qwen3-30b-a3b-fp8"]);
  });

  it("GET /evals/:id/results reads back real runs with a computed avg_score", async () => {
    const db = makeDb();
    const env = makeEnv(db);
    const createRes = await req("/evals", { method: "POST", body: JSON.stringify({ name: "s17", space_id: "space-1", cases: [{ input: "a" }] }) }, env);
    const { id } = await createRes.json<{ id: string }>();
    await req(`/evals/${id}/run`, { method: "POST", body: JSON.stringify({}) }, env);

    const res = await req(`/evals/${id}/results`, { method: "GET" }, env);
    const body = await res.json<{ data: Array<{ avg_score: number; total_cases: number }> }>();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.avg_score).toBe(8);
    expect(body.data[0]!.total_cases).toBe(1);
  });
});
