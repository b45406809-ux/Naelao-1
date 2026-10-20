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
        const messages = opts.messages ?? [];
        return Response.json({ data: messages.slice(-1), total_count: messages.length,
          total_content_chars: messages.reduce((sum, message) => sum + message.content.length, 0) });
      }
      if (url.pathname.endsWith("/compact-scope")) return Response.json({ project_id: null, owned_by_caller: false, private_scratchpad: false });
      if (url.pathname.endsWith("/projects/project-private/members")) return Response.json({ data: [] });
      if (url.pathname.endsWith("/members")) return Response.json({ data: [{ user_id: "user-1", role: "owner" }] });
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

async function getUsage(env: AgentsEnv, model?: string, identity: { userId?: string; role?: string } = { userId: "user-1", role: "owner" }) {
  const token = await mintInternalToken(SECRET, "tenant-a");
  const qs = model ? `?model=${model}` : "";
  return app.fetch(
    new Request(`https://agents.naelao.com/spaces/space-1/sessions/sess-1/context-usage${qs}`, {
      headers: { "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token,
        ...(identity.userId ? { "x-naelao-user-id": identity.userId } : {}),
        ...(identity.role ? { "x-naelao-role": identity.role } : {}) },
    }),
    env,
    execCtx
  );
}

describe("GET .../sessions/:sessionId/context-usage", () => {
  it("requires an authenticated user in addition to a verified tenant", async () => {
    const response = await getUsage(makeEnv({ messages: [] }), undefined, {});
    expect(response.status).toBe(403);
  });

  it("requires current Space membership before returning session usage", async () => {
    const env = makeEnv({ messages: [] });
    const worker = env.SPACES_WORKER as { fetch: (input: RequestInfo) => Promise<Response> };
    const fetch = worker.fetch.bind(worker);
    worker.fetch = async (input) => new URL((input as Request).url).pathname.endsWith("/members")
      ? Response.json({ data: [] })
      : fetch(input);
    const response = await getUsage(env);
    expect(response.status).toBe(403);
  });

  it("requires project membership for a project-linked session", async () => {
    const env = makeEnv({ messages: [] });
    const worker = env.SPACES_WORKER as { fetch: (input: RequestInfo) => Promise<Response> };
    worker.fetch = async (input) => {
      const path = new URL((input as Request).url).pathname;
      if (path.endsWith("/compact-scope")) return Response.json({ project_id: "project-private", owned_by_caller: false });
      if (path.endsWith("/projects/project-private/members")) return Response.json({ data: [] });
      if (path.endsWith("/members")) return Response.json({ data: [{ user_id: "user-1", role: "editor" }] });
      return new Response("not found", { status: 404 });
    };
    const response = await getUsage(env);
    expect(response.status).toBe(403);
  });

  it("estimates current_tokens from the real message transcript (~chars/4)", async () => {
    const content = "a".repeat(400); // ~104 tokens
    const env = makeEnv({ messages: [{ content }, { content }] }); // ~208 tokens
    const res = await getUsage(env);
    expect(res.status).toBe(200);
    const body = await res.json() as { current_tokens: number };
    expect(body.current_tokens).toBeGreaterThanOrEqual(200);
    expect(body.current_tokens).toBeLessThanOrEqual(210);
  });

  it("uses transcript-wide aggregate metadata for long threads while fetching only one message", async () => {
    const many = Array.from({ length: 2_000 }, (_, i) => ({ content: `message-${i}`.repeat(40) }));
    const env = makeEnv({ messages: many });
    const response = await getUsage(env);
    const body = await response.json() as { current_tokens: number; transcript_complete: boolean };
    const chars = many.reduce((sum, message) => sum + message.content.length, 0);
    expect(body.current_tokens).toBe(Math.ceil(chars / 3.85));
    expect(body.transcript_complete).toBe(true);
  });

  it("labels legacy page-only responses incomplete instead of implying the whole thread was counted", async () => {
    const env = makeEnv({ messages: [{ content: "a".repeat(500) }, { content: "b".repeat(500) }] });
    const worker = env.SPACES_WORKER as { fetch: (input: RequestInfo) => Promise<Response> };
    const fetch = worker.fetch.bind(worker);
    worker.fetch = async (input) => new URL((input as Request).url).pathname.endsWith("/messages")
      ? Response.json({ data: [{ content: "b".repeat(500) }] })
      : fetch(input);
    const response = await getUsage(env);
    const body = await response.json() as { current_tokens: number; transcript_complete: boolean };
    expect(body.current_tokens).toBe(Math.ceil(500 / 3.85));
    expect(body.transcript_complete).toBe(false);
  });

  it("computes percent_full against the selected model's context window", async () => {
    const env = makeEnv({ messages: [] });
    const res = await getUsage(env, "claude-haiku-4-5-20251001");
    const body = await res.json() as { current_tokens: number; model_window: number; percent_full: number };
    expect(body.model_window).toBeGreaterThan(0);
    expect(body.percent_full).toBe(0);
  });

  it("returns a per-category breakdown whose segments sum to the model window (step 1)", async () => {
    const env = makeEnv({ messages: [{ content: "x".repeat(4000) }] }); // ~1000 tokens conversation
    const res = await getUsage(env, "claude-haiku-4-5-20251001");
    const body = await res.json() as {
      model_window: number;
      current_tokens: number;
      breakdown: Array<{ key: string; label: string; tokens: number; estimated: boolean }>;
    };
    expect(body.breakdown.map((b) => b.key)).toEqual(["conversation", "overhead", "free"]);
    // Character count is measured; conversion from characters to tokens is an estimate.
    expect(body.breakdown.find((b) => b.key === "conversation")!.estimated).toBe(true);
    expect(body.breakdown.find((b) => b.key === "overhead")!.estimated).toBe(true);
    expect(body.breakdown.find((b) => b.key === "conversation")!.tokens).toBe(body.current_tokens);
    // The three segments partition the window exactly.
    const sum = body.breakdown.reduce((s, b) => s + b.tokens, 0);
    expect(sum).toBe(body.model_window);
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
    const worker = env.SPACES_WORKER as { fetch: (input: RequestInfo) => Promise<Response> };
    const fetch = worker.fetch.bind(worker);
    worker.fetch = async (input) => new URL((input as Request).url).pathname.endsWith("/messages")
      ? new Response("error", { status: 500 })
      : fetch(input);
    const res = await getUsage(env);
    expect(res.status).toBe(200);
    const body = await res.json() as { current_tokens: number };
    expect(body.current_tokens).toBe(0);
  });
});

describe("POST .../sessions/:sessionId/compact", () => {
  it("triggers memory maintenance on the session assistant DO and returns its result", async () => {
    const maintenanceResult = { decayed: 2, pruned_facts: 0, promoted: 1, pruned_episodic: 0 };
    const agentDoStub = { async fetch() { return Response.json(maintenanceResult); } };
    const env = {
      PLATFORM_SECRET: SECRET,
      PLATFORM_DB: makeDb(),
      SPACES_WORKER: { async fetch(input: RequestInfo) {
        const path = new URL((input as Request).url).pathname;
        if (path.endsWith("/compact-scope")) return Response.json({ project_id: null, owned_by_caller: false, private_scratchpad: false });
        if (path.endsWith("/members")) return Response.json({ data: [{ user_id: "user-1", role: "owner" }] });
        return new Response("not found", { status: 404 });
      } },
      NAELAO_AGENT_DO: { idFromName: (name: string) => ({ toString: () => name }), get: () => agentDoStub },
    } as unknown as AgentsEnv;
    const token = await mintInternalToken(SECRET, "tenant-a");
    const res = await app.fetch(
      new Request("https://agents.naelao.com/spaces/space-1/sessions/sess-1/compact", {
        method: "POST",
        headers: { "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token, "x-naelao-user-id": "user-1", "x-naelao-role": "owner" },
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
      SPACES_WORKER: { async fetch(input: RequestInfo) {
        const path = new URL((input as Request).url).pathname;
        if (path.endsWith("/compact-scope")) return Response.json({ project_id: null, owned_by_caller: false, private_scratchpad: false });
        if (path.endsWith("/members")) return Response.json({ data: [{ user_id: "user-1", role: "owner" }] });
        return new Response("not found", { status: 404 });
      } },
      NAELAO_AGENT_DO: { idFromName: (name: string) => ({ toString: () => name }), get: () => agentDoStub },
    } as unknown as AgentsEnv;
    const token = await mintInternalToken(SECRET, "tenant-a");
    const res = await app.fetch(
      new Request("https://agents.naelao.com/spaces/space-1/sessions/sess-1/compact", {
        method: "POST",
        headers: { "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token, "x-naelao-user-id": "user-1", "x-naelao-role": "owner" },
      }),
      env,
      execCtx
    );
    expect(res.status).toBe(502);
  });
});
