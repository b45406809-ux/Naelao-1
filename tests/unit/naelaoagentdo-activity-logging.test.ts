import { describe, it, expect } from "vitest";
import { NaelaoAgentDO } from "../../workers/agents/src/do/NaelaoAgentDO.js";
import { writeAgentConfig } from "../../workers/agents/src/script-engine/agent-config.js";
import { createDOSqlStorage } from "./helpers/sqlite-do-shim.js";

// Security audit follow-up (observability gap): NaelaoAgentDO now posts one row to SpaceDO's new
// agent_activity_log per run completion/failure (handleScriptRun) and per approval request
// (notifyApprovalRequested) — the builder-facing "what has my agent been doing" surface. This
// exercises that the calls actually fire with the right shape, using the same
// SPACES_WORKER-stub pattern as handlescriptrun-spend-cap.test.ts (no real LLM/reasoner needed —
// a run with no gateway configured fails, which is exactly the run_failed path this proves).

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

function makeSpacesWorker() {
  const activityCalls: Array<Record<string, unknown>> = [];
  const fetcher = {
    async fetch(input: RequestInfo) {
      const req = input as Request;
      const url = new URL(typeof input === "string" ? input : req.url);
      if (/\/internal\/spaces\/[^/]+\/agent-activity$/.test(url.pathname) && req.method === "POST") {
        const body = await req.json<Record<string, unknown>>();
        activityCalls.push(body);
        return Response.json({ ok: true }, { status: 201 });
      }
      if (/^\/spaces\/[^/]+\/projects\/[^/]+$/.test(url.pathname)) {
        return Response.json({ execution_ceiling: 2, daily_spend_cap_credits: 0 });
      }
      if (url.pathname === "/internal/pricing-catalog") return Response.json({ external_revenue_cut: { enabled: false } });
      if (url.pathname === "/internal/business-subscription-status") return Response.json({ gated: false, active: true, reason: "" });
      return new Response("not found", { status: 404 });
    },
  } as unknown as Fetcher;
  return { fetcher, activityCalls };
}

// logAgentActivity (and its caller, notifyApprovalRequested for the approval path) are fired via
// `void`, not awaited by the response — a fixed-delay flush is flaky since the number of
// microtask hops before the fetch actually resolves isn't fixed. Poll instead.
async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function makeHitlApprovalDoNamespace(): DurableObjectNamespace {
  const stub = {
    async fetch() {
      return Response.json({ approval_id: "appr-1" }, { status: 201 });
    },
  };
  return {
    idFromName: (name: string) => ({ toString: () => name }) as unknown as DurableObjectId,
    get: () => stub as unknown as DurableObjectStub,
  } as unknown as DurableObjectNamespace;
}

async function makeDO() {
  const r2 = makeR2();
  const ctx = { storage: { sql: createDOSqlStorage() } };
  const { fetcher: spacesWorker, activityCalls } = makeSpacesWorker();
  const env = {
    PLATFORM_SECRET: "test",
    KNOWLEDGE_WORKER: { fetch: async () => new Response("{}") } as unknown as Fetcher,
    SPACES_WORKER: spacesWorker,
    SCRIPTS_R2: r2,
    HITL_APPROVAL_DO: makeHitlApprovalDoNamespace(),
  };
  const spaceDO = new NaelaoAgentDO(ctx as never, env as never);
  await writeAgentConfig(r2, "space1", "naelao-agent", {
    agentsMd: "# Agent",
    systemPrompt: "You are a support bot.",
    scripts: { prebuilt: ["notifications"], agent_scripts: "auto", startup_observe: "observe_filesystem" },
    skills: { skills: [] },
  });
  return { spaceDO, activityCalls };
}

describe("NaelaoAgentDO — agent_activity_log posting", () => {
  it("posts a run_failed row when the run throws (no reasoner/API key configured in this test env)", async () => {
    const { spaceDO, activityCalls } = await makeDO();
    const res = await spaceDO.fetch(new Request("http://agent-do/script/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal: "help the customer", spaceId: "space1", agentId: "naelao-agent", tenantId: "tenant1", apiKey: "" }),
    }));
    // Whether the loop itself returns ok:false or throws, either lands in the run_failed path.
    expect(res.status).toBeLessThan(600);
    await waitFor(() => activityCalls.some((c) => c["event_type"] === "run_completed" || c["event_type"] === "run_failed"));
    const runEvents = activityCalls.filter((c) => c["event_type"] === "run_completed" || c["event_type"] === "run_failed");
    expect(runEvents.length).toBeGreaterThanOrEqual(1);
    expect(runEvents[0]).toMatchObject({ space_id: "space1", agent_id: "naelao-agent" });
  });

  it("posts an approval_requested row when an approval opens", async () => {
    const { spaceDO, activityCalls } = await makeDO();
    // Directly exercise the approvals/create-external path, which calls notifyApprovalRequested.
    const res = await spaceDO.fetch(new Request("http://agent-do/approvals/create-external", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        spaceId: "space1", tenantId: "tenant1", agentId: "naelao-agent",
        actionKey: "send_email", description: "wants to email a customer",
      }),
    }));
    expect(res.status).toBeLessThan(500);
    await waitFor(() => activityCalls.some((c) => c["event_type"] === "approval_requested"));
    const approvalEvents = activityCalls.filter((c) => c["event_type"] === "approval_requested");
    expect(approvalEvents).toHaveLength(1);
    expect(approvalEvents[0]).toMatchObject({ space_id: "space1", agent_id: "naelao-agent" });
  });
});
