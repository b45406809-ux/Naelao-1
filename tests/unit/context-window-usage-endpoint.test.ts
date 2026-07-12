import { describe, it, expect, vi } from "vitest";
import { app } from "../../workers/agents/src/index.js";
import type { AgentsEnv } from "../../workers/agents/src/index.js";
import { mintInternalToken } from "@naelao/http";

// §A1.27: GET .../context-usage combines two independent numbers: (1) this session's current
// message-history size against the selected model's context window (estimated from the real
// message transcript, since the script-native loop's own per-turn reasoner payload does NOT grow
// with conversation length — see the endpoint's own comment), and (2) day/week/month LLM-token
// usage against the org's plan limit, degrading to nulls (never failing the request) when the
// billing worker is unbound or unreachable.

const SECRET = "test-platform-secret";
const execCtx = { waitUntil: (p: Promise<unknown>) => { void p; }, passThroughOnException() {} } as unknown as ExecutionContext;

function makeDb() {
  return {
    prepare(sql: string) {
      return {
        bind(..._args: unknown[]) { return this; },
        async first() {
          if (sql.includes("FROM spaces")) return { id: "space-1" };
          return null;
        },
      };
    },
  };
}

function makeEnv(opts: {
  messages?: Array<{ content: string }>;
  billingSummary?: { daily: { used: number; limit: number }; weekly: { used: number; limit: number }; monthly: { used: number; limit: number } };
  billingUnbound?: boolean;
  billingUnreachable?: boolean;
}) {
  const spacesWorker = {
    async fetch(input: RequestInfo) {
      const url = new URL((input as Request).url);
      if (url.pathname.endsWith("/messages")) {
        return Response.json({ data: opts.messages ?? [] });
      }
      return new Response("not found", { status: 404 });
    },
  };
  const billingWorker = opts.billingUnreachable
    ? { fetch: vi.fn().mockRejectedValue(new Error("network down")) }
    : { fetch: vi.fn().mockResolvedValue(Response.json(opts.billingSummary ?? { daily: { used: 0, limit: 0 }, weekly: { used: 0, limit: 0 }, monthly: { used: 0, limit: 0 } })) };

  return {
    PLATFORM_SECRET: SECRET,
    PLATFORM_DB: makeDb(),
    SPACES_WORKER: spacesWorker,
    ...(opts.billingUnbound ? {} : { BILLING_WORKER: billingWorker }),
  } as unknown as AgentsEnv;
}

async function getUsage(env: AgentsEnv, model?: string) {
  const token = await mintInternalToken(SECRET, "tenant-a");
  const qs = model ? `?model=${model}` : "";
  return app.fetch(
    new Request(`https://agents.naelao.com/spaces/space-1/sessions/sess-1/context-usage${qs}`, {
      headers: { "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token },
    }),
    env,
    execCtx
  );
}

describe("GET .../sessions/:sessionId/context-usage", () => {
  it("estimates current_tokens from the real message transcript (~chars/4)", async () => {
    const content = "a".repeat(400); // ~100 tokens
    const env = makeEnv({ messages: [{ content }, { content }] }); // ~200 tokens
    const res = await getUsage(env);
    expect(res.status).toBe(200);
    const body = await res.json() as { current_tokens: number };
    expect(body.current_tokens).toBeGreaterThanOrEqual(190);
    expect(body.current_tokens).toBeLessThanOrEqual(210);
  });

  it("computes percent_full against the selected model's context window", async () => {
    const env = makeEnv({ messages: [] });
    const res = await getUsage(env, "claude-haiku-4-5-20251001");
    const body = await res.json() as { current_tokens: number; model_window: number; percent_full: number };
    expect(body.model_window).toBeGreaterThan(0);
    expect(body.percent_full).toBe(0);
  });

  it("includes real daily/weekly/monthly usage when the billing worker is reachable", async () => {
    const env = makeEnv({ messages: [], billingSummary: { daily: { used: 100, limit: 5000 }, weekly: { used: 500, limit: 5000 }, monthly: { used: 1000, limit: 5000 } } });
    const res = await getUsage(env);
    const body = await res.json() as { daily_used: number; daily_limit: number; weekly_used: number; monthly_limit: number };
    expect(body.daily_used).toBe(100);
    expect(body.daily_limit).toBe(5000);
    expect(body.weekly_used).toBe(500);
    expect(body.monthly_limit).toBe(5000);
  });

  it("degrades to null usage fields (never fails the request) when BILLING_WORKER is unbound", async () => {
    const env = makeEnv({ messages: [], billingUnbound: true });
    const res = await getUsage(env);
    expect(res.status).toBe(200);
    const body = await res.json() as { daily_used: number | null; current_tokens: number };
    expect(body.daily_used).toBeNull();
    expect(body.current_tokens).toBe(0);
  });

  it("degrades to null usage fields when the billing worker call throws", async () => {
    const env = makeEnv({ messages: [], billingUnreachable: true });
    const res = await getUsage(env);
    expect(res.status).toBe(200);
    const body = await res.json() as { monthly_used: number | null };
    expect(body.monthly_used).toBeNull();
  });

  it("reports current_tokens: 0 (not a failure) when the message history fetch fails", async () => {
    const env = makeEnv({ messages: [] });
    (env.SPACES_WORKER as { fetch: () => Promise<Response> }).fetch = async () => new Response("error", { status: 500 });
    const res = await getUsage(env);
    expect(res.status).toBe(200);
    const body = await res.json() as { current_tokens: number };
    expect(body.current_tokens).toBe(0);
  });
});

describe("POST .../sessions/:sessionId/compact", () => {
  it("triggers memory maintenance on the space-wide assistant DO and returns its result", async () => {
    const maintenanceResult = { decayed: 2, pruned_facts: 0, promoted: 1, pruned_episodic: 0 };
    const agentDoStub = { async fetch() { return Response.json(maintenanceResult); } };
    const env = {
      PLATFORM_SECRET: SECRET,
      PLATFORM_DB: makeDb(),
      NAELAO_AGENT_DO: { idFromName: (name: string) => ({ toString: () => name }), get: () => agentDoStub },
    } as unknown as AgentsEnv;
    const token = await mintInternalToken(SECRET, "tenant-a");
    const res = await app.fetch(
      new Request("https://agents.naelao.com/spaces/space-1/sessions/sess-1/compact", {
        method: "POST",
        headers: { "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token },
      }),
      env,
      execCtx
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; result: typeof maintenanceResult };
    expect(body.ok).toBe(true);
    expect(body.result).toEqual(maintenanceResult);
  });

  it("returns a clean 502 (not an unhandled throw) when the maintenance call itself fails", async () => {
    const agentDoStub = { async fetch() { return new Response("error", { status: 500 }); } };
    const env = {
      PLATFORM_SECRET: SECRET,
      PLATFORM_DB: makeDb(),
      NAELAO_AGENT_DO: { idFromName: (name: string) => ({ toString: () => name }), get: () => agentDoStub },
    } as unknown as AgentsEnv;
    const token = await mintInternalToken(SECRET, "tenant-a");
    const res = await app.fetch(
      new Request("https://agents.naelao.com/spaces/space-1/sessions/sess-1/compact", {
        method: "POST",
        headers: { "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token },
      }),
      env,
      execCtx
    );
    expect(res.status).toBe(502);
  });
});
