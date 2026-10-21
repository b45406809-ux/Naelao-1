import { describe, it, expect } from "vitest";
import { NaelaoAgentDO } from "../../workers/agents/src/do/NaelaoAgentDO.js";
import { writeAgentConfig } from "../../workers/agents/src/script-engine/agent-config.js";
import { createDOSqlStorage } from "./helpers/sqlite-do-shim.js";

// F14: the customer-bot daily spend cap was enforced in the channel-heartbeat drain path
// (handleChannelHeartbeat) but NOT in handleScriptRun — a direct POST /script/run carrying the
// same projectId bypassed the cap entirely. This proves the gate now applies to that path too,
// without needing a working LLM/reasoner: a project already over its cap must be rejected with
// 429 before runScriptLoop (and therefore any reasoner call) ever runs.
//
// F9 follow-up: the gate itself was moved off this DO's own local `project_spend` table (which
// undercounts spend once more than one agent DO instance serves the same project — every
// thread is its own DO) and onto a SpaceDO-backed `/spend` endpoint, the single writer for the
// whole project. The mock SPACES_WORKER below now simulates that endpoint with real
// stateful accumulation so these tests exercise the real gate, not the old local shortcut.

function makeR2(): R2Bucket {
  const store = new Map<string, string>();
  const bucket = {
    async put(key: string, value: unknown) {
      const text = typeof value === "string" ? value
        : value instanceof ArrayBuffer ? new TextDecoder().decode(value)
        : ArrayBuffer.isView(value) ? new TextDecoder().decode(value as Uint8Array)
        : String(value);
      store.set(key, text);
      return {} as R2Object;
    },
    async get(key: string) {
      if (!store.has(key)) return null;
      const text = store.get(key)!;
      return { size: new TextEncoder().encode(text).byteLength, uploaded: new Date(), async text() { return text; }, async arrayBuffer() { return new TextEncoder().encode(text).buffer; }, get body() { return text; } } as unknown as R2ObjectBody;
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

// Stateful mock of the two SpaceDO-backed routes NaelaoAgentDO calls for spend enforcement:
// GET/PATCH-adjacent `/projects/:id` (static config) and POST `/projects/:id/spend` (real
// accumulation, mirroring SpaceDO.debitProjectSpend's credits-add + capped-flag response).
function makeSpacesWorker(project: { execution_ceiling: number; daily_spend_cap_credits: number }) {
  const spend = new Map<string, number>(); // projectId -> credits spent "today"
  const fetcher = {
    async fetch(input: RequestInfo) {
      const req = input as Request;
      const url = new URL(typeof input === "string" ? input : req.url);
      const spendMatch = url.pathname.match(/^\/spaces\/[^/]+\/projects\/([^/]+)\/spend$/);
      if (spendMatch?.[1]) {
        const projectId = spendMatch[1];
        const body = await req.json<{ credits?: number }>().catch(() => ({}) as Record<string, never>);
        const credits = typeof body.credits === "number" && body.credits > 0 ? body.credits : 0;
        const spentToday = (spend.get(projectId) ?? 0) + credits;
        spend.set(projectId, spentToday);
        const cap = project.daily_spend_cap_credits;
        return Response.json({ project_id: projectId, day: "test-day", spent_today: spentToday, cap, capped: cap > 0 && spentToday >= cap });
      }
      if (/^\/spaces\/[^/]+\/projects\/[^/]+$/.test(url.pathname)) {
        return Response.json(project);
      }
      if (/^\/internal\/spaces\/[^/]+\/model-policy$/.test(url.pathname)) return Response.json({ policy: null });
      if (url.pathname === "/internal/pricing-catalog") return Response.json({ external_revenue_cut: { enabled: false } });
      if (url.pathname === "/internal/business-subscription-status") return Response.json({ gated: false, active: true, reason: "" });
      return new Response("not found", { status: 404 });
    },
  } as unknown as Fetcher;
  return { fetcher, spend };
}

async function makeDO(project: { execution_ceiling: number; daily_spend_cap_credits: number }) {
  const r2 = makeR2();
  const ctx = { storage: { sql: createDOSqlStorage(), async setAlarm() {}, async deleteAlarm() {} } };
  const { fetcher: spacesWorker, spend } = makeSpacesWorker(project);
  const env = {
    PLATFORM_SECRET: "test",
    KNOWLEDGE_WORKER: { fetch: async () => new Response("{}") } as unknown as Fetcher,
    SPACES_WORKER: spacesWorker,
    SCRIPTS_R2: r2,
  };
  const spaceDO = new NaelaoAgentDO(ctx as never, env as never);

  await writeAgentConfig(r2, "space1", "naelao-agent", {
    agentsMd: "# Agent",
    systemPrompt: "You are a support bot.",
    scripts: { prebuilt: ["notifications"], agent_scripts: "auto", startup_observe: "observe_filesystem" },
    skills: { skills: [] },
  });

  return { spaceDO, spend };
}

async function scriptRun(doInstance: NaelaoAgentDO, projectId: string) {
  return doInstance.fetch(new Request("http://agent-do/script/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ goal: "help the customer", spaceId: "space1", agentId: "naelao-agent", tenantId: "tenant1", projectId, apiKey: "" }),
  }));
}

describe("NaelaoAgentDO /script/run — customer-bot daily spend cap", () => {
  it("rejects with 429 when the project is already at its daily spend cap, before any reasoning runs", async () => {
    const { spaceDO, spend } = await makeDO({ execution_ceiling: 2, daily_spend_cap_credits: 100 });

    // Push the project over its cap via the same SpaceDO-backed store the gate itself reads —
    // mirrors prior spend recorded via the heartbeat path or a previous /script/run.
    spend.set("proj1", 500);

    const res = await scriptRun(spaceDO, "proj1");
    expect(res.status).toBe(429);
    const body = await res.json() as { error_code?: string };
    expect(body.error_code).toBe("spend_capped");
  });

  it("does not gate a project with no configured spend cap (daily_spend_cap_credits = 0)", async () => {
    const { spaceDO } = await makeDO({ execution_ceiling: 2, daily_spend_cap_credits: 0 });
    const res = await scriptRun(spaceDO, "proj1");
    // Not 429 — falls through to the reasoning loop (which will itself fail/500 in this
    // minimal test env with no real LLM gateway configured, which is fine — the point is the
    // spend-cap gate specifically did not short-circuit it).
    expect(res.status).not.toBe(429);
  });

  it("does not gate a run with no projectId (Space Assistant runs are never customer-bot-capped)", async () => {
    const { spaceDO, spend } = await makeDO({ execution_ceiling: 2, daily_spend_cap_credits: 100 });
    spend.set("proj1", 500);

    const res = await spaceDO.fetch(new Request("http://agent-do/script/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal: "help the customer", spaceId: "space1", agentId: "naelao-agent", tenantId: "tenant1", apiKey: "" }),
    }));
    expect(res.status).not.toBe(429);
  });

  it("fails CLOSED (429) when the SpaceDO spend endpoint is unreachable — never fails open", async () => {
    const r2 = makeR2();
    const ctx = { storage: { sql: createDOSqlStorage(), async setAlarm() {}, async deleteAlarm() {} } };
    const env = {
      PLATFORM_SECRET: "test",
      KNOWLEDGE_WORKER: { fetch: async () => new Response("{}") } as unknown as Fetcher,
      SPACES_WORKER: {
        async fetch(input: RequestInfo) {
          const url = new URL(typeof input === "string" ? input : (input as Request).url);
          if (/\/spend$/.test(url.pathname)) throw new Error("network down");
          if (/^\/spaces\/[^/]+\/projects\/[^/]+$/.test(url.pathname)) {
            return Response.json({ execution_ceiling: 2, daily_spend_cap_credits: 100 });
          }
          if (/^\/internal\/spaces\/[^/]+\/model-policy$/.test(url.pathname)) return Response.json({ policy: null });
          if (url.pathname === "/internal/pricing-catalog") return Response.json({ external_revenue_cut: { enabled: false } });
          if (url.pathname === "/internal/business-subscription-status") return Response.json({ gated: false, active: true, reason: "" });
          return new Response("not found", { status: 404 });
        },
      } as unknown as Fetcher,
      SCRIPTS_R2: r2,
    };
    const spaceDO = new NaelaoAgentDO(ctx as never, env as never);
    await writeAgentConfig(r2, "space1", "naelao-agent", {
      agentsMd: "# Agent",
      systemPrompt: "You are a support bot.",
      scripts: { prebuilt: ["notifications"], agent_scripts: "auto", startup_observe: "observe_filesystem" },
      skills: { skills: [] },
    });

    const res = await scriptRun(spaceDO, "proj1");
    expect(res.status).toBe(429);
    const body = await res.json() as { error_code?: string };
    expect(body.error_code).toBe("spend_capped");
  });
});
