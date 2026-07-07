import { describe, it, expect } from "vitest";
import { NaelaoAgentDO } from "../../workers/agents/src/do/NaelaoAgentDO.js";
import { writeAgentConfig } from "../../workers/agents/src/script-engine/agent-config.js";
import { createDOSqlStorage } from "./helpers/sqlite-do-shim.js";

// P0-2: handleScriptRun (a direct /script/run call against a project) already had a pre-run
// wallet gate — but the customer-bot channel drain (handleChannelHeartbeat), the ACTUAL workload
// a WhatsApp/Slack/Discord/email customer-bot project runs, did not. A project with no
// daily_spend_cap_credits configured (the common case — it's an OPTIONAL rate-limit ceiling, not
// a payer) ran its real reasoning-loop LLM cost on the platform's Anthropic key with zero payer.
// This proves the wallet check now applies to the heartbeat drain too, independent of whether a
// spend cap is configured, while never blocking no-code rule replies / human_takeover (those must
// never depend on the business having money).

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

interface FakeProject {
  execution_ceiling: number;
  daily_spend_cap_credits: number;
  rules: Array<{ trigger_pattern: string; action: string; reply_text?: string; script_name?: string; enabled: number; priority: number }>;
}

type WalletState = { projectId: string | null; balanceCents: number | "unreachable" };

function makeSpacesWorker(projects: Record<string, FakeProject>, wallet: WalletState) {
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
      const projectMatch = url.pathname.match(/^\/spaces\/[^/]+\/projects\/([^/]+)(\/rules)?$/);
      if (projectMatch) {
        const [, projectId, rulesSuffix] = projectMatch;
        const project = projects[projectId!];
        if (!project) return new Response("not found", { status: 404 });
        if (rulesSuffix) return Response.json({ data: project.rules, count: project.rules.length });
        return Response.json({ execution_ceiling: project.execution_ceiling, daily_spend_cap_credits: project.daily_spend_cap_credits });
      }
      return new Response("not found", { status: 404 });
    },
  } as unknown as Fetcher;
  return fetcher;
}

async function makeDO(projects: Record<string, FakeProject>, wallet: WalletState) {
  const r2 = makeR2();
  const ctx = { storage: { sql: createDOSqlStorage() } };
  const env = {
    PLATFORM_SECRET: "test",
    KNOWLEDGE_WORKER: { fetch: async () => new Response("{}") } as unknown as Fetcher,
    SPACES_WORKER: makeSpacesWorker(projects, wallet),
    SCRIPTS_R2: r2,
  };
  const spaceDO = new NaelaoAgentDO(ctx as never, env as never);

  await writeAgentConfig(r2, "space1", "naelao-agent", {
    agentsMd: "# Agent",
    systemPrompt: "You are a support bot.",
    scripts: { prebuilt: ["notifications"], agent_scripts: "auto", startup_observe: "observe_filesystem" },
    skills: { skills: [] },
  });

  return spaceDO;
}

function inbound(doInstance: NaelaoAgentDO, raw: Record<string, unknown>, projectId?: string) {
  return doInstance.fetch(new Request("http://agent-do/channels/whatsapp/inbound", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ raw, projectId }),
  }));
}

function heartbeat(doInstance: NaelaoAgentDO, spaceId = "space1") {
  return doInstance.fetch(new Request("http://agent-do/channels/heartbeat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ spaceId, agentId: "naelao-agent", tenantId: "tenant1", apiKey: "" }),
  })).then((r) => r.json() as Promise<{ drained: number; answered: number; escalated: number; rule_handled: number; spend_capped: number }>);
}

const whatsappMsg = (from: string, id: string, text: string) => ({
  entry: [{ changes: [{ value: { messages: [{ from, id, timestamp: "1700000000", text: { body: text } }] } }] }],
});

describe("handleChannelHeartbeat — wallet gate (P0-2)", () => {
  it("blocks the reasoning loop with spend_capped when the project's space wallet is empty, even with no daily_spend_cap_credits configured", async () => {
    const spaceDO = await makeDO(
      { proj1: { execution_ceiling: 2, daily_spend_cap_credits: 0, rules: [] } }, // no cap set — the old unmetered case
      { projectId: "wallet1", balanceCents: 0 }
    );
    await inbound(spaceDO, whatsappMsg("165", "w1", "hi, question about my order"), "proj1");
    const result = await heartbeat(spaceDO);
    expect(result).toMatchObject({ drained: 1, spend_capped: 1, answered: 0, escalated: 0 });
  });

  it("does not short-circuit when the wallet is funded", async () => {
    const spaceDO = await makeDO(
      { proj1: { execution_ceiling: 2, daily_spend_cap_credits: 0, rules: [] } },
      { projectId: "wallet1", balanceCents: 1000 }
    );
    await inbound(spaceDO, whatsappMsg("165", "w1", "hi, question about my order"), "proj1");
    const result = await heartbeat(spaceDO);
    expect(result.spend_capped).toBe(0); // falls through to the reasoning loop instead
  });

  it("never blocks a no-code 'reply' rule (e.g. STOP/opt-out) even with an empty wallet", async () => {
    const spaceDO = await makeDO(
      { proj1: { execution_ceiling: 2, daily_spend_cap_credits: 0, rules: [{ trigger_pattern: "STOP", action: "reply", reply_text: "Unsubscribed.", enabled: 1, priority: 1000 }] } },
      { projectId: "wallet1", balanceCents: 0 }
    );
    await inbound(spaceDO, whatsappMsg("165", "w1", "please STOP messaging me"), "proj1");
    const result = await heartbeat(spaceDO);
    expect(result).toMatchObject({ rule_handled: 1, spend_capped: 0 });
  });

  it("never blocks human_takeover routing even with an empty wallet", async () => {
    const spaceDO = await makeDO(
      { proj1: { execution_ceiling: 2, daily_spend_cap_credits: 0, rules: [{ trigger_pattern: "talk to a human", action: "human_takeover", enabled: 1, priority: 900 }] } },
      { projectId: "wallet1", balanceCents: 0 }
    );
    await inbound(spaceDO, whatsappMsg("165", "w1", "I want to talk to a human please"), "proj1");
    const result = await heartbeat(spaceDO);
    expect(result).toMatchObject({ rule_handled: 1, spend_capped: 0 });
  });

  it("does not apply to non-project channel messages (Space Assistant / builder's own channel)", async () => {
    const spaceDO = await makeDO({}, { projectId: "wallet1", balanceCents: 0 });
    await inbound(spaceDO, whatsappMsg("165", "w1", "hello"), undefined);
    const result = await heartbeat(spaceDO);
    expect(result.spend_capped).toBe(0);
  });

  it("degrades honestly (never blocks) when the space has no wallet project at all", async () => {
    const spaceDO = await makeDO(
      { proj1: { execution_ceiling: 2, daily_spend_cap_credits: 0, rules: [] } },
      { projectId: null, balanceCents: 0 }
    );
    await inbound(spaceDO, whatsappMsg("165", "w1", "hi"), "proj1");
    const result = await heartbeat(spaceDO);
    expect(result.spend_capped).toBe(0);
  });

  it("fails OPEN only on a transient wallet-lookup error", async () => {
    const spaceDO = await makeDO(
      { proj1: { execution_ceiling: 2, daily_spend_cap_credits: 0, rules: [] } },
      { projectId: "wallet1", balanceCents: "unreachable" }
    );
    await inbound(spaceDO, whatsappMsg("165", "w1", "hi"), "proj1");
    const result = await heartbeat(spaceDO);
    expect(result.spend_capped).toBe(0);
  });
});
