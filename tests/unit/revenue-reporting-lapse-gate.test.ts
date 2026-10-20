import { describe, it, expect } from "vitest";
import { NaelaoAgentDO } from "../../workers/agents/src/do/NaelaoAgentDO.js";
import { writeAgentConfig } from "../../workers/agents/src/script-engine/agent-config.js";
import { createDOStorage } from "./helpers/sqlite-do-shim.js";
import { makeR2Bucket } from "./helpers/r2-bucket.js";

// Go-live monetization pass: a business that opted into revenue-cut billing but stopped
// reporting its tracked Whop revenue (credential revoked/broken) could otherwise run its agent
// indefinitely with no consequence — a ToS-only "must keep it connected" clause nobody enforces.
// This proves handleScriptRun rejects BOTH project-scoped and Space-Assistant runs once reporting
// has lapsed, never gates a business that hasn't opted in or has zero tracking history yet (only
// a PREVIOUSLY-connected-then-lapsed business is gated), and degrades honestly on any lookup error.

function makeR2(): R2Bucket { return makeR2Bucket(); }

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

function makeSpacesWorker(opts: { cutEnabled?: boolean; lastTrackedAt?: string | null; unreachable?: boolean }) {
  const { cutEnabled = true, lastTrackedAt = null, unreachable = false } = opts;
  const fetcher = {
    async fetch(input: RequestInfo) {
      if (unreachable) throw new Error("network down");
      const req = input as Request;
      const url = new URL(typeof input === "string" ? input : req.url);
      if (url.pathname.endsWith("/model-policy")) return Response.json({ policy: null });
      if (/\/spaces\/[^/]+\/projects\/[^/]+$/.test(url.pathname)) return new Response("not found", { status: 404 });
      if (url.pathname === "/internal/pricing-catalog") {
        return Response.json({ external_revenue_cut: { enabled: cutEnabled, cutBps: 500 } });
      }
      if (url.pathname.endsWith("/revenue-tracking")) {
        return Response.json({ last_tracked_at: lastTrackedAt });
      }
      // Everything else (project config lookups, etc.) — behave as "not found" so the rest of
      // handleScriptRun's own gates degrade to their own permissive defaults.
      return new Response("not found", { status: 404 });
    },
  } as unknown as Fetcher;
  return fetcher;
}

async function makeDO(spacesWorker: Fetcher) {
  const r2 = makeR2();
  const ctx = { storage: createDOStorage() };
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
  return spaceDO;
}

function scriptRun(doInstance: NaelaoAgentDO, extra: { projectId?: string } = {}) {
  return doInstance.fetch(new Request("http://agent-do/script/run", {
    method: "POST",
    headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant1" },
    body: JSON.stringify({ goal: "help me", spaceId: "space1", agentId: "naelao-agent", apiKey: "", ...extra }),
  }));
}

describe("NaelaoAgentDO /script/run — revenue reporting lapse gate", () => {
  it("rejects with 403 when a previously-connected business's reporting has lapsed (> 45 days)", async () => {
    const spaceDO = await makeDO(makeSpacesWorker({ cutEnabled: true, lastTrackedAt: daysAgo(60) }));
    const res = await scriptRun(spaceDO);
    expect(res.status).toBe(403);
    const body = await res.json() as { error_code?: string };
    expect(body.error_code).toBe("revenue_reporting_lapsed");
  });

  it("also gates a PROJECT-scoped run, not just the Space Assistant", async () => {
    const spaceDO = await makeDO(makeSpacesWorker({ cutEnabled: true, lastTrackedAt: daysAgo(60) }));
    const res = await scriptRun(spaceDO, { projectId: "proj1" });
    expect(res.status).toBe(403);
  });

  it("does not gate a business still within the reporting window", async () => {
    const spaceDO = await makeDO(makeSpacesWorker({ cutEnabled: true, lastTrackedAt: daysAgo(10) }));
    const res = await scriptRun(spaceDO);
    expect(res.status).not.toBe(403);
  });

  it("does not gate a business that has NEVER tracked (just enabled the feature, hasn't connected yet)", async () => {
    const spaceDO = await makeDO(makeSpacesWorker({ cutEnabled: true, lastTrackedAt: null }));
    const res = await scriptRun(spaceDO);
    expect(res.status).not.toBe(403);
  });

  it("does not gate a business that never opted into revenue-cut billing at all", async () => {
    const spaceDO = await makeDO(makeSpacesWorker({ cutEnabled: false, lastTrackedAt: daysAgo(200) }));
    const res = await scriptRun(spaceDO);
    expect(res.status).not.toBe(403);
  });

  it("fails OPEN on a transient lookup error (never blocks on a network hiccup)", async () => {
    const spaceDO = await makeDO(makeSpacesWorker({ unreachable: true }));
    const res = await scriptRun(spaceDO);
    expect(res.status).not.toBe(403);
  });

  it("degrades honestly (never blocks) when SPACES_WORKER is unbound", async () => {
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
    const res = await scriptRun(spaceDO);
    expect(res.status).not.toBe(403);
  });
});
