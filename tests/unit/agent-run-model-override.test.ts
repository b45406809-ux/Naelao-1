// A per-run model override on /agent/run — the mechanism that makes a model-comparison matrix
// possible at all.
//
// Without it, scoring one golden dataset across candidate models means mutating the space's
// stored `productConfig.modelConfig.model` between runs: racy (concurrent runs would read each
// other's model), and a real write to a live product's configuration just to take a measurement.
//
// The override is validated against the SAME curated allowlist the builder's own PATCH route
// uses — now shared from packages/billing-core so the two can't drift. It is REJECTED, never
// silently ignored, on an unknown string: quietly running a different model than the caller named
// would make every number an eval produces a lie, which is worse than a failed run.

import { describe, it, expect } from "vitest";
import { app } from "../../workers/agents/src/index.js";
import type { AgentsEnv } from "../../workers/agents/src/index.js";
import { mintInternalToken } from "@naelao/http";
import { ALLOWED_MODELS, isAllowedModel, contextWindowForModel } from "../../packages/billing-core/src/index.js";

const SECRET = "test-platform-secret";

/** `config_json` for the space the run targets — this is where a builder's stored model choice
 *  lives (a productConfig override, not a manifest field). */
function makePlatformDb(configJson: string): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind: (..._args: unknown[]) => ({
          first: async () => {
            if (sql.includes("FROM spaces")) {
              return { id: "space-1", tenant_id: "tenant-a", status: "active", spacetype_id: "st-1", config_json: configJson };
            }
            if (sql.includes("usage_events")) return { total: 0 };
            return null;
          },
          all: async () => ({ results: [] }),
          run: async () => ({ meta: { changes: 1 } }),
        }),
      };
    },
  } as unknown as D1Database;
}

function makeEnv(configJson = "{}") {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const agentDoStub = {
    async fetch(reqInput: Request) {
      const req = reqInput as Request;
      calls.push({ path: new URL(req.url).pathname, body: (await req.json().catch(() => ({}))) as Record<string, unknown> });
      return new Response(JSON.stringify({ level: "L1", result: { ok: true, output: "ok", tokens_used: 5 }, notes: [] }), { status: 200 });
    },
  };
  const env = {
    ANTHROPIC_API_KEY: "k",
    PLATFORM_SECRET: SECRET,
    NAELAO_AGENT_DO: { idFromName: (n: string) => ({ toString: () => n }), get: () => agentDoStub },
    ANALYTICS: { writeDataPoint() {} },
    PLATFORM_DB: makePlatformDb(configJson),
    SPACES_WORKER: {
      async fetch(reqInput: Request) {
        const url = new URL((reqInput as Request).url);
        if (/\/me\/injection$/.test(url.pathname)) return Response.json({ rate_limited: false });
        return new Response("not found", { status: 404 });
      },
    },
    KNOWLEDGE_WORKER: { async fetch() { return new Response("not found", { status: 404 }); } },
  } as unknown as AgentsEnv;
  return { env, calls };
}

const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

async function runReq(env: AgentsEnv, body: Record<string, unknown>) {
  const token = await mintInternalToken(SECRET, "tenant-a");
  return app.fetch(
    new Request("https://agents.naelao.com/spaces/space-1/sessions/sess-1/agent/run", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": "tenant-a",
        "x-naelao-internal-token": token,
        prefer: "respond-sync",
      },
      body: JSON.stringify(body),
    }),
    env,
    execCtx
  );
}

describe("POST /agent/run — per-run model override", () => {
  it("uses the requested model over the space's stored one", async () => {
    const stored = JSON.stringify({ productConfig: { modelConfig: { model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" } } });
    const { env, calls } = makeEnv(stored);
    const res = await runReq(env, { goal: "hello", model: "@cf/qwen/qwen3-30b-a3b-fp8" });
    expect(res.status).toBe(200);
    expect(calls[0]!.body["model"]).toBe("@cf/qwen/qwen3-30b-a3b-fp8");
  });

  it("falls back to the space's stored model when none is requested", async () => {
    const stored = JSON.stringify({ productConfig: { modelConfig: { model: "@cf/openai/gpt-oss-120b" } } });
    const { env, calls } = makeEnv(stored);
    await runReq(env, { goal: "hello" });
    expect(calls[0]!.body["model"]).toBe("@cf/openai/gpt-oss-120b");
  });

  it("rejects a model outside the allowlist rather than silently substituting one", async () => {
    const { env, calls } = makeEnv();
    const res = await runReq(env, { goal: "hello", model: "gpt-4-turbo-definitely-not-ours" });
    expect(res.status).toBe(400);
    // Rejected BEFORE the agent DO is ever reached — no LLM spend on a request we can't honor.
    expect(calls).toHaveLength(0);
  });

  it("accepts every model on the shared allowlist", async () => {
    for (const model of ALLOWED_MODELS) {
      const { env, calls } = makeEnv();
      const res = await runReq(env, { goal: "hello", model });
      expect(res.status, `model ${model} should be accepted`).toBe(200);
      expect(calls[0]!.body["model"]).toBe(model);
    }
  });
});

describe("the shared model catalogue is internally consistent", () => {
  it("every allowlisted model has a real context window, not the silent default", () => {
    // A model on the allowlist with no window entry would fall back to 200k — wildly wrong for
    // e.g. Llama 3.3 at 24k, and it would corrupt both context accounting and the shell's meter.
    const DEFAULT = 200_000;
    const missing = ALLOWED_MODELS.filter((m) => !m.startsWith("claude-") && contextWindowForModel(m) === DEFAULT);
    expect(missing).toEqual([]);
  });

  it("isAllowedModel agrees with the list and rejects near-misses", () => {
    for (const m of ALLOWED_MODELS) expect(isAllowedModel(m)).toBe(true);
    // A plausible-looking typo must not pass — this guard is the only thing between an eval
    // request and an unpriceable model.
    expect(isAllowedModel("@cf/meta/llama-3.3-70b-instruct")).toBe(false);
    expect(isAllowedModel("")).toBe(false);
  });

  it("includes real Workers AI models, since Claude does not resolve on every account", () => {
    // CLAUDE.md item 68: this account's AI Gateway has zero Claude models. An allowlist that was
    // Claude-only would leave a builder here with nothing selectable that actually works.
    expect(ALLOWED_MODELS.filter((m) => m.startsWith("@cf/")).length).toBeGreaterThan(5);
  });
});

// Phase 2 item 13 — progressive tool disclosure's wire threading through the SYNCHRONOUS
// dispatch path. Mirrors the model-override tests above exactly: same request shape, same
// stored-config precedent (productConfig.modelConfig), same "explicit request wins" ordering.
describe("POST /agent/run — progressive tool disclosure threading", () => {
  it("defaults to false (byte-identical to every run before this feature existed)", async () => {
    const { env, calls } = makeEnv();
    await runReq(env, { goal: "hello" });
    expect(calls[0]!.body["progressiveToolDisclosure"]).toBe(false);
  });

  it("an explicit per-request override reaches the DO", async () => {
    const { env, calls } = makeEnv();
    await runReq(env, { goal: "hello", progressive_tool_disclosure: true });
    expect(calls[0]!.body["progressiveToolDisclosure"]).toBe(true);
  });

  it("falls back to the space's stored config when no override is sent", async () => {
    const stored = JSON.stringify({ productConfig: { modelConfig: { progressiveToolDisclosure: true } } });
    const { env, calls } = makeEnv(stored);
    await runReq(env, { goal: "hello" });
    expect(calls[0]!.body["progressiveToolDisclosure"]).toBe(true);
  });

  it("an explicit false override wins over a stored true", async () => {
    const stored = JSON.stringify({ productConfig: { modelConfig: { progressiveToolDisclosure: true } } });
    const { env, calls } = makeEnv(stored);
    await runReq(env, { goal: "hello", progressive_tool_disclosure: false });
    expect(calls[0]!.body["progressiveToolDisclosure"]).toBe(false);
  });
});
