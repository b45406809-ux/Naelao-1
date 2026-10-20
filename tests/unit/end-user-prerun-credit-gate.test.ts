import { describe, it, expect } from "vitest";
import { NaelaoAgentDO } from "../../workers/agents/src/do/NaelaoAgentDO.js";
import { writeAgentConfig } from "../../workers/agents/src/script-engine/agent-config.js";
import { createDOStorage } from "./helpers/sqlite-do-shim.js";
import { makeR2Bucket } from "./helpers/r2-bucket.js";

// Metering enforcement pass: a non-project (Space Assistant / Home chat) run by a signed-in
// product_end_user used to debit their ProductUserDO balance ONLY after the reasoning loop
// completed — so a zero balance was discovered by the post-run debit 402ing, by which point the
// real Anthropic tokens for the run had already been spent on Naelao's own platform key. This
// proves the new pre-run gate rejects the run itself (before any reasoner call) when the balance
// is already at or below zero, and lets it through otherwise.

function makeR2(): R2Bucket {
  return makeR2Bucket();
}

function makeSpacesWorker(balanceCredits: number | "unreachable") {
  const calls: string[] = [];
  const fetcher = {
    async fetch(input: RequestInfo) {
      const req = input as Request;
      const url = new URL(typeof input === "string" ? input : req.url);
      calls.push(url.pathname);
      if (url.pathname.endsWith("/model-policy")) return Response.json({ policy: null });
      if (url.pathname === "/internal/pricing-catalog") return Response.json({ external_revenue_cut: { enabled: false } });
      if (url.pathname === "/internal/business-subscription-status") return Response.json({ gated: false, active: true, reason: "" });
      if (/\/credits\/refresh-monthly$/.test(url.pathname)) return Response.json({ ok: true, refreshed: false });
      if (/\/credits\/balance$/.test(url.pathname)) {
        if (balanceCredits === "unreachable") throw new Error("network down");
        return Response.json({ balance_credits: balanceCredits });
      }
      return new Response("not found", { status: 404 });
    },
  } as unknown as Fetcher;
  return { fetcher, calls };
}

async function makeDO(balanceCredits: number | "unreachable") {
  const r2 = makeR2();
  const ctx = { storage: createDOStorage() };
  const { fetcher: spacesWorker, calls } = makeSpacesWorker(balanceCredits);
  const env = {
    PLATFORM_SECRET: "test",
    KNOWLEDGE_WORKER: { fetch: async () => new Response("{}") } as unknown as Fetcher,
    SPACES_WORKER: spacesWorker,
    SCRIPTS_R2: r2,
  };
  const spaceDO = new NaelaoAgentDO(ctx as never, env as never);

  await writeAgentConfig(r2, "space1", "naelao-agent", {
    agentsMd: "# Agent",
    systemPrompt: "You are a helpful assistant.",
    scripts: { prebuilt: ["notifications"], agent_scripts: "auto", startup_observe: "observe_filesystem" },
    skills: { skills: [] },
  });

  return { spaceDO, calls };
}

function scriptRunAsEndUser(doInstance: NaelaoAgentDO, endUserId: string) {
  return doInstance.fetch(new Request("http://agent-do/script/run", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-naelao-tenant-id": "tenant1",
      "x-naelao-user-id": endUserId,
      "x-naelao-role": "product_end_user",
    },
    // No projectId — this is a Space Assistant / Home chat run.
    body: JSON.stringify({ goal: "help me", spaceId: "space1", agentId: "naelao-agent", apiKey: "" }),
  }));
}

describe("NaelaoAgentDO /script/run — pre-run credit gate (product_end_user, non-project)", () => {
  it("rejects with 402 when the end user's balance is zero, before any reasoning runs", async () => {
    const { spaceDO, calls } = await makeDO(0);
    const res = await scriptRunAsEndUser(spaceDO, "alice");
    expect(res.status, await res.clone().text()).toBe(402);
    const body = await res.json() as { error_code?: string; balance_credits?: number };
    expect(body.error_code).toBe("insufficient_credits");
    expect(body.balance_credits).toBe(0);
    expect(calls.some((p) => p.includes("/credits/balance"))).toBe(true);
  });

  it("rejects with 402 when the end user's balance is negative", async () => {
    const { spaceDO } = await makeDO(-5);
    const res = await scriptRunAsEndUser(spaceDO, "alice");
    expect(res.status).toBe(402);
  });

  it("does not short-circuit when the balance is positive", async () => {
    const { spaceDO } = await makeDO(500);
    const res = await scriptRunAsEndUser(spaceDO, "alice");
    // Not 402 — falls through to the reasoning loop (which will itself fail/500 in this minimal
    // test env with no real LLM gateway configured; the point is the credit gate specifically
    // did not short-circuit it).
    expect(res.status).not.toBe(402);
  });

  it("fails OPEN only on a transient balance-check error (never blocks on a network hiccup)", async () => {
    const { spaceDO } = await makeDO("unreachable");
    const res = await scriptRunAsEndUser(spaceDO, "alice");
    expect(res.status).not.toBe(402);
  });

  it("does not apply to a run with a projectId (project-scoped spend cap is a separate gate)", async () => {
    const { spaceDO, calls } = await makeDO(0);
    const res = await spaceDO.fetch(new Request("http://agent-do/script/run", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": "tenant1",
        "x-naelao-user-id": "alice",
        "x-naelao-role": "product_end_user",
      },
      body: JSON.stringify({ goal: "help me", spaceId: "space1", agentId: "naelao-agent", projectId: "proj1", apiKey: "" }),
    }));
    expect(res.status).not.toBe(402);
    expect(calls.some((p) => p.includes("/credits/balance"))).toBe(false);
  });

  it("Tier 2 metering follow-up: calls the monthly-refresh endpoint before checking the balance", async () => {
    const { spaceDO, calls } = await makeDO(500);
    await scriptRunAsEndUser(spaceDO, "alice");
    const refreshIdx = calls.findIndex((p) => p.includes("/credits/refresh-monthly"));
    const balanceIdx = calls.findIndex((p) => p.includes("/credits/balance"));
    expect(refreshIdx).toBeGreaterThanOrEqual(0);
    expect(balanceIdx).toBeGreaterThan(refreshIdx);
  });

  it("does not apply to a caller who isn't a product_end_user (e.g. the builder/owner)", async () => {
    const { spaceDO, calls } = await makeDO(0);
    const res = await spaceDO.fetch(new Request("http://agent-do/script/run", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": "tenant1",
        "x-naelao-user-id": "owner-1",
        "x-naelao-role": "owner",
      },
      body: JSON.stringify({ goal: "help me", spaceId: "space1", agentId: "naelao-agent", apiKey: "" }),
    }));
    expect(res.status).not.toBe(402);
    expect(calls.some((p) => p.includes("/credits/balance"))).toBe(false);
  });
});
