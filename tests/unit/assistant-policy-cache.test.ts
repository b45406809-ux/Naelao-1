// The Space Assistant's approval policy is read once and cached briefly, and a transient failure
// does not discard a policy we just successfully read.
//
// Motivated by a real, reproduced production failure during the live model-matrix run: this fetch
// sits on the hot path of EVERY Space Assistant run, and under concurrent load against the same
// SpaceDO it started failing. Failing closed is correct as a security posture — but the closed
// state is `gate_unless_listed` with an EMPTY allowlist, i.e. gate everything, with no approver
// reachable, so every run died. Runs that worked fine against an idle space came back rejected
// while it was busy, which reads to a user as the assistant simply refusing to work.

import { describe, it, expect } from "vitest";
import { NaelaoAgentDO } from "../../workers/agents/src/do/NaelaoAgentDO.js";
import { writeAgentConfig } from "../../workers/agents/src/script-engine/agent-config.js";
import { createDOSqlStorage } from "./helpers/sqlite-do-shim.js";

function makeR2(): R2Bucket {
  const store = new Map<string, { bytes: Uint8Array; etag: string; customMetadata: Record<string, string>; uploaded: Date }>();
  let revision = 0;
  const bucket = {
    async put(key: string, value: unknown, options?: R2PutOptions) {
      const previous = store.get(key);
      const onlyIf = options?.onlyIf as { etagMatches?: string; etagDoesNotMatch?: string } | undefined;
      if (onlyIf?.etagMatches !== undefined && previous?.etag !== onlyIf.etagMatches) return null;
      if (onlyIf?.etagDoesNotMatch === "*" && previous) return null;
      const bytes = value instanceof Uint8Array ? value : new TextEncoder().encode(typeof value === "string" ? value : String(value));
      const etag = String(++revision);
      store.set(key, { bytes: bytes.slice(), etag, customMetadata: options?.customMetadata ?? {}, uploaded: new Date() });
      return { etag } as R2Object;
    },
    async get(key: string) {
      const item = store.get(key);
      if (!item || item.customMetadata["deleted"] === "true") return null;
      return {
        size: item.bytes.byteLength,
        etag: item.etag,
        uploaded: item.uploaded,
        customMetadata: item.customMetadata,
        async text() { return new TextDecoder().decode(item.bytes); },
        async arrayBuffer() { return item.bytes.slice().buffer; },
      } as unknown as R2ObjectBody;
    },
    async head(key: string) {
      const item = store.get(key);
      return item ? { key, size: item.bytes.byteLength, etag: item.etag, uploaded: item.uploaded, customMetadata: item.customMetadata } as R2Object : null;
    },
    async delete(key: string | string[]) { for (const item of Array.isArray(key) ? key : [key]) store.delete(item); },
    async list(options?: { prefix?: string }) {
      const prefix = options?.prefix ?? "";
      const objects = [...store.entries()].filter(([key, item]) => key.startsWith(prefix) && item.customMetadata["deleted"] !== "true")
        .map(([key, item]) => ({ key, size: item.bytes.byteLength, etag: item.etag, uploaded: item.uploaded, customMetadata: item.customMetadata }));
      return { objects, truncated: false, cursor: undefined } as unknown as R2Objects;
    },
  };
  return bucket as unknown as R2Bucket;
}

/** A spaces worker whose assistant-policy endpoint can be made to start failing mid-test. */
function makeSpacesWorker() {
  const state = { policyCalls: 0, agentPolicyCalls: 0, failPolicy: false, failWith: 500, mode: "yolo" as "yolo" | "always_ask" };
  const fetcher = {
    async fetch(input: RequestInfo) {
      const req = input as Request;
      const url = new URL(typeof input === "string" ? input : req.url);
      if (/\/assistant-policy$/.test(url.pathname)) {
        state.policyCalls++;
        if (state.failPolicy) return new Response("boom", { status: state.failWith });
        return Response.json({ approval_mode: state.mode, auto_approved_actions: ["memory.recall"] });
      }
      if (/\/agents\/[^/]+\/policy$/.test(url.pathname)) {
        state.agentPolicyCalls++;
        return Response.json({ approval_mode: "always_ask", auto_approved_actions: ["knowledge-base.search"], updated_at: "2026-10-20T00:00:00.000Z" });
      }
      return new Response("not found", { status: 404 });
    },
  } as unknown as Fetcher;
  return { fetcher, state };
}

async function makeDO() {
  const r2 = makeR2();
  const ctx = { storage: { sql: createDOSqlStorage() } };
  const { fetcher: spacesWorker, state } = makeSpacesWorker();
  const agentDO = new NaelaoAgentDO(
    ctx as never,
    { PLATFORM_SECRET: "test", SPACES_WORKER: spacesWorker, SCRIPTS_R2: r2 } as never
  );
  await writeAgentConfig(r2, "space1", "naelao-agent", {
    agentsMd: "# Agent",
    systemPrompt: "You are an assistant.",
    scripts: { prebuilt: ["r2-workspace"], agent_scripts: "auto", startup_observe: "observe_filesystem" },
    skills: { skills: [] },
  });
  return { agentDO, state };
}

/** fetchAssistantPolicy is private — exercised through the instance the way the run path does. */
function readPolicy(agentDO: NaelaoAgentDO, spaceId = "space1", tenantId = "tenant1") {
  return (agentDO as unknown as {
    fetchAssistantPolicy(s: string, t: string): Promise<{ approval_mode: string; auto_approved_actions: string[] } | null>;
  }).fetchAssistantPolicy(spaceId, tenantId);
}

function readAgentPolicy(agentDO: NaelaoAgentDO, spaceId = "space1", agentId = "agent-1", tenantId = "tenant1") {
  return (agentDO as unknown as {
    fetchAgentPolicy(s: string, a: string, t: string): Promise<{ approval_mode: string; auto_approved_actions: string[]; updated_at?: string } | null>;
  }).fetchAgentPolicy(spaceId, agentId, tenantId);
}

describe("assistant policy — cached per run, not re-fetched on every one", () => {
  it("hits the spaces worker once for repeated reads of the same space", async () => {
    const { agentDO, state } = await makeDO();
    await readPolicy(agentDO);
    await readPolicy(agentDO);
    await readPolicy(agentDO);
    expect(state.policyCalls).toBe(1);
  });

  it("does not serve one space's policy to another", async () => {
    const { agentDO, state } = await makeDO();
    await readPolicy(agentDO, "space1");
    await readPolicy(agentDO, "space2");
    expect(state.policyCalls).toBe(2);
  });
});

describe("project-agent policy reads", () => {
  it("reads the owner-configured agent override and its policy version from SpaceDO", async () => {
    const { agentDO, state } = await makeDO();
    const policy = await readAgentPolicy(agentDO);
    expect(policy).toEqual({
      approval_mode: "always_ask",
      auto_approved_actions: ["knowledge-base.search"],
      updated_at: "2026-10-20T00:00:00.000Z",
    });
    expect(state.agentPolicyCalls).toBe(1);
  });
});

describe("assistant policy — a transient failure doesn't turn the assistant off", () => {
  it("serves the recently-read policy when the fetch starts failing", async () => {
    const { agentDO, state } = await makeDO();
    const first = await readPolicy(agentDO);
    expect(first?.approval_mode).toBe("yolo");

    // Exactly the live failure: the endpoint starts erroring under load.
    state.failPolicy = true;
    // Force past the cache window so the failing path is genuinely taken.
    (agentDO as unknown as { assistantPolicyCache: { at: number } }).assistantPolicyCache.at = Date.now() - 60_000;

    const during = await readPolicy(agentDO);
    // Before this fix, null here meant "gate everything, reject" — the assistant refusing to work
    // because of an infrastructure blip, not because the owner asked it to.
    expect(during).not.toBeNull();
    expect(during?.approval_mode).toBe("yolo");
  });

  it("fails CLOSED on a 4xx — that is the server answering, not failing", async () => {
    // A definitive "no" (no such space, not permitted) must not be papered over with a cached
    // value; only an unanswered request gets the benefit of the doubt.
    const { agentDO, state } = await makeDO();
    await readPolicy(agentDO);
    state.failPolicy = true;
    state.failWith = 403;
    (agentDO as unknown as { assistantPolicyCache: { at: number } }).assistantPolicyCache.at = Date.now() - 60_000;
    expect(await readPolicy(agentDO)).toBeNull();
  });

  it("still returns null when it has never successfully read a policy", async () => {
    // No cached value to fall back on: fail CLOSED, which is the correct security posture for an
    // unknown policy. The fallback above only ever re-serves something already verified.
    const { agentDO, state } = await makeDO();
    state.failPolicy = true;
    expect(await readPolicy(agentDO)).toBeNull();
  });

  it("retries a cold read once, so one blip doesn't gate the whole conversation", async () => {
    // A DO reading the policy for the FIRST time has no cache to fall back on — a single failed
    // request would gate every action for that entire run. Seen intermittently during the live
    // matrix, where a minority of runs gated actions the policy plainly allows.
    const { agentDO, state } = await makeDO();
    state.failPolicy = true;
    const originalFetch = state.policyCalls;
    // Recover on the second attempt.
    const spaces = (agentDO as unknown as { env: { SPACES_WORKER: Fetcher } }).env.SPACES_WORKER;
    const realFetch = spaces.fetch.bind(spaces);
    let n = 0;
    (spaces as { fetch: typeof realFetch }).fetch = async (input: RequestInfo) => {
      n++;
      if (n === 1) return new Response("boom", { status: 503 });
      state.failPolicy = false;
      return realFetch(input as Request);
    };

    const policy = await readPolicy(agentDO);
    expect(policy?.approval_mode).toBe("yolo");
    expect(n).toBe(2);
    expect(state.policyCalls).toBeGreaterThan(originalFetch);
  });

  it("picks up a real policy change once the cache window passes", async () => {
    const { agentDO, state } = await makeDO();
    expect((await readPolicy(agentDO))?.approval_mode).toBe("yolo");

    state.mode = "always_ask";
    (agentDO as unknown as { assistantPolicyCache: { at: number } }).assistantPolicyCache.at = Date.now() - 60_000;

    // A builder turning autonomy off must actually take effect — caching is a latency and
    // resilience measure, never a way to keep running under a policy they've revoked.
    expect((await readPolicy(agentDO))?.approval_mode).toBe("always_ask");
  });
});
