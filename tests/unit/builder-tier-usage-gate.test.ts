import { describe, it, expect } from "vitest";
import { NaelaoAgentDO } from "../../workers/agents/src/do/NaelaoAgentDO.js";
import { writeAgentConfig } from "../../workers/agents/src/script-engine/agent-config.js";
import { createDOStorage } from "./helpers/sqlite-do-shim.js";
import { makeR2Bucket } from "./helpers/r2-bucket.js";

// P0-3: a builder (owner/admin/editor/viewer — a Team collaborator) chatting with their OWN
// Space Assistant had NO metering at all — the pre-run credit gate only ever fired for
// callerRole === "product_end_user". A free-tier builder could burn the platform's Anthropic key
// all day at zero cost. This proves the new pre-run gate rejects the run itself (before any
// reasoner call) once the org's monthly llm_tokens quota is exhausted, applies only to the
// builder-human roles (never a product_end_user, never a project-scoped run, never an internal/
// system-initiated call with no role header at all), and degrades honestly on a billing outage.

function makeR2(): R2Bucket { return makeR2Bucket(); }

function makeBillingWorker(quota: { allowed: boolean; current?: number; limit?: number } | "unreachable") {
  const calls: string[] = [];
  const fetcher = {
    async fetch(input: RequestInfo) {
      const req = input as Request;
      const url = new URL(typeof input === "string" ? input : req.url);
      calls.push(url.pathname);
      if (url.pathname === "/internal/usage/llm-tokens/check") {
        if (quota === "unreachable") throw new Error("network down");
        return Response.json({ ...quota, current: quota.current ?? 0, limit: quota.limit ?? 100_000, plan_tier: "free" });
      }
      if (url.pathname === "/billing/usage") {
        if (quota === "unreachable") throw new Error("network down");
        return Response.json({ recorded: true, id: "evt1" }, 201);
      }
      return new Response("not found", { status: 404 });
    },
  } as unknown as Fetcher;
  return { fetcher, calls };
}

async function makeDO(quota: { allowed: boolean; current?: number; limit?: number } | "unreachable") {
  const r2 = makeR2();
  const ctx = { storage: createDOStorage() };
  const { fetcher: billingWorker, calls } = makeBillingWorker(quota);
  const env = {
    PLATFORM_SECRET: "test",
    KNOWLEDGE_WORKER: { fetch: async () => new Response("{}") } as unknown as Fetcher,
    BILLING_WORKER: billingWorker,
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

function scriptRunAs(doInstance: NaelaoAgentDO, role: string | undefined, extra: { projectId?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", "x-naelao-tenant-id": "tenant1", "x-naelao-user-id": "builder-1" };
  if (role) headers["x-naelao-role"] = role;
  return doInstance.fetch(new Request("http://agent-do/script/run", {
    method: "POST",
    headers,
    body: JSON.stringify({ goal: "help me", spaceId: "space1", agentId: "naelao-agent", apiKey: "", ...extra }),
  }));
}

describe("NaelaoAgentDO /script/run — builder-tier monthly usage gate (P0-3)", () => {
  it("rejects with 402 when the org's monthly llm_tokens quota is exhausted, before any reasoning runs", async () => {
    const { spaceDO, calls } = await makeDO({ allowed: false, current: 150_000, limit: 100_000 });
    const res = await scriptRunAs(spaceDO, "owner");
    expect(res.status).toBe(402);
    const body = await res.json() as { error_code?: string };
    expect(body.error_code).toBe("quota_exceeded");
    expect(calls).toContain("/internal/usage/llm-tokens/check");
  });

  it("does not short-circuit when the org is within quota", async () => {
    const { spaceDO } = await makeDO({ allowed: true, current: 500, limit: 100_000 });
    const res = await scriptRunAs(spaceDO, "owner");
    expect(res.status).not.toBe(402);
  });

  it("applies to admin/editor/viewer roles too, not just owner", async () => {
    for (const role of ["admin", "editor", "viewer"]) {
      const { spaceDO } = await makeDO({ allowed: false });
      const res = await scriptRunAs(spaceDO, role);
      expect(res.status).toBe(402);
    }
  });

  it("does not apply to a product_end_user caller (that's the separate end-user credit gate)", async () => {
    const { spaceDO, calls } = await makeDO({ allowed: false });
    const res = await scriptRunAs(spaceDO, "product_end_user");
    expect(res.status).not.toBe(402);
    expect(calls).not.toContain("/internal/usage/llm-tokens/check");
  });

  it("does not apply to a project-scoped run (the wallet gate covers that path instead)", async () => {
    const { spaceDO, calls } = await makeDO({ allowed: false });
    const res = await scriptRunAs(spaceDO, "owner", { projectId: "proj1" });
    // Falls through to whatever the project-scoped gates decide (not this gate specifically).
    expect(calls).not.toContain("/internal/usage/llm-tokens/check");
  });

  it("does not apply to an internal/system call with no role header at all", async () => {
    const { spaceDO, calls } = await makeDO({ allowed: false });
    const res = await scriptRunAs(spaceDO, undefined);
    expect(res.status).not.toBe(402);
    expect(calls).not.toContain("/internal/usage/llm-tokens/check");
  });

  it("fails OPEN only on a transient billing-service error (never blocks on a network hiccup)", async () => {
    const { spaceDO } = await makeDO("unreachable");
    const res = await scriptRunAs(spaceDO, "owner");
    expect(res.status).not.toBe(402);
  });

  it("degrades honestly (never blocks) when BILLING_WORKER is unbound", async () => {
    const r2 = makeR2();
    const ctx = { storage: createDOStorage() };
    const env = {
      PLATFORM_SECRET: "test",
      KNOWLEDGE_WORKER: { fetch: async () => new Response("{}") } as unknown as Fetcher,
      SCRIPTS_R2: r2,
    };
    const spaceDO = new NaelaoAgentDO(ctx as never, env as never);
    await writeAgentConfig(r2, "space1", "naelao-agent", {
      agentsMd: "# Agent",
      systemPrompt: "You are a helpful assistant.",
      scripts: { prebuilt: ["notifications"], agent_scripts: "auto", startup_observe: "observe_filesystem" },
      skills: { skills: [] },
    });
    const res = await scriptRunAs(spaceDO, "owner");
    expect(res.status).not.toBe(402);
  });
});
