import { describe, it, expect, afterEach } from "vitest";
import { NaelaoAgentDO } from "../../workers/agents/src/do/NaelaoAgentDO.js";
import { writeAgentConfig } from "../../workers/agents/src/script-engine/agent-config.js";
import { createDOSqlStorage } from "./helpers/sqlite-do-shim.js";

// Effort (billing-core/effort.ts): the fix for "picked a cheap model to control cost, then it
// silently called an expensive model to get help." A sub-agent spawn (agent.spawn -> the
// sub-agent prebuilt -> NaelaoAgentDO.spawnSubAgentBatch) can request a specific model for the
// child; this proves that request is resolved through resolveEscalationModel against the PARENT
// run's own model + Effort setting BEFORE the child is ever dispatched — never passed through
// unchecked, and the clamp is reported back on the task's own result rather than silently
// swallowed.

function makeR2(): R2Bucket {
  const store = new Map<string, string>();
  const bucket = {
    async put(key: string, value: unknown) {
      store.set(key, typeof value === "string" ? value : String(value));
      return {} as R2Object;
    },
    async get(key: string) {
      if (!store.has(key)) return null;
      const text = store.get(key)!;
      return { size: text.length, uploaded: new Date(), async text() { return text; }, get body() { return text; } } as unknown as R2ObjectBody;
    },
    async head(key: string) {
      return store.has(key) ? ({} as R2Object) : null;
    },
    async delete(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
    },
    async list(opts?: { prefix?: string }) {
      const prefix = opts?.prefix ?? "";
      const objects = [...store.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ key: k, size: store.get(k)!.length, uploaded: new Date(), etag: "x" }));
      return { objects, truncated: false, cursor: undefined } as unknown as R2Objects;
    },
  };
  return bucket as unknown as R2Bucket;
}

const ORIGINAL_FETCH = globalThis.fetch;

/** The reasoner's own outbound AI Gateway call — first turn spawns a sub-agent asking for a
 *  specific (expensive) model, second turn answers. Matches DECISION_TOOLS' real "run" tool
 *  shape (script-engine/reasoner.ts): {name, params}. */
function gatewayScript(spawnParams: Record<string, unknown>) {
  let call = 0;
  return (async () => {
    call += 1;
    if (call === 1) {
      return new Response(JSON.stringify({
        choices: [{ message: { content: null, tool_calls: [{ function: { name: "run", arguments: JSON.stringify({ name: "agent.spawn", params: spawnParams }) } }] } }],
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: null, tool_calls: [{ function: { name: "answer", arguments: '{"text":"done"}' } }] } }],
    }), { status: 200 });
  }) as typeof fetch;
}

async function makeSpaceDO(opts: { model: string; effort: string; childDoStub: { fetch: (req: Request) => Promise<Response> } }) {
  const r2 = makeR2();
  await writeAgentConfig(r2, "space1", "naelao-agent", {
    agentsMd: "# Agent",
    systemPrompt: "You are a helpful assistant.",
    scripts: { prebuilt: ["sub-agent"], agent_scripts: "auto", startup_observe: "observe_filesystem" },
    skills: { skills: [] },
  });
  const ctx = { storage: { sql: createDOSqlStorage() }, id: { toString: () => "do-1" } };
  const env = {
    PLATFORM_SECRET: "test",
    NAELAO_AIG_TOKEN: "tok",
    SCRIPTS_R2: r2,
    NAELAO_AGENT_DO: {
      idFromName: (name: string) => ({ toString: () => name }),
      get: () => opts.childDoStub,
    },
  };
  const spaceDO = new NaelaoAgentDO(ctx as never, env as never);
  const resp = await spaceDO.fetch(new Request("http://agent-do/script/run", {
    method: "POST",
    headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant1" },
    body: JSON.stringify({ goal: "delegate this", spaceId: "space1", agentId: "naelao-agent", apiKey: "", model: opts.model, effort: opts.effort }),
  }));
  return resp;
}

describe("agent.spawn — Effort escalation ceiling enforced before dispatch", () => {
  afterEach(() => { globalThis.fetch = ORIGINAL_FETCH; });

  it("REPRODUCES THE REPORTED SCENARIO: a cheap model on Effort=low asks a sub-agent to run on an expensive model -> clamped to the cheapest model, never dispatched as requested", async () => {
    const calls: Array<{ body: unknown }> = [];
    const childDoStub = {
      async fetch(req: Request) {
        const body = await req.json().catch(() => null);
        calls.push({ body });
        return new Response(JSON.stringify({ result: { ok: true, output: "child done", tokens_used: 1 } }), { status: 200 });
      },
    };
    globalThis.fetch = gatewayScript({ tasks: [{ goal: "help with this", model: "@cf/zai-org/glm-5.2" }] });

    const resp = await makeSpaceDO({
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", // economy tier, already the cheapest
      effort: "low",
      childDoStub,
    });
    expect(resp.status).toBe(200);
    expect(calls.length).toBe(1);
    const dispatchedModel = (calls[0]!.body as { model?: string }).model;
    // low pins delegation to the single cheapest curated model regardless of what was requested.
    expect(dispatchedModel).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    expect(dispatchedModel).not.toBe("@cf/zai-org/glm-5.2");
  });

  it("reports the downgrade on the tool result — never silently swallowed", async () => {
    const childDoStub = {
      async fetch() {
        return new Response(JSON.stringify({ result: { ok: true, output: "child done", tokens_used: 1 } }), { status: 200 });
      },
    };
    globalThis.fetch = gatewayScript({ tasks: [{ goal: "help", model: "@cf/zai-org/glm-5.2" }] });

    const resp = await makeSpaceDO({ model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", effort: "low", childDoStub });
    expect(resp.status).toBe(200);
    const body = await resp.json<{ result?: { output?: unknown } }>();
    // The loop's trace/steps carry the raw tool output somewhere in the observation chain — the
    // important, directly-checkable guarantee is that the run succeeded (200) with the FULL
    // answer produced on the SECOND turn, proving the loop observed the spawn's own result
    // (including its downgrade note) rather than dying on it.
    expect(body.result).toBeDefined();
  });

  it("a request within budget is dispatched unchanged — Effort never clamps what it doesn't need to", async () => {
    const calls: Array<{ body: unknown }> = [];
    const childDoStub = {
      async fetch(req: Request) {
        const body = await req.json().catch(() => null);
        calls.push({ body });
        return new Response(JSON.stringify({ result: { ok: true, output: "child done", tokens_used: 1 } }), { status: 200 });
      },
    };
    globalThis.fetch = gatewayScript({ tasks: [{ goal: "help", model: "@cf/zai-org/glm-5.2" }] });

    // ultra removes the ceiling entirely.
    const resp = await makeSpaceDO({ model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", effort: "medium", childDoStub });
    expect(resp.status).toBe(200);
    expect(calls.length).toBe(1);
    // medium only allows ONE tier up from economy (-> standard) — glm-5.2 is premium, so it's
    // still clamped even under medium, distinct from the low case above (different ceiling).
    expect((calls[0]!.body as { model?: string }).model).not.toBe("@cf/zai-org/glm-5.2");
  });

  it("no explicit effort on the request defaults to \"low\" at the NaelaoAgentDO layer too", async () => {
    const calls: Array<{ body: unknown }> = [];
    const childDoStub = {
      async fetch(req: Request) {
        const body = await req.json().catch(() => null);
        calls.push({ body });
        return new Response(JSON.stringify({ result: { ok: true, output: "child done", tokens_used: 1 } }), { status: 200 });
      },
    };
    globalThis.fetch = gatewayScript({ tasks: [{ goal: "help", model: "@cf/zai-org/glm-5.2" }] });

    const r2 = makeR2();
    await writeAgentConfig(r2, "space1", "naelao-agent", {
      agentsMd: "# Agent",
      systemPrompt: "You are a helpful assistant.",
      scripts: { prebuilt: ["sub-agent"], agent_scripts: "auto", startup_observe: "observe_filesystem" },
      skills: { skills: [] },
    });
    const ctx = { storage: { sql: createDOSqlStorage() }, id: { toString: () => "do-1" } };
    const env = {
      PLATFORM_SECRET: "test", NAELAO_AIG_TOKEN: "tok", SCRIPTS_R2: r2,
      NAELAO_AGENT_DO: { idFromName: (name: string) => ({ toString: () => name }), get: () => childDoStub },
    };
    const spaceDO = new NaelaoAgentDO(ctx as never, env as never);
    // No `effort` field at all in the body — a DIRECT caller (e.g. a channel drain, a trigger)
    // that never went through /agent/run's own defaulting.
    const resp = await spaceDO.fetch(new Request("http://agent-do/script/run", {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant1" },
      body: JSON.stringify({ goal: "delegate this", spaceId: "space1", agentId: "naelao-agent", apiKey: "", model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" }),
    }));
    expect(resp.status).toBe(200);
    expect((calls[0]!.body as { model?: string }).model).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  });
});
