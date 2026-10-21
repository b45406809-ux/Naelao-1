import { describe, it, expect } from "vitest";
import { app } from "../../workers/agents/src/index.js";
import type { AgentsEnv } from "../../workers/agents/src/index.js";
import { mintInternalToken } from "@naelao/http";

// A-2: /agent/run now dispatches to the script-native engine (handleScriptRun via
// POST .../script/run) instead of the legacy ReAct loop (handleRun via POST .../run). This is
// the end-to-end proof that the real script-engine LoopResult shape
// ({level, result: {ok, output, tokens_used, ...}, notes}) gets normalized at the router
// boundary into the {finalAnswer, final_answer, status, reactSteps} shape every existing
// consumer (mention-run's parser, apps/shell/apps/portal, AgentTaskWorkflow) was written
// against — not just that the pure normalizeScriptRunResult function works in isolation.

const SECRET = "test-platform-secret";

function makePlatformDb(): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind: (..._args: unknown[]) => ({
          first: async () => {
            if (sql.includes("FROM spaces")) {
              return { id: "space-1", tenant_id: "tenant-a", status: "active", spacetype_id: "st-1" };
            }
            if (sql.includes("FROM spacetypes")) {
              return { id: "st-1", model_config: "{}", tools_config: "[]", system_prompt_template: null };
            }
            if (sql.includes("usage_events")) {
              return { total: 0 };
            }
            return null;
          },
        }),
      };
    },
  } as unknown as D1Database;
}

function makeAgentDoStub(scriptRunResponse: { status: number; body: unknown }) {
  const calls: Array<{ path: string; body: unknown }> = [];
  const agentDoStub = {
    async fetch(reqInput: Request) {
      const req = reqInput as Request;
      const path = new URL(req.url).pathname;
      const body = await req.json().catch(() => null);
      calls.push({ path, body });
      return new Response(JSON.stringify(scriptRunResponse.body), { status: scriptRunResponse.status });
    },
  };
  return { agentDoStub, calls };
}

function makeEnv(scriptRunResponse: { status: number; body: unknown }) {
  const { agentDoStub, calls } = makeAgentDoStub(scriptRunResponse);
  const env = {
    ANTHROPIC_API_KEY: "test-anthropic-key",
    PLATFORM_SECRET: SECRET,
    NAELAO_AGENT_DO: { idFromName: (name: string) => ({ toString: () => name }), get: () => agentDoStub },
    ANALYTICS: { writeDataPoint() {} },
    PLATFORM_DB: makePlatformDb(),
    SPACES_WORKER: {
      async fetch(reqInput: Request) {
        const url = new URL((reqInput as Request).url);
        if (/\/me\/injection$/.test(url.pathname)) return Response.json({ rate_limited: false });
        if (/\/sessions\/[^/]+\/compact-scope$/.test(url.pathname)) return Response.json({ project_id: null, private_scratchpad: false, owned_by_caller: true });
        return new Response("not found", { status: 404 });
      },
    },
    KNOWLEDGE_WORKER: { async fetch() { return new Response("not found", { status: 404 }); } },
  } as unknown as AgentsEnv;
  return { env, calls };
}

const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

async function runReq(env: AgentsEnv, goal: string) {
  const token = await mintInternalToken(SECRET, "tenant-a");
  return app.fetch(
    new Request("https://agents.naelao.com/spaces/space-1/sessions/sess-1/agent/run", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": "tenant-a",
        "x-naelao-internal-token": token,
        "prefer": "respond-sync",
      },
      body: JSON.stringify({ goal }),
    }),
    env,
    execCtx
  );
}

describe("POST /agent/run — A-2 dispatch to the script-native engine", () => {
  it("dispatches to .../script/run (not .../run), passing agentId defaulted to naelao-agent", async () => {
    const { env, calls } = makeEnv({ status: 200, body: { level: "L1", result: { ok: true, output: "hi", tokens_used: 10, input_tokens: 4, output_tokens: 6 }, notes: [] } });
    await runReq(env, "hello there");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("/script/run");
    expect((calls[0]!.body as { agentId?: string }).agentId).toBe("naelao-agent");
  });

  it("normalizes a successful LoopResult into {finalAnswer, final_answer, status: completed}", async () => {
    const { env } = makeEnv({ status: 200, body: { level: "L1", result: { ok: true, output: "The answer is 42.", tokens_used: 10, input_tokens: 4, output_tokens: 6 }, notes: ["did stuff"] } });
    const res = await runReq(env, "what is the answer?");
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; finalAnswer: string; final_answer: string; reactSteps: unknown[] };
    expect(body.status).toBe("completed");
    expect(body.finalAnswer).toBe("The answer is 42.");
    expect(body.final_answer).toBe("The answer is 42.");
    expect(Array.isArray(body.reactSteps)).toBe(true);
  });

  it("normalizes a script-level failure (result.ok === false) into status: failed with an error message", async () => {
    const { env } = makeEnv({ status: 200, body: { level: "L1", result: { ok: false, error: "script threw" }, notes: [] } });
    const res = await runReq(env, "do the broken thing");
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; finalAnswer: string | null; error?: string };
    expect(body.status).toBe("failed");
    expect(body.finalAnswer).toBeNull();
    expect(body.error).toBe("script threw");
  });

  it("passes through a gate refusal (e.g. 402 from enforceRunGates) unnormalized, with its own error_code intact", async () => {
    const { env } = makeEnv({ status: 402, body: { error_code: "insufficient_credits", balance_cents: 0 } });
    const res = await runReq(env, "spend some money");
    expect(res.status).toBe(402);
    const body = await res.json() as { error_code: string };
    expect(body.error_code).toBe("insufficient_credits");
  });

  it("passes agent_definition_id through as a bare agentId after stripping the spaceId: prefix", async () => {
    const { env, calls } = makeEnv({ status: 200, body: { level: "L1", result: { ok: true, output: "ok" }, notes: [] } });
    const token = await mintInternalToken(SECRET, "tenant-a");
    await app.fetch(
      new Request("https://agents.naelao.com/spaces/space-1/sessions/sess-1/agent/run", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-naelao-tenant-id": "tenant-a",
          "x-naelao-internal-token": token,
          "prefer": "respond-sync",
        },
        body: JSON.stringify({ goal: "hi", agent_definition_id: "space-1:launchpad-fulfillment-v1" }),
      }),
      env,
      execCtx
    );
    expect((calls[0]!.body as { agentId?: string }).agentId).toBe("launchpad-fulfillment-v1");
  });
});
