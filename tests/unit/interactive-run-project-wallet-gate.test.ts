import { describe, it, expect } from "vitest";
import { NaelaoAgentDO } from "../../workers/agents/src/do/NaelaoAgentDO.js";
import { createDOSqlStorage } from "./helpers/sqlite-do-shim.js";

// Go-live audit A-1: same incident as interactive-run-end-user-credit-gate.test.ts, but for a
// project-scoped run (customer-bot type projects) hitting the legacy ReAct `handleRun` path.
// Before this fix, a project-scoped interactive run never checked the space's own wallet at
// all — only handleScriptRun did. This proves enforceRunGates' project wallet gate now applies
// identically on the interactive /run path: it refuses the run, before any reasoning/LLM call,
// when the project's space wallet is empty, and degrades honestly (never blocks) when the
// wallet is funded, unprovisioned, or transiently unreachable.

type WalletState = { projectId: string | null; balanceCents: number | "unreachable" };

function makeSpacesWorker(wallet: WalletState) {
  const debitCalls: Array<{ cents: number }> = [];
  const fetcher = {
    async fetch(input: RequestInfo) {
      const req = input as Request;
      const url = new URL(typeof input === "string" ? input : req.url);
      if (/^\/spaces\/[^/]+\/wallet-project$/.test(url.pathname)) {
        return Response.json({ project_id: wallet.projectId });
      }
      if (wallet.projectId && new RegExp(`/projects/${wallet.projectId}/wallet/balance$`).test(url.pathname)) {
        if (wallet.balanceCents === "unreachable") throw new Error("network down");
        return Response.json({ project_id: wallet.projectId, balance_cents: wallet.balanceCents, currency: "USD" });
      }
      if (wallet.projectId && new RegExp(`/projects/${wallet.projectId}/wallet/debit$`).test(url.pathname)) {
        const body = await req.json<{ cents: number }>().catch(() => ({ cents: 0 }));
        debitCalls.push({ cents: body.cents });
        const bal = wallet.balanceCents === "unreachable" ? 0 : wallet.balanceCents;
        if (body.cents > bal) return Response.json({ error_code: "insufficient_balance", balance_cents: bal }, { status: 402 });
        return Response.json({ balance_cents: bal - body.cents }, { status: 201 });
      }
      if (/^\/spaces\/[^/]+\/projects\/[^/]+\/spend$/.test(url.pathname)) {
        return Response.json({ project_id: "proj1", day: "test-day", spent_today: 0, cap: 0, capped: false });
      }
      if (/^\/spaces\/[^/]+\/projects\/[^/]+$/.test(url.pathname)) {
        return Response.json({ execution_ceiling: 5, daily_spend_cap_credits: 0 });
      }
      return new Response("not found", { status: 404 });
    },
  } as unknown as Fetcher;
  return { fetcher, debitCalls };
}

async function runInteractiveForProject(wallet: WalletState, projectId: string) {
  const { fetcher: SPACES_WORKER, debitCalls } = makeSpacesWorker(wallet);
  const env = {
    PLATFORM_SECRET: "test",
    KNOWLEDGE_WORKER: { fetch: async () => new Response("{}") } as unknown as Fetcher,
    SPACES_WORKER,
  };
  const ctx = { storage: { sql: createDOSqlStorage(), getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {} } };
  const spaceDO = new NaelaoAgentDO(ctx as never, env as never);
  const res = await spaceDO.fetch(new Request("http://agent-do/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      goal: "help the customer",
      sessionId: "sess-1",
      spaceId: "space1",
      tenantId: "tenant1",
      systemPrompt: "You are a support bot.",
      tools: [],
      kbContext: "",
      apiKey: "",
      model: "claude-haiku-4-5-20251001",
      allowedDomains: [],
      projectId,
    }),
  }));
  return { res, debitCalls };
}

describe("NaelaoAgentDO /run (interactive ReAct path) — project wallet payer gate", () => {
  it("rejects with 402 when the project's space has a wallet but it's empty, before any reasoning/LLM call", async () => {
    const { res, debitCalls } = await runInteractiveForProject({ projectId: "wallet1", balanceCents: 0 }, "proj1");
    expect(res.status).toBe(402);
    const body = await res.json() as { error_code?: string; balance_cents?: number };
    expect(body.error_code).toBe("insufficient_credits");
    expect(body.balance_cents).toBe(0);
    // The run never happened — no debit was ever attempted.
    expect(debitCalls.length).toBe(0);
  });

  it("does not short-circuit when the wallet is funded", async () => {
    const { res } = await runInteractiveForProject({ projectId: "wallet1", balanceCents: 1000 }, "proj1");
    // Not 402 — falls through to the ReAct loop, which will itself fail/500 in this minimal
    // test env (no real LLM gateway reachable); the point is the wallet gate did not block it.
    expect(res.status).not.toBe(402);
  });

  it("does not block when the space has no wallet project at all (degrades honestly)", async () => {
    const { res } = await runInteractiveForProject({ projectId: null, balanceCents: 0 }, "proj1");
    expect(res.status).not.toBe(402);
  });

  it("fails OPEN only on a transient wallet-lookup error (never blocks on a network hiccup)", async () => {
    const { res } = await runInteractiveForProject({ projectId: "wallet1", balanceCents: "unreachable" }, "proj1");
    expect(res.status).not.toBe(402);
  });
});
