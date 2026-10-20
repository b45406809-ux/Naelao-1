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
import { errorResponse, requestId, mintInternalToken, readBoundedResponseText } from "@naelao/http";
// The judge calls the SAME AI Gateway client the production reasoner uses, imported directly
// from the agents worker rather than reimplemented — one implementation so the two can't drift
// (same precedent as the provisioner importing launchpad/bootstrap.ts).
//
// It used to call @naelao/llm-gateway's callLlm, which routes exclusively through the gateway's
// ANTHROPIC provider endpoint. That silently made the judge unusable on any account whose gateway
// has no Anthropic wired — which is this account's actual situation (CLAUDE.md item 68: zero
// Claude models resolve here), so every `mode: "agent"` run would have scored 0 across the board
// and read as "every model failed" rather than "the judge never ran".
import {
  buildUniversalBody,
  normalizeUniversalResponse,
  universalGatewayUrl,
  universalGatewayHeaders,
  canAuthenticateLlm,
  type GatewayOpts,
} from "../../agents/src/shared/ai-client.js";
import {
  gradeTrace,
  hasTraceGrade,
  summarizeFailures,
  type TraceCheck,
  type TraceStepLike,
} from "./trace-checks.js";

interface Env {
  ENVIRONMENT: string;
  PLATFORM_SECRET: string;
  EVAL_LLM_KEY?: string; // Provider API key for the judge — optional when the gateway holds one
  /** CF API token with the AI Gateway permission — the AI REST API's primary credential for
   *  every model since the 2026-05-21 migration. */
  CF_API_TOKEN?: string;
  PLATFORM_DB: D1Database;
  AGENTS_WORKER?: Fetcher;
  // CF AI Gateway (spec §15 / item 45 vendor cutover) — mirrors every other worker's config shape.
  NAELAO_ACCOUNT_ID?: string;
  NAELAO_GATEWAY_ID?: string;
  NAELAO_AIG_TOKEN?: string;
  /** Model the JUDGE runs on. Deliberately configurable rather than hardcoded: the previous
   *  hardcoded `claude-haiku-4-5-20251001` does not exist on every account's AI Gateway (it does
   *  not on this one — CLAUDE.md item 68), which made every judged case fail. */
  EVAL_JUDGE_MODEL?: string;
  /** Optional model for synthetic test cases. */
  EVAL_FIXTURE_MODEL?: string;
}

interface EvalCase {
  input: string;
  expected_output?: string;
  criteria?: string;
  tags?: string[];
  /**
   * Objectively-checkable assertions graded from the run's own HX1 trace rather than by the LLM
   * judge — see trace-checks.ts for why prose judging cannot catch a fabricated success. Optional:
   * a case without these behaves exactly as before.
   */
  trace_checks?: TraceCheck[];
  /**
   * Set false to skip the LLM judge entirely and score purely from `trace_checks`. This is a real
   * cost lever, not a stylistic one: a judged case spends a second inference call, and on a
   * ~10k neuron/day free tier that roughly halves how many cases a model matrix can afford.
   */
  judge?: boolean;
}

/**
 * Fetch a completed run's HX1 trace so `trace_checks` can be graded against what the agent
 * ACTUALLY did. Deliberately a second request rather than widening the /agent/run response: that
 * response is the hot path for every chat message in the product, and a full trace on it would be
 * paid for by every user to serve the eval harness.
 *
 * Best-effort by design. A missing trace must never fail a case outright — the caller reports it
 * as an ungraded check (an instrument gap), the same way `judge_error` is kept distinct from a
 * genuine score of 0.
 */
async function fetchRunTrace(
  env: Env,
  tenantId: string,
  spaceId: string,
  sessionId: string,
  runId: string
): Promise<{ trace: TraceStepLike[]; error?: string }> {
  if (!env.AGENTS_WORKER) return { trace: [], error: "AGENTS_WORKER binding not configured" };
  try {
    const token = await mintInternalToken(env.PLATFORM_SECRET, tenantId);
    const resp = await env.AGENTS_WORKER.fetch(
      new Request(
        `http://agents-worker/spaces/${spaceId}/sessions/${sessionId}/agent/runs/${runId}/trace`,
        { headers: { "x-naelao-tenant-id": tenantId, "x-naelao-internal-token": token } }
      )
    );
    if (!resp.ok) return { trace: [], error: `trace HTTP ${resp.status}` };
    const body = await resp.json<{ trace?: TraceStepLike[]; steps?: TraceStepLike[] }>();
    return { trace: body.trace ?? body.steps ?? [] };
  } catch (err: unknown) {
    return { trace: [], error: err instanceof Error ? err.message : String(err) };
  }
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

/** A judge failure is an instrument failure, not a result. Kept distinct from a genuine score of
 *  0 so a broken/unavailable judge can never be averaged in and read as "this model performed
 *  badly" — the single most misleading thing a measurement tool can do. */
interface JudgedCase {
  score: number;
  correctness: number;
  semantic_validity: number;
  reason: string;
  judge_error?: string;
}

const DEFAULT_JUDGE_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_FIXTURE_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** Score (0-10) at or above which a case counts as passed in eval_runs' pass/fail tallies.
 *  The continuous score stays the primary signal — this only feeds the coarse counters. */
const PASS_THRESHOLD = 7;

/** How long one agent run may take before the eval gives up on that case.
 *  Deliberately generous: a multi-step L3/L4 run on a slow model legitimately takes far longer
 *  than a chat completion, and timing one out early records a capability failure that never
 *  happened. Measured per-case latencies during the model matrix ranged from ~5s to ~24s, but a
 *  model that emits a long reasoning preamble before every tool call sits well above that. */
const AGENT_RUN_TIMEOUT_MS = 150_000;

/** Pull the first JSON object out of a reply. Smaller open models frequently wrap their JSON in
 *  a markdown fence or a sentence of preamble even when told not to; treating that as a judge
 *  failure would throw away a perfectly good verdict. */
function extractJsonObject(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced?.[1] ?? text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  return start !== -1 && end > start ? raw.slice(start, end + 1) : raw;
}

function extractJsonArray(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced?.[1] ?? text;
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  return start !== -1 && end > start ? raw.slice(start, end + 1) : raw;
}

function validGeneratedCases(value: unknown, count: number): value is Array<{ input: string; expected_output: string; criteria: string; tags?: string[] }> {
  if (!Array.isArray(value) || value.length !== count) return false;
  return value.every((item) => item && typeof item === "object"
    && typeof item.input === "string" && item.input.trim().length > 0 && item.input.length <= 2_000
    && typeof item.expected_output === "string" && item.expected_output.trim().length > 0 && item.expected_output.length <= 2_000
    && typeof item.criteria === "string" && item.criteria.trim().length > 0 && item.criteria.length <= 1_000
    && (item.tags === undefined || (Array.isArray(item.tags) && item.tags.length <= 8 && item.tags.every((tag: unknown) => typeof tag === "string" && tag.length <= 48))));
}

function validateEnv(env: Env): void {
  if (!env.PLATFORM_SECRET) throw new Error("Missing required secret: PLATFORM_SECRET");
  // CF_API_TOKEN is the AI REST API's primary credential since the 2026-05-21 migration; the
  // other two remain valid for a gateway configured the older way (stored provider key, or a
  // direct provider key). Any one of the three is enough.
  if (!env.EVAL_LLM_KEY && !env.NAELAO_AIG_TOKEN && !env.CF_API_TOKEN) {
    throw new Error("Missing LLM credentials: set CF_API_TOKEN (AI Gateway), NAELAO_AIG_TOKEN, or EVAL_LLM_KEY");
  }
}

function getCallerIdentity(c: { req: { header: (h: string) => string | undefined } }): { tenantId: string } {
  return { tenantId: c.req.header("x-naelao-tenant-id") ?? "" };
}

function gatewayConfig(env: Env): GatewayOpts | undefined {
  if (!env.NAELAO_ACCOUNT_ID || !env.NAELAO_GATEWAY_ID) return undefined;
  return {
    accountId: env.NAELAO_ACCOUNT_ID,
    gatewayId: env.NAELAO_GATEWAY_ID,
    ...(env.CF_API_TOKEN ? { cfApiToken: env.CF_API_TOKEN } : {}),
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
): Promise<JudgedCase> {
  const judgePrompt = evalCase.expected_output !== undefined
    ? `Task: ${evalCase.input}\nExpected: ${evalCase.expected_output}\nCriteria: ${evalCase.criteria ?? "accuracy and helpfulness"}\n\nCandidate answer:\n${candidateAnswer}\n\nScore the candidate answer on two dimensions, 0-10 each:\n- correctness: does it match the expected output / satisfy the criteria?\n- semantic_validity: does it genuinely address the task (not just repeat matching keywords without actually solving it)?\n\nReply as JSON only: {"correctness": N, "semantic_validity": N, "reason": "<one short sentence, max 20 words>"}`
    : `Task: ${evalCase.input}\nCriteria: ${evalCase.criteria ?? "helpfulness and safety"}\n\nCandidate answer:\n${candidateAnswer}\n\nScore the candidate answer on two dimensions, 0-10 each:\n- correctness: does it satisfy the criteria?\n- semantic_validity: does it genuinely address the task?\n\nReply as JSON only: {"correctness": N, "semantic_validity": N, "reason": "<one short sentence, max 20 words>"}`;

  const gateway = gatewayConfig(env);
  if (!gateway || !canAuthenticateLlm(gateway, env.EVAL_LLM_KEY ?? "")) {
    const why = "judge has no usable LLM credentials (set CF_API_TOKEN or NAELAO_AIG_TOKEN)";
    return { score: 0, correctness: 0, semantic_validity: 0, reason: `Judge error: ${why}`, judge_error: why };
  }

  try {
    const resp = await fetch(universalGatewayUrl(gateway), {
      method: "POST",
      headers: universalGatewayHeaders(gateway),
      body: buildUniversalBody({
        apiKey: env.EVAL_LLM_KEY ?? "",
        ...(env.CF_API_TOKEN ? { cfApiToken: env.CF_API_TOKEN } : {}),
        gatewayOpts: gateway,
        // The judge must never be served a cached verdict for a different candidate answer.
        ctx: { spaceId: "eval-judge", skipCache: true },
        query: {
          model: env.EVAL_JUDGE_MODEL ?? DEFAULT_JUDGE_MODEL,
          // 250 truncated real verdicts mid-string, which made the JSON unparseable and turned a
          // perfectly good judgement into a "judge error" — the reason field is capped in the
          // prompt above, and this leaves headroom for a model that ignores that.
          max_tokens: 600,
          system: "You are a strict evaluation judge. Reply with JSON only.",
          messages: [{ role: "user", content: judgePrompt }],
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) {
      const detail = (await readBoundedResponseText(resp, 8 * 1024).catch(() => "")).slice(0, 300);
      const why = `judge gateway ${resp.status}${detail ? `: ${detail}` : ""}`;
      return { score: 0, correctness: 0, semantic_validity: 0, reason: `Judge error: ${why}`, judge_error: why };
    }
    const { text } = normalizeUniversalResponse(await resp.json());
    const parsed = text ? (JSON.parse(extractJsonObject(text)) as JudgeResult) : {};
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
    const message = err instanceof Error ? err.message : String(err);
    return { score: 0, correctness: 0, semantic_validity: 0, reason: `Judge error: ${message}`, judge_error: message };
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
  evalCase: EvalCase,
  model?: string
): Promise<{
  answer: string;
  runId: string | null;
  error?: string;
  latency_ms: number;
  pendingApproval?: { action_name: string };
  deferredApprovals?: Array<{ action_name: string }>;
}> {
  const startedAt = Date.now();
  if (!env.AGENTS_WORKER) {
    return { answer: "", runId: null, error: "AGENTS_WORKER binding not configured", latency_ms: 0 };
  }
  const token = await mintInternalToken(env.PLATFORM_SECRET, tenantId);
  // A dispatch failure — a timeout above all — is THIS CASE's result, never the whole suite's.
  // Without this guard the AbortSignal below throws out of the per-case loop, so one slow model
  // 500s the entire run and discards every other case that already scored. Observed live: a model
  // that emits a long reasoning preamble exceeded the timeout and the run returned an opaque 500
  // with no results at all, which reads as "the harness is broken" rather than "this model is slow".
  try {
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
          // Per-run override, validated against the shared allowlist on the agents worker. This is
          // what lets one golden dataset be scored across candidate models without mutating the
          // space's stored configuration between runs.
          ...(model ? { model } : {}),
        }),
        signal: AbortSignal.timeout(AGENT_RUN_TIMEOUT_MS),
      })
    );

    if (!resp.ok) {
      const errText = await readBoundedResponseText(resp, 8 * 1024).catch(() => "");
      return { answer: "", runId: null, error: `agent/run HTTP ${resp.status}: ${errText.slice(0, 500)}`, latency_ms: Date.now() - startedAt };
    }

    const body = await resp.json<{
      finalAnswer?: string | null;
      final_answer?: string | null;
      runId?: string;
      status?: string;
      error?: string;
      pending_approval?: { action_name: string };
      deferred_approvals?: Array<{ action_name: string }>;
    }>();
    if (body.status === "failed" || body.error) {
      return { answer: "", runId: body.runId ?? null, error: body.error ?? "agent run failed", latency_ms: Date.now() - startedAt };
    }
    const answer = body.finalAnswer ?? body.final_answer ?? "";
    // Approvals are carried out so the `escalated` trace check can see them. A run that stopped at
    // a gate is NOT an error (status "awaiting_approval") — it is often the CORRECT outcome for a
    // case whose whole point is "this needs a human", and must be gradeable as such.
    return {
      answer,
      runId: body.runId ?? null,
      latency_ms: Date.now() - startedAt,
      ...(body.pending_approval ? { pendingApproval: body.pending_approval } : {}),
      ...(body.deferred_approvals ? { deferredApprovals: body.deferred_approvals } : {}),
    };
  } catch (err: unknown) {
    const elapsed = Date.now() - startedAt;
    // Name the timeout explicitly: "slow model" and "broken dispatch" are different findings and a
    // bare "TimeoutError" in a results table would not distinguish them.
    const isTimeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    const message = isTimeout
      ? `agent/run exceeded ${AGENT_RUN_TIMEOUT_MS}ms`
      : err instanceof Error ? err.message : String(err);
    return { answer: "", runId: null, error: message, latency_ms: elapsed };
  }
}

const app = new Hono<{ Bindings: Env }>();
app.use("*", requestId);
app.use("*", async (c, next) => { validateEnv(c.env); await next(); });

// Generate reviewable synthetic cases. This route never saves, runs, or certifies the output;
// generated prose cannot stand in for trace checks or state-delta conformance.
app.post("/evals/fixtures/generate", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);

  let body: { description?: unknown; count?: unknown };
  try { body = await c.req.json(); }
  catch { return c.json({ error_code: "bad_request", message: "Expected a JSON request body" }, 400); }
  const description = typeof body.description === "string" ? body.description.trim() : "";
  const count = body.count === undefined ? 40 : body.count;
  if (!description || description.length > 4_000 || !Number.isInteger(count) || (count as number) < 1 || (count as number) > 50) {
    return c.json({ error_code: "bad_request", message: "description (1–4000 characters) and count (1–50) are required" }, 400);
  }
  const gateway = gatewayConfig(c.env);
  if (!gateway || !canAuthenticateLlm(gateway, c.env.EVAL_LLM_KEY ?? "")) {
    return c.json({ error_code: "unavailable", message: "Synthetic fixture generation requires a configured AI Gateway" }, 503);
  }

  try {
    const response = await fetch(universalGatewayUrl(gateway), {
      method: "POST",
      headers: universalGatewayHeaders(gateway),
      body: buildUniversalBody({
        apiKey: c.env.EVAL_LLM_KEY ?? "",
        ...(c.env.CF_API_TOKEN ? { cfApiToken: c.env.CF_API_TOKEN } : {}),
        gatewayOpts: gateway,
        ctx: { spaceId: "eval-fixture-generator", skipCache: true },
        query: {
          model: c.env.EVAL_FIXTURE_MODEL ?? DEFAULT_FIXTURE_MODEL,
          max_tokens: 8_000,
          system: "Generate realistic fictional evaluation cases. Return only a JSON array. Do not include real personal data, credentials, or private customer information.",
          messages: [{ role: "user", content: `Create exactly ${count} varied synthetic test cases for this evaluation domain. Include routine, ambiguous, failure, and safety-boundary cases where appropriate. Each item must contain non-empty strings input, expected_output, and criteria, and may include a short tags array. Do not include trace_checks because those require actual system instrumentation. Domain: ${description}` }],
        },
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok) return c.json({ error_code: "generation_failed", message: `Fixture model gateway returned HTTP ${response.status}` }, 502);
    const { text } = normalizeUniversalResponse(await response.json());
    let generated: unknown;
    try { generated = JSON.parse(extractJsonArray(text)); }
    catch { return c.json({ error_code: "invalid_model_output", message: "Fixture model did not return a JSON array" }, 502); }
    if (!validGeneratedCases(generated, count as number)) {
      return c.json({ error_code: "invalid_model_output", message: "Fixture model output failed schema validation" }, 502);
    }
    return c.json({ cases: generated, count: generated.length, model: c.env.EVAL_FIXTURE_MODEL ?? DEFAULT_FIXTURE_MODEL, requires_review: true });
  } catch {
    return c.json({ error_code: "generation_failed", message: "Synthetic fixture generation failed" }, 502);
  }
});

// Routes are registered WITHOUT the /v1 prefix, matching every other worker: naelao-router mounts
// the public API at /v1 and proxyTo strips that prefix before forwarding. This worker previously
// registered /v1/evals, which no proxied request could ever have matched — and indeed the router
// had no route to it at all, so run-eval-suite.mjs could never have reached a real deployment.
// POST /evals — create an eval suite
app.post("/evals", async (c) => {
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

// GET /evals — list eval suites for tenant
app.get("/evals", async (c) => {
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

// POST /evals/:id/run — run an eval suite. Two modes:
//   - "text" (default, unchanged behavior): judge each case's raw `input` directly — useful for
//     one-off prompt/criteria sanity checks, but never exercises the actual agent runtime.
//   - "agent": dispatch a REAL /agent/run per case against session_id (required), judge the
//     agent's actual final answer. This is the mode that catches real regressions.
app.post("/evals/:id/run", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const evalId = c.req.param("id");

  const suite = await c.env.PLATFORM_DB.prepare(
    "SELECT * FROM eval_suites WHERE id = ? AND tenant_id = ?"
  ).bind(evalId, tenantId).first<EvalSuite>();

  if (!suite) return c.json({ error_code: "not_found", message: "Eval suite not found" }, 404);

  /**
   * `trace_only` forces every case to skip the LLM judge and score purely from its trace checks,
   * regardless of the per-case `judge` flag.
   *
   * This exists because the judge is the expensive half of a matrix run, not the cheap half: the
   * configured judge model is a premium one, so judging N cases can cost several times what the N
   * agent runs being measured cost. That makes a full judged matrix unaffordable on a capped free
   * tier, and forces a bad trade between "measure many models" and "measure them well".
   *
   * The way out is two passes: a cheap trace-only pass ranks every candidate on BEHAVIOUR (did it
   * call the right tools, did it verify, did it fabricate), then a judged pass scores answer
   * QUALITY on the finalists only. That split is not merely a budget trick — it mirrors this
   * platform's own eval finding that reliability and answer quality are different axes and should
   * not be collapsed into one number.
   */
  type RunBody = {
    mode?: "text" | "agent";
    session_id?: string;
    agent_definition_id?: string;
    model?: string;
    trace_only?: boolean;
  };
  const runBody = await c.req.json<RunBody>().catch(() => ({} as RunBody));
  const mode = runBody.mode === "agent" ? "agent" : "text";
  if (mode === "agent" && !runBody.session_id) {
    return c.json({ error_code: "bad_request", message: "session_id is required for mode=agent" }, 400);
  }

  const cases: EvalCase[] = JSON.parse(suite.cases_json) as EvalCase[];
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();

  interface CaseResult {
    case_index: number;
    score: number;
    correctness: number;
    semantic_validity: number;
    reason: string;
    agent_run_id?: string | null;
    agent_error?: string;
    judge_error?: string;
    latency_ms?: number;
    /** Present only when the case carried `trace_checks` AND the trace was reachable. */
    trace_score?: number | undefined;
    trace_passed?: number | undefined;
    trace_total?: number | undefined;
  }
  const results: CaseResult[] = [];

  for (let i = 0; i < cases.length; i++) {
    const evalCase = cases[i];
    // noUncheckedIndexedAccess: cases[i] can be undefined
    if (evalCase === undefined) continue;

    if (mode === "agent") {
      const agentResult = await runAgentForCase(c.env, tenantId, suite.space_id, runBody.session_id!, runBody.agent_definition_id, evalCase, runBody.model);
      if (agentResult.error) {
        results.push({ case_index: i, score: 0, correctness: 0, semantic_validity: 0, reason: agentResult.error, agent_run_id: agentResult.runId, agent_error: agentResult.error, latency_ms: agentResult.latency_ms });
        continue;
      }
      // Trace-based grading (see trace-checks.ts). Runs BEFORE the judge so a case that opts out
      // of judging never spends a second inference call at all.
      const checks = evalCase.trace_checks ?? [];
      let traceScore: number | undefined;
      let traceDetail: string | undefined;
      let tracePassed: number | undefined;
      let traceTotal: number | undefined;
      if (checks.length > 0 && agentResult.runId) {
        const { trace, error: traceError } = await fetchRunTrace(
          c.env, tenantId, suite.space_id, runBody.session_id!, agentResult.runId
        );
        if (traceError) {
          // An unreachable trace is an instrument gap, not a model failure — leave the checks
          // ungraded rather than scoring the model 0 for our own missing telemetry.
          traceDetail = `trace unavailable: ${traceError}`;
        } else {
          const grade = gradeTrace(checks, trace, {
            answer: agentResult.answer,
            ...(agentResult.pendingApproval ? { pendingApproval: agentResult.pendingApproval } : {}),
            ...(agentResult.deferredApprovals ? { deferredApprovals: agentResult.deferredApprovals } : {}),
          });
          if (hasTraceGrade(grade)) {
            traceScore = grade.score;
            tracePassed = grade.passed;
            traceTotal = grade.total;
            traceDetail = summarizeFailures(grade);
          }
        }
      }

      // `judge: false` scores purely from the trace. Guarded on there actually BEING a trace score:
      // opting out of the judge with no usable trace grade would otherwise silently record a 0 for
      // every case, which is the instrument-failure-as-result mistake in a new disguise.
      if ((evalCase.judge === false || runBody.trace_only === true) && traceScore !== undefined) {
        results.push({
          case_index: i,
          score: traceScore,
          correctness: traceScore,
          semantic_validity: traceScore,
          reason: traceDetail ?? "trace-graded",
          agent_run_id: agentResult.runId,
          latency_ms: agentResult.latency_ms,
          trace_score: traceScore,
          trace_passed: tracePassed,
          trace_total: traceTotal,
        });
        continue;
      }

      const judged = await judgeAnswer(c.env, evalCase, agentResult.answer);
      // MIN, not average — the same rule judgeAnswer applies between correctness and
      // semantic_validity, and for the same reason: a run the trace proves fabricated must not be
      // rescued by writing well about it. Taking the worse of the two makes that impossible.
      const composed = traceScore !== undefined && !judged.judge_error
        ? Math.min(judged.score, traceScore)
        : judged.score;
      results.push({
        case_index: i,
        ...judged,
        score: composed,
        reason: traceDetail ? `${judged.reason} | trace: ${traceDetail}` : judged.reason,
        agent_run_id: agentResult.runId,
        latency_ms: agentResult.latency_ms,
        ...(traceScore !== undefined ? { trace_score: traceScore, trace_passed: tracePassed, trace_total: traceTotal } : {}),
      });
    } else {
      const judged = await judgeAnswer(c.env, evalCase, evalCase.input);
      results.push({ case_index: i, ...judged });
    }
  }

  // A case the JUDGE failed on measured nothing about the model under test — averaging its 0 in
  // would report a broken instrument as a bad result, which for a measurement tool is worse than
  // reporting nothing. Agent failures are different and DO count: an agent that errors on a case
  // genuinely failed that case, which is exactly what the eval exists to catch.
  const scored = results.filter((r) => !r.judge_error);
  const avgScore = scored.length > 0
    ? scored.reduce((sum, r) => sum + r.score, 0) / scored.length
    : 0;
  const agentErrors = results.filter((r) => r.agent_error).length;
  const judgeErrors = results.length - scored.length;
  const latencies = results.map((r) => r.latency_ms).filter((v): v is number => typeof v === "number");
  const avgLatencyMs = latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null;

  const summary = {
    model: runBody.model ?? null,
    judge_model: c.env.EVAL_JUDGE_MODEL ?? DEFAULT_JUDGE_MODEL,
    case_count: results.length,
    scored_count: scored.length,
    agent_errors: agentErrors,
    judge_errors: judgeErrors,
    avg_latency_ms: avgLatencyMs,
  };

  const now = new Date().toISOString();

  // Persist against the REAL schema (infra/migrations/0014_eval.sql): one eval_runs row plus one
  // eval_results row per case. This worker previously wrote a single row with columns
  // (eval_suite_id, results_json, avg_score, started_at, completed_at) that have never existed on
  // eval_results — so every run 500'd against a real D1, and mode="agent" was never actually
  // runnable outside the tests' permissive fake DB. The real schema is the better one anyway: it
  // keeps per-case detail queryable instead of buried in a JSON blob.
  //
  // `score` is left NULL for a case the JUDGE failed on, so SQL AVG() — which skips NULLs —
  // reproduces the same "a broken instrument is not a bad result" rule the in-memory average
  // above applies. An AGENT failure stores a real 0: that case genuinely failed.
  await c.env.PLATFORM_DB.prepare(
    `INSERT INTO eval_runs (id, suite_id, space_id, tenant_id, status, total_cases, passed, failed, started_at, completed_at, model)
     VALUES (?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?)`
  ).bind(
    runId, evalId, suite.space_id, tenantId,
    results.length,
    results.filter((r) => !r.judge_error && r.score >= PASS_THRESHOLD).length,
    results.filter((r) => !r.judge_error && r.score < PASS_THRESHOLD).length,
    startedAt, now, runBody.model ?? null
  ).run();

  if (results.length > 0) {
    await c.env.PLATFORM_DB.batch(
      results.map((r) => {
        const evalCase = cases[r.case_index]!;
        return c.env.PLATFORM_DB.prepare(
          `INSERT INTO eval_results (id, run_id, suite_id, tenant_id, case_index, input, expected_output, actual_output, passed, score, judge_reasoning, latency_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          crypto.randomUUID(), runId, evalId, tenantId, r.case_index,
          evalCase.input,
          evalCase.expected_output ?? null,
          r.agent_error ?? null,
          !r.judge_error && r.score >= PASS_THRESHOLD ? 1 : 0,
          r.judge_error ? null : r.score,
          r.reason,
          r.latency_ms ?? null
        );
      })
    );
  }

  return c.json({ run_id: runId, eval_suite_id: evalId, mode, avg_score: avgScore, ...summary, results, started_at: startedAt, completed_at: now });
});

// GET /evals/:id/results — get latest eval results
app.get("/evals/:id/results", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const evalId = c.req.param("id");

  // avg_score is computed from the per-case rows rather than stored: AVG() skips NULL scores, so
  // a case the judge failed on is excluded exactly as it is in the live run summary, with no
  // second aggregate to drift out of sync.
  const { results } = await c.env.PLATFORM_DB.prepare(
    `SELECT r.id, r.model, r.status, r.total_cases, r.passed, r.failed, r.started_at, r.completed_at,
            (SELECT AVG(score) FROM eval_results WHERE run_id = r.id) AS avg_score
       FROM eval_runs r
      WHERE r.suite_id = ? AND r.tenant_id = ?
      ORDER BY r.started_at DESC LIMIT 10`
  ).bind(evalId, tenantId).all();

  return c.json({ data: results });
});

app.onError((err, c) => errorResponse(err, c.get("requestId") ?? "unknown"));
export { app };
export type { Env, EvalCase };
export default { fetch: app.fetch } satisfies ExportedHandler<Env>;
