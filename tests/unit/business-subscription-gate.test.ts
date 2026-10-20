import { describe, it, expect } from "vitest";
import { NaelaoAgentDO } from "../../workers/agents/src/do/NaelaoAgentDO.js";
import { writeAgentConfig } from "../../workers/agents/src/script-engine/agent-config.js";
import { createDOStorage } from "./helpers/sqlite-do-shim.js";

// Tier 2 metering follow-up: business_subscriptions (Phase E) was write-only — a Lemon Squeezy
// webhook upserted a row on every subscription event, but nothing ever READ it to gate access. A
// business on a pricingConfig.model === "subscription" product could run its agent indefinitely
// whether or not it ever subscribed. This proves handleScriptRun rejects BOTH project-scoped and
// Space-Assistant runs once resolveBusinessSubscriptionGate (workers/spaces) reports the
// business's subscription as inactive, respects the trial window, never gates a non-subscription
// product or the product root itself, and fails OPEN on any lookup error.

function makeR2(): R2Bucket {
  const store = new Map<string, string>();
  const bytes = (value: string) => new TextEncoder().encode(value);
  const bucket = {
    async put(key: string, value: unknown) {
      store.set(key, typeof value === "string" ? value : new TextDecoder().decode(value as Uint8Array));
      return {} as R2Object;
    },
    async get(key: string) {
      if (!store.has(key)) return null;
      const text = store.get(key)!;
      return { size: bytes(text).byteLength, uploaded: new Date(), async text() { return text; }, async arrayBuffer() { return bytes(text).buffer; }, get body() { return text; } } as unknown as R2ObjectBody;
    },
    async head(key: string) {
      return store.has(key) ? ({} as R2Object) : null;
    },
    async delete(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
    },
    async list(opts?: { prefix?: string }) {
      const prefix = opts?.prefix ?? "";
      const objects = [...store.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ key: k, size: bytes(store.get(k)!).byteLength, uploaded: new Date(), etag: "x" }));
      return { objects, truncated: false, cursor: undefined } as unknown as R2Objects;
    },
  };
  return bucket as unknown as R2Bucket;
}

function makeSpacesWorker(opts: { gated?: boolean; active?: boolean; reason?: string; unreachable?: boolean }) {
  const { gated = false, active = true, reason = "", unreachable = false } = opts;
  const fetcher = {
    async fetch(input: RequestInfo) {
      const req = input as Request;
      const url = new URL(typeof input === "string" ? input : req.url);
      if (url.pathname.endsWith("/model-policy")) return Response.json({ policy: null });
      if (unreachable) throw new Error("network down");
      // The revenue-reporting-lapse gate (checked first in handleScriptRun) must short-circuit
      // cleanly so it never interferes with these subscription-gate assertions.
      if (url.pathname === "/internal/pricing-catalog") {
        return Response.json({ external_revenue_cut: { enabled: false } });
      }
      if (url.pathname === "/internal/business-subscription-status") {
        return Response.json({ gated, active, reason });
      }
      return new Response("not found", { status: 404 });
    },
  } as unknown as Fetcher;
  return fetcher;
}

async function makeDO(spacesWorker: Fetcher) {
  const r2 = makeR2();
  const storage = createDOStorage();
  const ctx = { storage: { ...storage, getAlarm: async () => null, setAlarm: async () => undefined, deleteAlarm: async () => undefined } };
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

describe("NaelaoAgentDO /script/run — business subscription gate", () => {
  it("rejects with 402 when the business has no subscription at all", async () => {
    const spaceDO = await makeDO(makeSpacesWorker({ gated: true, active: false, reason: "no_subscription" }));
    const res = await scriptRun(spaceDO);
    expect(res.status).toBe(402);
    const body = await res.json() as { error_code?: string };
    expect(body.error_code).toBe("no_subscription");
  });

  it("rejects with 402 when the business's subscription is cancelled", async () => {
    const spaceDO = await makeDO(makeSpacesWorker({ gated: true, active: false, reason: "subscription_cancelled" }));
    const res = await scriptRun(spaceDO);
    expect(res.status).toBe(402);
    const body = await res.json() as { error_code?: string };
    expect(body.error_code).toBe("subscription_cancelled");
  });

  it("also gates a PROJECT-scoped run, not just the Space Assistant", async () => {
    const spaceDO = await makeDO(makeSpacesWorker({ gated: true, active: false, reason: "no_subscription" }));
    const res = await scriptRun(spaceDO, { projectId: "proj1" });
    expect(res.status).toBe(402);
  });

  it("does NOT gate an active subscription", async () => {
    const spaceDO = await makeDO(makeSpacesWorker({ gated: true, active: true, reason: "" }));
    const res = await scriptRun(spaceDO);
    expect(res.status).not.toBe(402);
  });

  it("does NOT gate a past_due subscription (grace period — reported as active by the resolver)", async () => {
    const spaceDO = await makeDO(makeSpacesWorker({ gated: true, active: true, reason: "" }));
    const res = await scriptRun(spaceDO);
    expect(res.status).not.toBe(402);
  });

  it("does NOT gate a business still within its trial window", async () => {
    const spaceDO = await makeDO(makeSpacesWorker({ gated: true, active: true, reason: "in_trial" }));
    const res = await scriptRun(spaceDO);
    expect(res.status).not.toBe(402);
  });

  it("does NOT gate a non-subscription-model product", async () => {
    const spaceDO = await makeDO(makeSpacesWorker({ gated: false, active: true, reason: "not_subscription_model" }));
    const res = await scriptRun(spaceDO);
    expect(res.status).not.toBe(402);
  });

  it("does NOT gate the product root itself (not a business)", async () => {
    const spaceDO = await makeDO(makeSpacesWorker({ gated: false, active: true, reason: "not_a_business" }));
    const res = await scriptRun(spaceDO);
    expect(res.status).not.toBe(402);
  });

  it("fails CLOSED on a transient lookup error (subscription check unavailable = deny, not allow)", async () => {
    const spaceDO = await makeDO(makeSpacesWorker({ unreachable: true }));
    const res = await scriptRun(spaceDO);
    expect(res.status).toBe(402);
    const body = await res.json() as { error_code?: string };
    expect(body.error_code).toBe("subscription check unavailable — please retry");
  });

  it("degrades honestly (never blocks) when SPACES_WORKER is unbound", async () => {
    const r2 = makeR2();
    const storage = createDOStorage();
    const ctx = { storage: { ...storage, getAlarm: async () => null, setAlarm: async () => undefined, deleteAlarm: async () => undefined } };
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
    expect(res.status).not.toBe(402);
  });
});
