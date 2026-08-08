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

type WalletState = {
  projectId: string | null;
  balanceCents: number | "unreachable";
  /** Total money that has EVER gone into the wallet. Omitted entirely to simulate an older
   *  spaces worker mid-rolling-deploy, which must keep the previous balance-only behaviour. */
  creditedCents?: number;
};

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
        return Response.json({
          project_id: wallet.projectId,
          balance_cents: wallet.balanceCents,
          ...(wallet.creditedCents === undefined ? {} : { credited_cents: wallet.creditedCents }),
          currency: "USD",
        });
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

describe("a wallet that was never funded is not a wallet that ran out", () => {
  // Reproduced live: a business created seconds earlier was refused every project-agent run with
  // "this business's wallet is empty — top up to keep this agent running". Every business
  // auto-provisions an empty wallet at creation, so blocking on the balance alone made "brand new"
  // and "spent everything" the same state — and made the first thing a new owner heard from their
  // own agent a demand for money.
  it("lets a brand-new business work with a zero balance it has never funded", async () => {
    const { res } = await runInteractiveForProject(
      { projectId: "wallet1", balanceCents: 0, creditedCents: 0 },
      "proj1"
    );
    // Not 402 — it falls through to the loop, which fails for unrelated reasons in this minimal
    // env (no reachable LLM gateway). The point is that the wallet did not turn it away.
    expect(res.status).not.toBe(402);
  });

  it("still stops a business that was funded and has genuinely spent it all", async () => {
    const { res, debitCalls } = await runInteractiveForProject(
      { projectId: "wallet1", balanceCents: 0, creditedCents: 2_000 },
      "proj1"
    );
    expect(res.status).toBe(402);
    expect((await res.json() as { error_code?: string }).error_code).toBe("insufficient_credits");
    expect(debitCalls.length).toBe(0);
  });

  it("still stops an overdrawn wallet", async () => {
    const { res } = await runInteractiveForProject(
      { projectId: "wallet1", balanceCents: -50, creditedCents: 1_000 },
      "proj1"
    );
    expect(res.status).toBe(402);
  });

  it("keeps the old balance-only behaviour when the field is absent (rolling deploy)", async () => {
    // A spaces worker that predates credited_cents must not silently open the gate for everyone.
    const { res } = await runInteractiveForProject({ projectId: "wallet1", balanceCents: 0 }, "proj1");
    expect(res.status).toBe(402);
  });
});
