import { describe, it, expect } from "vitest";
import { NaelaoAgentDO } from "../../workers/agents/src/do/NaelaoAgentDO.js";
import { createDOSqlStorage } from "./helpers/sqlite-do-shim.js";

function makeBillingWorker(llmAllowed: boolean) {
  const calls: string[] = [];
  const fetcher = {
    async fetch(input: RequestInfo) {
      const req = input as Request;
      const path = new URL(typeof input === "string" ? input : req.url).pathname;
      calls.push(path);
      if (path.endsWith("/llm-tokens/check")) {
        return Response.json({ allowed: llmAllowed, current: llmAllowed ? 0 : 100, limit: 100 });
      }
      if (path.endsWith("/infra-credits/check")) return Response.json({ allowed: true, current: 0, limit: 100 });
      return new Response("not found", { status: 404 });
    },
  } as unknown as Fetcher;
  return { fetcher, calls };
}

async function runInteractive(env: Record<string, unknown>, callerRole: string) {
  const ctx = { storage: { sql: createDOSqlStorage(), getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {} } };
  const spaceDO = new NaelaoAgentDO(ctx as never, env as never);
  return spaceDO.fetch(new Request("http://agent-do/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      goal: "help me with my task", sessionId: "sess-1", spaceId: "space1", tenantId: "tenant1",
      systemPrompt: "You are a helpful assistant.", tools: [], kbContext: "", apiKey: "",
      model: "claude-haiku-4-5-20251001", allowedDomains: [], userId: "alice", callerRole,
    }),
  }));
}

describe("NaelaoAgentDO /run uses subscription quotas instead of personal credit wallets", () => {
  it("blocks an exhausted Space quota before inference and never calls retired credit endpoints", async () => {
    const { fetcher: BILLING_WORKER, calls: billingCalls } = makeBillingWorker(false);
    const spacesCalls: string[] = [];
    const SPACES_WORKER = { fetch: async (input: RequestInfo) => {
      const req = input as Request;
      const path = new URL(typeof input === "string" ? input : req.url).pathname;
      spacesCalls.push(path);
      return new Response("not found", { status: 404 });
    } } as unknown as Fetcher;
    const env = { PLATFORM_SECRET: "test", BILLING_WORKER, SPACES_WORKER };
    const res = await runInteractive(env, "product_end_user");
    expect(res.status).toBe(402);
    expect((await res.json() as { error_code?: string }).error_code).toBe("quota_exceeded");
    expect(billingCalls).toContain("/internal/usage/llm-tokens/check");
    expect(spacesCalls.some((path) => path.includes("/credits/"))).toBe(false);
  });

  it("does not introduce a wallet gate for platform members", async () => {
    const { fetcher: BILLING_WORKER, calls: billingCalls } = makeBillingWorker(true);
    const SPACES_WORKER = { fetch: async () => new Response("not found", { status: 404 }) } as unknown as Fetcher;
    const env = { PLATFORM_SECRET: "test", BILLING_WORKER, SPACES_WORKER };
    const res = await runInteractive(env, "owner");
    expect((await res.json().catch(() => ({})) as { error_code?: string }).error_code).not.toBe("insufficient_credits");
    expect(billingCalls).toContain("/internal/usage/llm-tokens/check");
  });
});
