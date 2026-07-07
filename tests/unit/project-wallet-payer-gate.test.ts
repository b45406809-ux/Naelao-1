import { describe, it, expect } from "vitest";
import { NaelaoAgentDO } from "../../workers/agents/src/do/NaelaoAgentDO.js";
import { writeAgentConfig } from "../../workers/agents/src/script-engine/agent-config.js";
import { createDOSqlStorage } from "./helpers/sqlite-do-shim.js";

// Metering enforcement follow-up: a project-scoped run (customer-bot type projects) with no
// builder-configured daily_spend_cap_credits used to run completely unmetered — no payer of any
// kind. The space's own wallet (auto-provisioned by the provisioner's seedWallet step) is now the
// payer for every project-scoped run, independent of whether a spend cap is configured. This
// proves the gate rejects the run itself (before any reasoner call) when the wallet is empty, lets
// it through when funded, and degrades honestly (never blocks) when no wallet was ever provisioned
// or the lookup is transiently unreachable.

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

type WalletState = { projectId: string | null; balanceCents: number | "unreachable" };

function makeSpacesWorker(wallet: WalletState, project: { execution_ceiling: number; daily_spend_cap_credits: number } = { execution_ceiling: 5, daily_spend_cap_credits: 0 }) {
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
        return Response.json({ project_id: "proj1", day: "test-day", spent_today: 0, cap: project.daily_spend_cap_credits, capped: false });
      }
      if (/^\/spaces\/[^/]+\/projects\/[^/]+$/.test(url.pathname)) {
        return Response.json(project);
      }
      return new Response("not found", { status: 404 });
    },
  } as unknown as Fetcher;
  return { fetcher, debitCalls };
}

async function makeDO(wallet: WalletState, project?: { execution_ceiling: number; daily_spend_cap_credits: number }) {
  const r2 = makeR2();
  const ctx = { storage: { sql: createDOSqlStorage() } };
  const { fetcher: spacesWorker, debitCalls } = makeSpacesWorker(wallet, project);
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

  return { spaceDO, debitCalls };
}

function scriptRunForProject(doInstance: NaelaoAgentDO, projectId: string) {
  return doInstance.fetch(new Request("http://agent-do/script/run", {
    method: "POST",
    headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant1" },
    body: JSON.stringify({ goal: "help the customer", spaceId: "space1", agentId: "naelao-agent", projectId, apiKey: "" }),
  }));
}

describe("NaelaoAgentDO /script/run — project wallet payer gate", () => {
  it("rejects with 402 when the project's space has a wallet but it's empty, before any reasoning runs", async () => {
    const { spaceDO } = await makeDO({ projectId: "wallet1", balanceCents: 0 });
    const res = await scriptRunForProject(spaceDO, "proj1");
    expect(res.status).toBe(402);
    const body = await res.json() as { error_code?: string; balance_cents?: number };
    expect(body.error_code).toBe("insufficient_credits");
    expect(body.balance_cents).toBe(0);
  });

  it("does not short-circuit when the wallet is funded", async () => {
    const { spaceDO } = await makeDO({ projectId: "wallet1", balanceCents: 1000 });
    const res = await scriptRunForProject(spaceDO, "proj1");
    // Not 402 — falls through to the reasoning loop (which will itself fail/500 in this minimal
    // test env with no real LLM gateway configured; the point is the wallet gate specifically
    // did not short-circuit it).
    expect(res.status).not.toBe(402);
  });

  it("applies REGARDLESS of whether a daily_spend_cap_credits is configured for the project", async () => {
    // No spend cap set (0) — the old behavior would have let this run through completely
    // unmetered. The wallet gate must still apply.
    const { spaceDO } = await makeDO({ projectId: "wallet1", balanceCents: 0 }, { execution_ceiling: 5, daily_spend_cap_credits: 0 });
    const res = await scriptRunForProject(spaceDO, "proj1");
    expect(res.status).toBe(402);
  });

  it("does not block when the space has no wallet project at all (degrades honestly, doesn't crash)", async () => {
    const { spaceDO } = await makeDO({ projectId: null, balanceCents: 0 });
    const res = await scriptRunForProject(spaceDO, "proj1");
    expect(res.status).not.toBe(402);
  });

  it("fails OPEN only on a transient wallet-lookup error (never blocks on a network hiccup)", async () => {
    const { spaceDO } = await makeDO({ projectId: "wallet1", balanceCents: "unreachable" });
    const res = await scriptRunForProject(spaceDO, "proj1");
    expect(res.status).not.toBe(402);
  });

  it("does not apply to a run with no projectId (Space Assistant runs use the end-user credit gate instead)", async () => {
    const { spaceDO } = await makeDO({ projectId: "wallet1", balanceCents: 0 });
    const res = await spaceDO.fetch(new Request("http://agent-do/script/run", {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant1" },
      body: JSON.stringify({ goal: "help me", spaceId: "space1", agentId: "naelao-agent", apiKey: "" }),
    }));
    expect(res.status).not.toBe(402);
  });
});
