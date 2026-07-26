import { describe, it, expect } from "vitest";
import { NaelaoAgentDO } from "../../workers/agents/src/do/NaelaoAgentDO.js";
import { createDOSqlStorage } from "./helpers/sqlite-do-shim.js";
import type { OrchestrationHooks } from "../../workers/agents/src/script-engine/types.js";

// §A1.18 thread model — the real DO-to-DO dispatch behind agent.consult (see
// project-coordination-prebuilt.test.ts for the prebuilt-op-level delegation test). This drives
// the ACTUAL consultAgentImpl logic: minting the consult session/subthread, writing the
// assistant's own turn, addressing the target agent's DO the same way @mention dispatch does
// ({sessionId}:{agentId}), and translating its response.

interface Call { method: string; url: string; body: unknown }

function makeSpacesWorker(calls: Call[], opts: { existingThread?: { id: string; session_id: string | null } } = {}) {
  let sessionCounter = 0;
  let threadCounter = 0;
  return {
    async fetch(input: Request) {
      const body = await input.clone().json().catch(() => null);
      calls.push({ method: input.method, url: input.url, body });
      const url = new URL(input.url);

      if (input.method === "POST" && /\/sessions$/.test(url.pathname) && !url.pathname.includes("/messages")) {
        sessionCounter++;
        return Response.json({ id: `sess-${sessionCounter}` }, { status: 201 });
      }
      if (input.method === "POST" && url.pathname.endsWith("/threads")) {
        threadCounter++;
        return Response.json({ id: `thread-${threadCounter}` }, { status: 201 });
      }
      if (input.method === "GET" && /\/threads\/[^/]+$/.test(url.pathname)) {
        if (opts.existingThread) return Response.json(opts.existingThread);
        return new Response("not found", { status: 404 });
      }
      if (input.method === "POST" && url.pathname.includes("/messages")) {
        return Response.json({ id: "msg-1" }, { status: 201 });
      }
      return Response.json({});
    },
  } as unknown as Fetcher;
}

function makeAgentDONamespace(runResponse: unknown) {
  const seenFetches: Array<{ name: string; body: unknown }> = [];
  let lastName = "";
  return {
    namespace: {
      idFromName: (name: string) => {
        lastName = name;
        return { toString: () => name } as unknown as DurableObjectId;
      },
      get: () => ({
        async fetch(input: Request) {
          const body = await input.clone().json().catch(() => null);
          seenFetches.push({ name: lastName, body });
          return Response.json(runResponse);
        },
      }),
    } as unknown as DurableObjectNamespace,
    seenFetches,
  };
}

function makeDO(agentDONs: DurableObjectNamespace, spacesWorker: Fetcher): NaelaoAgentDO {
  const ctx = { storage: { sql: createDOSqlStorage() }, id: { toString: () => "do-1" } };
  const env = {
    PLATFORM_SECRET: "test-secret",
    SPACES_WORKER: spacesWorker,
    NAELAO_AGENT_DO: agentDONs,
  };
  return new NaelaoAgentDO(ctx as never, env as never);
}

function getConsultHook(doInstance: NaelaoAgentDO): OrchestrationHooks["consultAgent"] {
  // buildOrchestrationHooks is private — cast to reach it, the same way this file drives
  // consultAgentImpl's real logic rather than re-testing a hand-rolled substitute.
  const hooks = (doInstance as unknown as {
    buildOrchestrationHooks: (
      spaceId: string, agentId: string, tenantId: string, apiKey: string, parentRunId: string
    ) => OrchestrationHooks;
  }).buildOrchestrationHooks("space-1", "naelao-agent", "tenant-1", "", "run-1");
  return hooks.consultAgent;
}

describe("consultAgentImpl (via buildOrchestrationHooks.consultAgent)", () => {
  it("requires agent_id and message", async () => {
    const { namespace } = makeAgentDONamespace({ result: { ok: true, output: "x" } });
    const doInstance = makeDO(namespace, makeSpacesWorker([]));
    const consult = getConsultHook(doInstance)!;
    const result = await consult({ agentId: "", message: "", spaceId: "space-1" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/agent_id and message/);
  });

  it("mints a fresh session + sub_agent subthread, writes the assistant's own turn, and dispatches to {sessionId}:{agentId}", async () => {
    const { namespace, seenFetches } = makeAgentDONamespace({ result: { ok: true, output: "checked the balance, all good" } });
    const calls: Call[] = [];
    const doInstance = makeDO(namespace, makeSpacesWorker(calls));
    const consult = getConsultHook(doInstance)!;

    const result = await consult({
      agentId: "wallet-agent", message: "what's the balance?", spaceId: "space-1", parentThreadId: "thread-visible",
    });

    expect(result).toEqual({ ok: true, thread_id: "thread-1", session_id: "sess-1", reply: "checked the balance, all good" });

    // A session was minted.
    expect(calls.some((c) => c.method === "POST" && /\/sessions$/.test(new URL(c.url).pathname))).toBe(true);
    // A sub_agent subthread was created under the given parent, carrying the new session id.
    const threadCreate = calls.find((c) => c.method === "POST" && c.url.endsWith("/threads"));
    expect(threadCreate!.body).toMatchObject({
      thread_kind: "sub_agent", session_id: "sess-1", parent_thread_id: "thread-visible",
    });
    // The assistant's own turn was written before dispatch, attributed to naelao-agent.
    const messagePost = calls.find((c) => c.method === "POST" && c.url.includes("/messages"));
    expect(messagePost!.body).toEqual({ role: "user", content: "what's the balance?", agent_id: "naelao-agent" });
    // Dispatched to the {sessionId}:{agentId} composite DO name, per @mention's own addressing.
    expect(seenFetches).toHaveLength(1);
    expect(seenFetches[0]!.name).toContain("sess-1:wallet-agent");
    expect(seenFetches[0]!.body).toMatchObject({ goal: "what's the balance?", agentId: "wallet-agent", sessionId: "sess-1" });
  });

  it("reuses an existing consult thread's session when thread_id is given, without minting a new one", async () => {
    const { namespace } = makeAgentDONamespace({ result: { ok: true, output: "still good" } });
    const calls: Call[] = [];
    const spacesWorker = makeSpacesWorker(calls, { existingThread: { id: "thread-1", session_id: "sess-old" } });
    const doInstance = makeDO(namespace, spacesWorker);
    const consult = getConsultHook(doInstance)!;

    const result = await consult({ agentId: "wallet-agent", message: "and now?", spaceId: "space-1", threadId: "thread-1" });
    expect(result.ok).toBe(true);
    expect(result.session_id).toBe("sess-old");
    // No new session or thread minted on reuse.
    expect(calls.some((c) => c.method === "POST" && /\/sessions$/.test(new URL(c.url).pathname))).toBe(false);
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/threads"))).toBe(false);
  });

  it("fails cleanly when thread_id names a thread with no session", async () => {
    const { namespace } = makeAgentDONamespace({ result: { ok: true } });
    const spacesWorker = makeSpacesWorker([], { existingThread: { id: "thread-1", session_id: null } });
    const doInstance = makeDO(namespace, spacesWorker);
    const consult = getConsultHook(doInstance)!;

    const result = await consult({ agentId: "wallet-agent", message: "hi", spaceId: "space-1", threadId: "thread-1" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no session/);
  });

  it("surfaces a pending approval instead of a bare error", async () => {
    const { namespace } = makeAgentDONamespace({ pending_approval: { action_name: "commerce.payout" } });
    const doInstance = makeDO(namespace, makeSpacesWorker([]));
    const consult = getConsultHook(doInstance)!;

    const result = await consult({ agentId: "wallet-agent", message: "pay out $50", spaceId: "space-1" });
    expect(result.ok).toBe(true);
    expect(result.reply).toContain("needs approval");
    expect(result.reply).toContain("commerce.payout");
  });

  it("surfaces the consulted agent's own error", async () => {
    const { namespace } = makeAgentDONamespace({ result: { ok: false, error: "no such tool" } });
    const doInstance = makeDO(namespace, makeSpacesWorker([]));
    const consult = getConsultHook(doInstance)!;

    const result = await consult({ agentId: "wallet-agent", message: "do the impossible", spaceId: "space-1" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("no such tool");
  });
});
