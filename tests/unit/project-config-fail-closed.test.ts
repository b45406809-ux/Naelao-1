import { describe, it, expect } from "vitest";
import { NaelaoAgentDO } from "../../workers/agents/src/do/NaelaoAgentDO.js";
import { writeAgentConfig } from "../../workers/agents/src/script-engine/agent-config.js";
import { createDOSqlStorage } from "./helpers/sqlite-do-shim.js";

// F17 / appendix A1.13: NaelaoAgentDO.fetchProjectConfig previously collapsed "no project
// config row" (a clean 404 — permissive is correct) and "SpaceDO fetch failed" (5xx/network
// error) into the same `null` value. Both handleScriptRun and handleChannelHeartbeat treated a
// null config as "no restrictions", so a transient SpaceDO outage silently disabled BOTH
// structural customer-bot controls (execution ceiling AND daily spend cap) that A1.13 requires
// to be un-bypassable. Fixed: fetchProjectConfig now returns a found/not_found/error union;
// only "error" fails closed (clamp to the most restrictive tier, treat as spend-capped) — a
// clean 404 stays exactly as permissive as before.

function makeR2(): R2Bucket {
  const store = new Map<string, string>();
  const bucket = {
    async put(key: string, value: unknown) {
      const text = typeof value === "string"
        ? value
        : value instanceof Uint8Array
          ? new TextDecoder().decode(value)
          : value instanceof ArrayBuffer
            ? new TextDecoder().decode(value)
            : String(value);
      store.set(key, text);
      return {} as R2Object;
    },
    async get(key: string) {
      if (!store.has(key)) return null;
      const text = store.get(key)!;
      const bytes = new TextEncoder().encode(text);
      return {
        size: bytes.byteLength,
        etag: "test-etag",
        uploaded: new Date(),
        async arrayBuffer() { return bytes.slice().buffer; },
        async text() { return text; },
        get body() { return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }); },
      } as unknown as R2ObjectBody;
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

async function makeDO(spacesWorker: Fetcher) {
  const r2 = makeR2();
  const ctx = { storage: { sql: createDOSqlStorage() } };
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
  return spaceDO;
}

async function scriptRun(doInstance: NaelaoAgentDO, projectId: string) {
  return doInstance.fetch(new Request("http://agent-do/script/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ goal: "help the customer", spaceId: "space1", agentId: "naelao-agent", tenantId: "tenant1", projectId, apiKey: "" }),
  }));
}

async function inbound(doInstance: NaelaoAgentDO, projectId: string) {
  return doInstance.fetch(new Request("http://agent-do/channels/whatsapp/inbound", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      raw: { entry: [{ changes: [{ value: { messages: [{ from: "1650555", id: "w1", timestamp: "1700000000", text: { body: "hi, question about my order" } }] } }] }] },
      projectId,
    }),
  }));
}

async function heartbeat(doInstance: NaelaoAgentDO) {
  const resp = await doInstance.fetch(new Request("http://agent-do/channels/heartbeat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ spaceId: "space1", agentId: "naelao-agent", tenantId: "tenant1", apiKey: "" }),
  }));
  return resp.json() as Promise<{ drained: number; answered: number; escalated: number; rule_handled: number; spend_capped: number }>;
}

describe("F17: fetchProjectConfig fails CLOSED on error, stays permissive on a clean 404", () => {
  describe("handleScriptRun", () => {
    it("a network error fetching project policy rejects the run with an unavailable-policy response, not unrestricted", async () => {
      const spacesWorker = {
        async fetch(input: RequestInfo) {
          const url = new URL(typeof input === "string" ? input : (input as Request).url);
          if (/\/model-policy$/.test(url.pathname)) return Response.json({ policy: null });
          if (url.pathname === "/internal/pricing-catalog") return Response.json({ external_revenue_cut: { enabled: false } });
          if (url.pathname === "/internal/business-subscription-status") return Response.json({ gated: false, active: true, reason: "" });
          if (/^\/spaces\/[^/]+\/projects\/[^/]+$/.test(url.pathname)) throw new Error("network down");
          return new Response("not found", { status: 404 });
        },
      } as unknown as Fetcher;
      const spaceDO = await makeDO(spacesWorker);

      const res = await scriptRun(spaceDO, "proj1");
      expect(res.status).toBe(429);
      const body = (await res.json()) as { error_code?: string };
      expect(body.error_code).toBe("spend_capped");
    });

    it("a 5xx from the project config endpoint also fails closed (not just a thrown network error)", async () => {
      const spacesWorker = {
        async fetch(input: RequestInfo) {
          const url = new URL(typeof input === "string" ? input : (input as Request).url);
          if (/\/model-policy$/.test(url.pathname)) return Response.json({ policy: null });
          if (url.pathname === "/internal/pricing-catalog") return Response.json({ external_revenue_cut: { enabled: false } });
          if (url.pathname === "/internal/business-subscription-status") return Response.json({ gated: false, active: true, reason: "" });
          if (/^\/spaces\/[^/]+\/projects\/[^/]+$/.test(url.pathname)) return new Response("boom", { status: 500 });
          return new Response("not found", { status: 404 });
        },
      } as unknown as Fetcher;
      const spaceDO = await makeDO(spacesWorker);

      const res = await scriptRun(spaceDO, "proj1");
      expect(res.status).toBe(429);
      const body = (await res.json()) as { error_code?: string };
      expect(body.error_code).toBe("spend_capped");
    });

    it("a clean 404 (no project config row) stays permissive — falls through past the gate, never 429s as spend_capped", async () => {
      const spacesWorker = {
        async fetch() {
          return new Response("not found", { status: 404 });
        },
      } as unknown as Fetcher;
      const spaceDO = await makeDO(spacesWorker);

      const res = await scriptRun(spaceDO, "proj1");
      // Not 429 — falls through to the reasoning loop (which itself fails/500s in this minimal
      // test env with no real LLM gateway). The point is the project-config gate specifically
      // did not short-circuit it, unlike the error cases above.
      expect(res.status).not.toBe(429);
    });
  });

  describe("handleChannelHeartbeat", () => {
    it("a network error fetching the project config marks pending messages spend_capped, never runs them unrestricted", async () => {
      const spacesWorker = {
        async fetch(input: RequestInfo) {
          const url = new URL(typeof input === "string" ? input : (input as Request).url);
          if (/\/model-policy$/.test(url.pathname)) return Response.json({ policy: null });
          if (/\/rules$/.test(url.pathname)) return Response.json({ data: [], count: 0 });
          if (/^\/spaces\/[^/]+\/projects\/[^/]+$/.test(url.pathname)) throw new Error("network down");
          return new Response("not found", { status: 404 });
        },
      } as unknown as Fetcher;
      const spaceDO = await makeDO(spacesWorker);
      await inbound(spaceDO, "proj1");

      const result = await heartbeat(spaceDO);
      expect(result).toMatchObject({ drained: 1, spend_capped: 1, answered: 0, escalated: 0, rule_handled: 0 });
    });

    it("a clean 404 (no project config row) stays permissive — the message falls through to the reasoning loop, not spend_capped", async () => {
      const spacesWorker = {
        async fetch(input: RequestInfo) {
          const url = new URL(typeof input === "string" ? input : (input as Request).url);
          if (/\/model-policy$/.test(url.pathname)) return Response.json({ policy: null });
          if (/\/rules$/.test(url.pathname)) return Response.json({ data: [], count: 0 });
          return new Response("not found", { status: 404 });
        },
      } as unknown as Fetcher;
      const spaceDO = await makeDO(spacesWorker);
      await inbound(spaceDO, "proj1");

      const result = await heartbeat(spaceDO);
      expect(result.spend_capped).toBe(0);
    });

    it("a rule-triggered run_script action also fails closed on a project config error, rather than running unrestricted", async () => {
      const spacesWorker = {
        async fetch(input: RequestInfo) {
          const url = new URL(typeof input === "string" ? input : (input as Request).url);
          if (/\/model-policy$/.test(url.pathname)) return Response.json({ policy: null });
          if (/\/rules$/.test(url.pathname)) {
            return Response.json({
              data: [{ id: "r1", trigger_pattern: "hi", action: "run_script", reply_text: null, script_name: "some-script", enabled: 1, priority: 10 }],
              count: 1,
            });
          }
          if (/^\/spaces\/[^/]+\/projects\/[^/]+$/.test(url.pathname)) throw new Error("network down");
          return new Response("not found", { status: 404 });
        },
      } as unknown as Fetcher;
      const spaceDO = await makeDO(spacesWorker);
      await inbound(spaceDO, "proj1");

      const result = await heartbeat(spaceDO);
      // The rule matched ("hi" is a substring of the message text), but the project-config
      // error must short-circuit BEFORE the rule's run_script action ever executes — counted
      // as spend_capped, not rule_handled.
      expect(result).toMatchObject({ drained: 1, spend_capped: 1, rule_handled: 0 });
    });
  });
});
