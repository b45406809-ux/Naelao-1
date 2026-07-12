import { describe, it, expect } from "vitest";
import { NaelaoAgentDO } from "../../workers/agents/src/do/NaelaoAgentDO.js";
import { createDOSqlStorage } from "./helpers/sqlite-do-shim.js";

// Go-live audit A-1: the legacy ReAct `handleRun` path (every interactive POST /agent/run
// message from apps/shell and apps/portal actually reaches this, not handleScriptRun) used to
// carry NONE of the F-36 clamp / spend-cap / wallet / product_end_user credit gates
// handleScriptRun always had — a signed-in end user with a drained credit balance could chat
// against the platform's own LLM key completely unmetered. This proves the shared
// `enforceRunGates` gate (extracted so both runtimes call it) now refuses the run itself, BEFORE
// any reasoning loop / LLM call, when the end user's balance is already at or below zero — and
// that no debit is ever attempted for a run that never happened.

function makeSpacesWorker(balanceCredits: number) {
  const calls: string[] = [];
  const fetcher = {
    async fetch(input: RequestInfo) {
      const req = input as Request;
      const url = new URL(typeof input === "string" ? input : req.url);
      calls.push(url.pathname);
      if (/\/credits\/refresh-monthly$/.test(url.pathname)) return new Response("{}");
      if (/\/credits\/balance$/.test(url.pathname)) return Response.json({ balance_credits: balanceCredits });
      if (/\/credits\/deduct$/.test(url.pathname)) return Response.json({ balance_credits: balanceCredits }, { status: 201 });
      return new Response("not found", { status: 404 });
    },
  } as unknown as Fetcher;
  return { fetcher, calls };
}

async function runInteractive(env: Record<string, unknown>, opts: { userId: string; callerRole: string; projectId?: string }) {
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
      ...(opts.projectId ? { projectId: opts.projectId } : {}),
    }),
  }));
}

describe("NaelaoAgentDO /run (interactive ReAct path) — product_end_user pre-run credit gate", () => {
  it("rejects with 402 when the end user's balance is zero, before any reasoning/LLM call", async () => {
    const { fetcher: SPACES_WORKER, calls } = makeSpacesWorker(0);
    const env = { PLATFORM_SECRET: "test", KNOWLEDGE_WORKER: { fetch: async () => new Response("{}") } as unknown as Fetcher, SPACES_WORKER };
    const res = await runInteractive(env, { userId: "alice", callerRole: "product_end_user" });
    expect(res.status).toBe(402);
    const body = await res.json() as { error_code?: string; balance_credits?: number };
    expect(body.error_code).toBe("insufficient_credits");
    expect(body.balance_credits).toBe(0);
    // The balance was checked, but no debit was ever attempted — the run never happened.
    expect(calls.some((p) => p.includes("/credits/balance"))).toBe(true);
    expect(calls.some((p) => p.includes("/credits/deduct"))).toBe(false);
  });

  it("rejects with 402 when the end user's balance is negative", async () => {
    const { fetcher: SPACES_WORKER } = makeSpacesWorker(-5);
    const env = { PLATFORM_SECRET: "test", KNOWLEDGE_WORKER: { fetch: async () => new Response("{}") } as unknown as Fetcher, SPACES_WORKER };
    const res = await runInteractive(env, { userId: "alice", callerRole: "product_end_user" });
    expect(res.status).toBe(402);
  });

  it("does not short-circuit on the credit gate when the balance is positive", async () => {
    const { fetcher: SPACES_WORKER } = makeSpacesWorker(500);
    const env = { PLATFORM_SECRET: "test", KNOWLEDGE_WORKER: { fetch: async () => new Response("{}") } as unknown as Fetcher, SPACES_WORKER };
    const res = await runInteractive(env, { userId: "alice", callerRole: "product_end_user" });
    // Not 402 — falls through to the ReAct loop, which will itself fail/500 in this minimal test
    // env (no real LLM gateway reachable); the point is the credit gate did not block it.
    expect(res.status).not.toBe(402);
  });

  it("does not apply the end-user credit gate to a caller who isn't a product_end_user", async () => {
    const { fetcher: SPACES_WORKER, calls } = makeSpacesWorker(0);
    const env = { PLATFORM_SECRET: "test", KNOWLEDGE_WORKER: { fetch: async () => new Response("{}") } as unknown as Fetcher, SPACES_WORKER };
    const res = await runInteractive(env, { userId: "owner-1", callerRole: "owner" });
    expect(res.status).not.toBe(402);
    expect(calls.some((p) => p.includes("/credits/balance"))).toBe(false);
  });
});
