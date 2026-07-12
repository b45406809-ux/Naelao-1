import { describe, it, expect } from "vitest";
import { NaelaoAgentDO } from "../../workers/agents/src/do/NaelaoAgentDO.js";
import { createDOSqlStorage } from "./helpers/sqlite-do-shim.js";

// §A1.26: the infra-credits pre-run gate — same scoping as the existing llm-tokens builder quota
// gate (P0-3): a builder (owner/admin/editor/viewer) chatting with their own Space Assistant is
// now ALSO checked against a separate monthly Cloudflare-infra-consumption ceiling, not just an
// LLM-token ceiling. Same fail-open-on-transient-error / fail-closed-on-confirmed-over-cap
// posture as every other billing gate in enforceRunGates.

function makeBillingWorker(opts: { llmAllowed?: boolean; infraAllowed?: boolean; infraUnreachable?: boolean }) {
  const calls: string[] = [];
  const fetcher = {
    async fetch(input: RequestInfo) {
      const req = input as Request;
      const url = new URL(typeof input === "string" ? input : req.url);
      calls.push(url.pathname);
      if (url.pathname.endsWith("/internal/usage/llm-tokens/check")) {
        return Response.json({ allowed: opts.llmAllowed ?? true, current: 0, limit: 100_000 });
      }
      if (url.pathname.endsWith("/internal/usage/infra-credits/check")) {
        if (opts.infraUnreachable) throw new Error("network down");
        return Response.json({ allowed: opts.infraAllowed ?? true, current: 0, limit: 5_000 });
      }
      return new Response("not found", { status: 404 });
    },
  } as unknown as Fetcher;
  return { fetcher, calls };
}

async function runInteractive(env: Record<string, unknown>, opts: { userId: string; callerRole: string }) {
  const ctx = { storage: { sql: createDOSqlStorage(), getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {} } };
  const spaceDO = new NaelaoAgentDO(ctx as never, env as never);
  return spaceDO.fetch(new Request("http://agent-do/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      goal: "help me with my order",
      sessionId: "sess-1",
      spaceId: "space1",
      tenantId: "tenant1",
      systemPrompt: "You are a helpful assistant.",
      tools: [],
      kbContext: "",
      apiKey: "",
      model: "claude-haiku-4-5-20251001",
      allowedDomains: [],
      userId: opts.userId,
      callerRole: opts.callerRole,
    }),
  }));
}

describe("NaelaoAgentDO — builder infra-credits quota gate (enforceRunGates)", () => {
  it("rejects with 402 infra_quota_exceeded when the org's monthly infra ceiling is already hit", async () => {
    const { fetcher: BILLING_WORKER, calls } = makeBillingWorker({ infraAllowed: false });
    const env = { PLATFORM_SECRET: "test", KNOWLEDGE_WORKER: { fetch: async () => new Response("{}") } as unknown as Fetcher, BILLING_WORKER };
    const res = await runInteractive(env, { userId: "owner-1", callerRole: "owner" });
    expect(res.status).toBe(402);
    const body = await res.json() as { error_code?: string };
    expect(body.error_code).toBe("infra_quota_exceeded");
    expect(calls.some((p) => p.endsWith("/internal/usage/infra-credits/check"))).toBe(true);
  });

  it("does not block when both llm-tokens and infra-credits are within quota", async () => {
    const { fetcher: BILLING_WORKER } = makeBillingWorker({ llmAllowed: true, infraAllowed: true });
    const env = { PLATFORM_SECRET: "test", KNOWLEDGE_WORKER: { fetch: async () => new Response("{}") } as unknown as Fetcher, BILLING_WORKER };
    const res = await runInteractive(env, { userId: "owner-1", callerRole: "owner" });
    expect(res.status).not.toBe(402);
  });

  it("fails OPEN (does not block) when the infra-credits check itself is unreachable", async () => {
    const { fetcher: BILLING_WORKER } = makeBillingWorker({ infraUnreachable: true });
    const env = { PLATFORM_SECRET: "test", KNOWLEDGE_WORKER: { fetch: async () => new Response("{}") } as unknown as Fetcher, BILLING_WORKER };
    const res = await runInteractive(env, { userId: "owner-1", callerRole: "owner" });
    expect(res.status).not.toBe(402);
  });

  it("does not apply the builder infra-credits gate to a signed-in product end user", async () => {
    const { fetcher: BILLING_WORKER, calls } = makeBillingWorker({ infraAllowed: false });
    const env = {
      PLATFORM_SECRET: "test",
      KNOWLEDGE_WORKER: { fetch: async () => new Response("{}") } as unknown as Fetcher,
      BILLING_WORKER,
      SPACES_WORKER: { fetch: async () => Response.json({ balance_credits: 500 }) } as unknown as Fetcher,
    };
    await runInteractive(env, { userId: "enduser-1", callerRole: "product_end_user" });
    expect(calls.some((p) => p.endsWith("/internal/usage/infra-credits/check"))).toBe(false);
  });
});
