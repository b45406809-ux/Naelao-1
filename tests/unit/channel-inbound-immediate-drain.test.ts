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
  const store = new Map<string, { text: string; etag: string; customMetadata: Record<string, string> }>();
  let revision = 0;
  const bucket = {
    async put(key: string, value: unknown, options?: { customMetadata?: Record<string, string> }) {
      const text = typeof value === "string" ? value : value instanceof Uint8Array ? new TextDecoder().decode(value) : String(value);
      const etag = String(++revision);
      store.set(key, { text, etag, customMetadata: options?.customMetadata ?? {} });
      return { etag } as R2Object;
    },
    async get(key: string) {
      const row = store.get(key);
      if (!row) return null;
      const bytes = new TextEncoder().encode(row.text);
      return { size: bytes.byteLength, uploaded: new Date(), async text() { return row.text; }, async arrayBuffer() { return bytes.slice().buffer; }, get body() { return row.text; } } as unknown as R2ObjectBody;
    },
    async head(key: string) {
      const row = store.get(key);
      return row ? ({ etag: row.etag, customMetadata: row.customMetadata } as unknown as R2Object) : null;
    },
    async delete(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
    },
    async list(opts?: { prefix?: string }) {
      const prefix = opts?.prefix ?? "";
      const objects = [...store.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ key: k, size: store.get(k)!.text.length, uploaded: new Date(), etag: store.get(k)!.etag }));
      return { objects, truncated: false, cursor: undefined } as unknown as R2Objects;
    },
  };
  return bucket as unknown as R2Bucket;
}

interface FakeProject {
  execution_ceiling: number;
  daily_spend_cap_credits: number;
}

function makeSpacesWorker(projects: Record<string, FakeProject>) {
  const fetcher = {
    async fetch(input: RequestInfo) {
      const req = input as Request;
      const url = new URL(typeof input === "string" ? input : req.url);
      const projectMatch = url.pathname.match(/^\/spaces\/[^/]+\/projects\/([^/]+)$/);
      if (projectMatch) {
        const [, projectId] = projectMatch;
        const project = projects[projectId!];
        if (!project) return new Response("not found", { status: 404 });
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

function emailInbound(doInstance: NaelaoAgentDO, taskId: string) {
  return doInstance.fetch(new Request("http://agent-do/channels/email/inbound", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ raw: { from: "vendor@example.net", text: "Reply for the task", message_id: "email-1" }, taskId }),
  }));
}

function heartbeat(doInstance: NaelaoAgentDO, spaceId = "space1") {
  return doInstance.fetch(new Request("http://agent-do/channels/heartbeat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ spaceId, agentId: "naelao-agent", tenantId: "tenant1", apiKey: "" }),
  })).then((r) => r.json() as Promise<{ drained: number; answered: number; escalated: number }>);
}

const whatsappMsg = (from: string, id: string, text: string) => ({
  entry: [{ changes: [{ value: { messages: [{ from, id, timestamp: "1700000000", text: { body: text } }] } }] }],
});

describe("handleChannelInbound — immediate drain (P0-1)", () => {
  it("persists task-scoped email routing on the channel inbox record", async () => {
    const { spaceDO } = await makeDO({});
    const response = await emailInbound(spaceDO, "run-email-1");
    expect(response.status).toBe(200);
    const inbox = await spaceDO.fetch(new Request("http://agent-do/channels/unanswered"));
    const body = await inbox.json() as { pending: Array<{ task_id?: string; text: string }> };
    expect(body.pending[0]?.task_id).toBe("run-email-1");
    expect(body.pending[0]?.text).toContain("Reply for the task");
  });

  it("an unbound channel message is immediately held for a human without a built-in responder", async () => {
    const { spaceDO, waitUntilPromises } = await makeDO({
      proj1: { execution_ceiling: 2, daily_spend_cap_credits: 0 },
    });
    const res = await inbound(spaceDO, whatsappMsg("165", "w1", "what are your hours"), { projectId: "proj1", spaceId: "space1", tenantId: "tenant1" });
    expect(res.status).toBe(200);

    // The immediate drain is kicked via ctx.waitUntil — await it directly (the fake ctx above
    // captures it) rather than sleeping, then confirm no separate heartbeat call was needed.
    await Promise.all(waitUntilPromises);

    const again = await heartbeat(spaceDO);
    expect(again.drained).toBe(0); // already escalated by the immediate drain, nothing left queued
    const sessions = await spaceDO.fetch(new Request("http://agent-do/channels/unanswered"));
    expect(sessions.status).toBe(200);
  });

  it("does not attempt an immediate drain when spaceId/tenantId are absent (unaffected legacy call shape)", async () => {
    const { spaceDO, waitUntilPromises } = await makeDO({
      proj1: { execution_ceiling: 2, daily_spend_cap_credits: 0 },
    });
    await inbound(spaceDO, whatsappMsg("165", "w1", "what are your hours"), { projectId: "proj1" });
    expect(waitUntilPromises).toHaveLength(0);

    // Still drainable by an explicit heartbeat call, exactly as before this change.
    const result = await heartbeat(spaceDO);
    expect(result.escalated).toBe(1);
  });

  it("two overlapping handleChannelHeartbeat invocations never double-process the same message", async () => {
    const { spaceDO } = await makeDO({
      proj1: { execution_ceiling: 2, daily_spend_cap_credits: 0 },
    });
    await inbound(spaceDO, whatsappMsg("165", "w1", "what are your hours"), { projectId: "proj1" });

    // handleChannelHeartbeat's SELECT + claim UPDATE run synchronously before its first await
    // (loadAgentConfig), so firing two calls back-to-back without awaiting the first one in
    // between deterministically reproduces the same interleaving a real concurrent immediate
    // drain + cron sweep (or two simultaneous immediate drains) would hit.
    const [first, second] = await Promise.all([heartbeat(spaceDO), heartbeat(spaceDO)]);
    const combined = { drained: first.drained + second.drained, escalated: first.escalated + second.escalated };
    expect(combined).toEqual({ drained: 1, escalated: 1 }); // exactly once, not twice
  });

  it("a message left unresolved (spend-capped) reverts its claim so it's retryable, not lost", async () => {
    const { spaceDO } = await makeDO({
      proj1: { execution_ceiling: 2, daily_spend_cap_credits: 100 },
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
