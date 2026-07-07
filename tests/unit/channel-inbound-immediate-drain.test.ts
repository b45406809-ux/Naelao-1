import { describe, it, expect } from "vitest";
import { NaelaoAgentDO } from "../../workers/agents/src/do/NaelaoAgentDO.js";
import { writeAgentConfig } from "../../workers/agents/src/script-engine/agent-config.js";
import { createDOSqlStorage } from "./helpers/sqlite-do-shim.js";

// P0-1: a WhatsApp/Discord/email customer used to wait up to an hour for a reply — inbound
// messages were only ever drained by the hourly cron heartbeat. handleChannelInbound now kicks
// an immediate drain via ctx.waitUntil the moment a message with spaceId+tenantId arrives.
//
// That change makes concurrent handleChannelHeartbeat invocations on the same DO a real
// possibility for the first time (previously only the hourly cron ever called it, so overlap was
// near-impossible) — so this file also proves the claim step (answered: 0 -> 2, reverted to 0 in
// a per-message `finally` unless a real terminal state was reached) prevents two overlapping
// drains from double-processing the same message.

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

function makeSpacesWorker(projects: Record<string, FakeProject>) {
  const fetcher = {
    async fetch(input: RequestInfo) {
      const req = input as Request;
      const url = new URL(typeof input === "string" ? input : req.url);
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

async function makeDO(projects: Record<string, FakeProject> = {}) {
  const r2 = makeR2();
  const waitUntilPromises: Promise<unknown>[] = [];
  const ctx = {
    storage: { sql: createDOSqlStorage() },
    waitUntil: (p: Promise<unknown>) => { waitUntilPromises.push(p); },
  };
  const env = {
    PLATFORM_SECRET: "test",
    KNOWLEDGE_WORKER: { fetch: async () => new Response("{}") } as unknown as Fetcher,
    SPACES_WORKER: makeSpacesWorker(projects),
    SCRIPTS_R2: r2,
  };
  const spaceDO = new NaelaoAgentDO(ctx as never, env as never);

  await writeAgentConfig(r2, "space1", "naelao-agent", {
    agentsMd: "# Agent",
    systemPrompt: "You are a support bot.",
    scripts: { prebuilt: ["notifications"], agent_scripts: "auto", startup_observe: "observe_filesystem" },
    skills: { skills: [] },
  });

  return { spaceDO, waitUntilPromises };
}

function inbound(doInstance: NaelaoAgentDO, raw: Record<string, unknown>, opts: { projectId?: string; spaceId?: string; tenantId?: string } = {}) {
  return doInstance.fetch(new Request("http://agent-do/channels/whatsapp/inbound", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ raw, ...opts }),
  }));
}

function heartbeat(doInstance: NaelaoAgentDO, spaceId = "space1") {
  return doInstance.fetch(new Request("http://agent-do/channels/heartbeat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ spaceId, agentId: "naelao-agent", tenantId: "tenant1", apiKey: "" }),
  })).then((r) => r.json() as Promise<{ drained: number; answered: number; rule_handled: number }>);
}

const whatsappMsg = (from: string, id: string, text: string) => ({
  entry: [{ changes: [{ value: { messages: [{ from, id, timestamp: "1700000000", text: { body: text } }] } }] }],
});

describe("handleChannelInbound — immediate drain (P0-1)", () => {
  it("a message with spaceId+tenantId is answered without any explicit heartbeat call", async () => {
    const { spaceDO, waitUntilPromises } = await makeDO({
      proj1: { execution_ceiling: 2, daily_spend_cap_credits: 0, rules: [{ trigger_pattern: "hours", action: "reply", reply_text: "9-5 Mon-Fri", enabled: 1, priority: 10 }] },
    });
    const res = await inbound(spaceDO, whatsappMsg("165", "w1", "what are your hours"), { projectId: "proj1", spaceId: "space1", tenantId: "tenant1" });
    expect(res.status).toBe(200);

    // The immediate drain is kicked via ctx.waitUntil — await it directly (the fake ctx above
    // captures it) rather than sleeping, then confirm no separate heartbeat call was needed.
    await Promise.all(waitUntilPromises);

    const again = await heartbeat(spaceDO);
    expect(again.drained).toBe(0); // already answered by the immediate drain, nothing left
  });

  it("does not attempt an immediate drain when spaceId/tenantId are absent (unaffected legacy call shape)", async () => {
    const { spaceDO, waitUntilPromises } = await makeDO({
      proj1: { execution_ceiling: 2, daily_spend_cap_credits: 0, rules: [{ trigger_pattern: "hours", action: "reply", reply_text: "9-5 Mon-Fri", enabled: 1, priority: 10 }] },
    });
    await inbound(spaceDO, whatsappMsg("165", "w1", "what are your hours"), { projectId: "proj1" });
    expect(waitUntilPromises).toHaveLength(0);

    // Still drainable by an explicit heartbeat call, exactly as before this change.
    const result = await heartbeat(spaceDO);
    expect(result.rule_handled).toBe(1);
  });

  it("two overlapping handleChannelHeartbeat invocations never double-process the same message", async () => {
    const { spaceDO } = await makeDO({
      proj1: { execution_ceiling: 2, daily_spend_cap_credits: 0, rules: [{ trigger_pattern: "hours", action: "reply", reply_text: "9-5 Mon-Fri", enabled: 1, priority: 10 }] },
    });
    await inbound(spaceDO, whatsappMsg("165", "w1", "what are your hours"), { projectId: "proj1" });

    // handleChannelHeartbeat's SELECT + claim UPDATE run synchronously before its first await
    // (loadAgentConfig), so firing two calls back-to-back without awaiting the first one in
    // between deterministically reproduces the same interleaving a real concurrent immediate
    // drain + cron sweep (or two simultaneous immediate drains) would hit.
    const [first, second] = await Promise.all([heartbeat(spaceDO), heartbeat(spaceDO)]);
    const combined = { drained: first.drained + second.drained, rule_handled: first.rule_handled + second.rule_handled };
    expect(combined).toEqual({ drained: 1, rule_handled: 1 }); // exactly once, not twice
  });

  it("a message left unresolved (spend-capped) reverts its claim so it's retryable, not lost", async () => {
    const { spaceDO } = await makeDO({
      proj1: { execution_ceiling: 2, daily_spend_cap_credits: 100, rules: [] },
    });
    await inbound(spaceDO, whatsappMsg("165", "w1", "hi, question about my order"), { projectId: "proj1" });

    // First heartbeat: SpaceDO's /spend has no prior spend recorded in this test's minimal
    // mock (route not registered -> 404 -> fails closed as tier-1/spend-capped per the existing
    // fail-closed contract), so the message is neither answered nor claimed forever.
    const first = await heartbeat(spaceDO);
    expect(first.drained).toBe(1);

    // It must still show up on a SECOND sweep — proving the claim (2) was reverted to 0 rather
    // than leaving the message permanently stuck/lost.
    const second = await heartbeat(spaceDO);
    expect(second.drained).toBe(1);
  });
});
