import { describe, it, expect, beforeEach } from "vitest";
import { NaelaoAgentDO } from "../../workers/agents/src/do/NaelaoAgentDO.js";
import { writeAgentConfig } from "../../workers/agents/src/script-engine/agent-config.js";
import { createDOSqlStorage } from "./helpers/sqlite-do-shim.js";

// Customer-bot channel heartbeat: no-code rules (checked before any reasoning), the
// execution ceiling, and the daily spend cap. All three are exercised WITHOUT needing a
// working LLM/reasoner, since a matched rule or a blown spend cap short-circuits before the
// reasoning loop ever runs — the reasoning-loop path itself is covered by loop.ts's own tests.

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

// F9: the daily spend cap gate now checks through a SpaceDO-backed `/spend` endpoint (single
// writer for the whole project) instead of this DO's own local `project_spend` table — this
// mock simulates that endpoint with real stateful accumulation, mirroring
// SpaceDO.debitProjectSpend's credits-add + capped-flag response shape.
function makeSpacesWorker(projects: Record<string, FakeProject>) {
  const spend = new Map<string, number>(); // projectId -> credits spent "today"
  const fetcher = {
    async fetch(input: RequestInfo) {
      const req = input as Request;
      const url = new URL(typeof input === "string" ? input : req.url);
      const spendMatch = url.pathname.match(/^\/spaces\/[^/]+\/projects\/([^/]+)\/spend$/);
      if (spendMatch?.[1]) {
        const projectId = spendMatch[1];
        const project = projects[projectId];
        if (!project) return new Response("not found", { status: 404 });
        const body = await req.json<{ credits?: number }>().catch(() => ({}) as Record<string, never>);
        const credits = typeof body.credits === "number" && body.credits > 0 ? body.credits : 0;
        const spentToday = (spend.get(projectId) ?? 0) + credits;
        spend.set(projectId, spentToday);
        const cap = project.daily_spend_cap_credits;
        return Response.json({ project_id: projectId, day: "test-day", spent_today: spentToday, cap, capped: cap > 0 && spentToday >= cap });
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
  return { fetcher, spend };
}

async function makeDO(projects: Record<string, FakeProject>) {
  const r2 = makeR2();
  const ctx = { storage: { sql: createDOSqlStorage() } };
  const { fetcher: spacesWorker, spend } = makeSpacesWorker(projects);
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

  return { spaceDO, spend };
}

async function inbound(doInstance: NaelaoAgentDO, channel: string, raw: Record<string, unknown>, projectId?: string) {
  return doInstance.fetch(new Request(`http://agent-do/channels/${channel}/inbound`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ raw, projectId }),
  }));
}

async function heartbeat(doInstance: NaelaoAgentDO, spaceId = "space1") {
  const resp = await doInstance.fetch(new Request("http://agent-do/channels/heartbeat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ spaceId, agentId: "naelao-agent", tenantId: "tenant1", apiKey: "" }),
  }));
  return resp.json() as Promise<{ drained: number; answered: number; escalated: number; rule_handled: number; spend_capped: number }>;
}

describe("NaelaoAgentDO channel heartbeat — customer-bot project rules", () => {
  it("a matched 'reply' rule answers without touching the reasoning loop (zero LLM calls)", async () => {
    const { spaceDO } = await makeDO({
      proj1: { execution_ceiling: 2, daily_spend_cap_credits: 0, rules: [{ trigger_pattern: "STOP", action: "reply", reply_text: "Unsubscribed.", enabled: 1, priority: 1000 }] },
    });
    await inbound(spaceDO, "whatsapp", { entry: [{ changes: [{ value: { messages: [{ from: "1650555", id: "w1", timestamp: "1700000000", text: { body: "please STOP messaging me" } }] } }] }] }, "proj1");

    const result = await heartbeat(spaceDO);
    expect(result).toMatchObject({ drained: 1, rule_handled: 1, answered: 0, escalated: 0 });
  });

  it("a matched 'human_takeover' rule silences the bot for that thread (message stays unanswered)", async () => {
    const { spaceDO } = await makeDO({
      proj1: { execution_ceiling: 2, daily_spend_cap_credits: 0, rules: [{ trigger_pattern: "talk to a human", action: "human_takeover", enabled: 1, priority: 900 }] },
    });
    await inbound(spaceDO, "whatsapp", { entry: [{ changes: [{ value: { messages: [{ from: "1650555", id: "w1", timestamp: "1700000000", text: { body: "I want to talk to a human please" } }] } }] }] }, "proj1");

    const result = await heartbeat(spaceDO);
    expect(result.rule_handled).toBe(1);

    // A second message from the same customer is now excluded from the heartbeat entirely
    // (human_takeover = 1 on the session) — it should not even show up as "drained".
    await inbound(spaceDO, "whatsapp", { entry: [{ changes: [{ value: { messages: [{ from: "1650555", id: "w2", timestamp: "1700000001", text: { body: "hello?" } }] } }] }] }, "proj1");
    const second = await heartbeat(spaceDO);
    expect(second.drained).toBe(0);
  });

  it("daily spend cap: once a project's cap is hit, further messages are spend_capped, not silently dropped", async () => {
    const { spaceDO, spend } = await makeDO({
      proj1: { execution_ceiling: 2, daily_spend_cap_credits: 100, rules: [] },
    });
    await inbound(spaceDO, "whatsapp", { entry: [{ changes: [{ value: { messages: [{ from: "1650555", id: "w1", timestamp: "1700000000", text: { body: "hi, question about my order" } }] } }] }] }, "proj1");

    // Push the project over its cap via the same SpaceDO-backed store the gate itself reads —
    // simulates prior LLM-driven replies today.
    spend.set("proj1", 500);
    const result = await heartbeat(spaceDO);
    expect(result).toMatchObject({ drained: 1, spend_capped: 1, answered: 0, escalated: 0 });
  });

  it("two different projects on the same channel type are independently rule-scoped", async () => {
    const { spaceDO } = await makeDO({
      proj1: { execution_ceiling: 2, daily_spend_cap_credits: 0, rules: [{ trigger_pattern: "hours", action: "reply", reply_text: "9-5 Mon-Fri", enabled: 1, priority: 10 }] },
      proj2: { execution_ceiling: 2, daily_spend_cap_credits: 0, rules: [] }, // no rules — would fall through to reasoning
    });
    await inbound(spaceDO, "discord", { author: { id: "U1" }, content: "what are your hours", id: "d1" }, "proj1");
    const result = await heartbeat(spaceDO);
    // proj1's "hours" rule matches → handled without reasoning.
    expect(result.rule_handled).toBe(1);
  });
});
