import { describe, it, expect } from "vitest";
import { NaelaoAgentDO } from "../../workers/agents/src/do/NaelaoAgentDO.js";
import { createDOSqlStorage } from "./helpers/sqlite-do-shim.js";
import type { OrchestrationHooks } from "../../workers/agents/src/script-engine/types.js";

// §A1.18 thread model, the other half of consultAgentImpl (see
// consult-agent-orchestration-hook.test.ts): posting a message into an EXISTING, VISIBLE thread —
// never a hidden sub_agent thread — and, unless respond:false, dispatching the named agent to
// reply THERE. This drives the real sendToThreadImpl logic (via buildOrchestrationHooks), not a
// hand-rolled substitute.

interface Call { method: string; url: string; body: unknown }

function makeSpacesWorker(
  calls: Call[],
  opts: { thread?: { session_id: string | null; project_id?: string | null } | null } = {}
) {
  let sessionCounter = 0;
  return {
    async fetch(input: Request) {
      const body = await input.clone().json().catch(() => null);
      calls.push({ method: input.method, url: input.url, body });
      const url = new URL(input.url);

      if (input.method === "GET" && /\/threads\/[^/]+$/.test(url.pathname)) {
        if (opts.thread === null) return new Response("not found", { status: 404 });
        return Response.json(opts.thread ?? { session_id: "sess-existing" });
      }
      if (input.method === "POST" && /\/sessions$/.test(url.pathname) && !url.pathname.includes("/messages")) {
        sessionCounter++;
        return Response.json({ id: `sess-new-${sessionCounter}` }, { status: 201 });
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

function getSendToThreadHook(doInstance: NaelaoAgentDO): OrchestrationHooks["sendToThread"] {
  // buildOrchestrationHooks is private — cast to reach it, same precedent as the consult test.
  const hooks = (doInstance as unknown as {
    buildOrchestrationHooks: (
      spaceId: string, agentId: string, tenantId: string, apiKey: string, parentRunId: string
    ) => OrchestrationHooks;
  }).buildOrchestrationHooks("space-1", "naelao-agent", "tenant-1", "", "run-1");
  return hooks.sendToThread;
}

describe("sendToThreadImpl (via buildOrchestrationHooks.sendToThread)", () => {
  it("requires thread_id and message", async () => {
    const { namespace } = makeAgentDONamespace({ result: { ok: true, output: "x" } });
    const doInstance = makeDO(namespace, makeSpacesWorker([]));
    const send = getSendToThreadHook(doInstance)!;
    const result = await send({ threadId: "", message: "", spaceId: "space-1" });
    expect(result.ok).toBe(false);
    expect(result.dispatched).toBe(false);
    expect(result.error).toMatch(/thread_id and message/);
  });

  it("requires agent_id when a reply is wanted (respond defaults to true)", async () => {
    const { namespace } = makeAgentDONamespace({ result: { ok: true, output: "x" } });
    const doInstance = makeDO(namespace, makeSpacesWorker([]));
    const send = getSendToThreadHook(doInstance)!;
    const result = await send({ threadId: "t1", message: "hello", spaceId: "space-1" });
    expect(result.ok).toBe(false);
    expect(result.dispatched).toBe(false);
    expect(result.error).toMatch(/agent_id is required/);
  });

  it("404s cleanly when the thread doesn't exist", async () => {
    const { namespace } = makeAgentDONamespace({ result: { ok: true } });
    const doInstance = makeDO(namespace, makeSpacesWorker([], { thread: null }));
    const send = getSendToThreadHook(doInstance)!;
    const result = await send({ threadId: "ghost", message: "hi", spaceId: "space-1", agentId: "wallet-agent" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/);
  });

  it("posts into the thread's EXISTING session — never creates a new one or a sub_agent thread", async () => {
    const { namespace, seenFetches } = makeAgentDONamespace({ result: { ok: true, output: "done, it's set up" } });
    const calls: Call[] = [];
    const doInstance = makeDO(namespace, makeSpacesWorker(calls, { thread: { session_id: "sess-existing", project_id: "proj-1" } }));
    const send = getSendToThreadHook(doInstance)!;

    const result = await send({ threadId: "thread-1", message: "checking on this", spaceId: "space-1", agentId: "support-agent" });

    expect(result).toEqual({ ok: true, session_id: "sess-existing", dispatched: true, reply: "done, it's set up" });
    // No new session minted, and — the whole point — no thread creation call at all (unlike
    // consultAgentImpl, which mints a fresh thread_kind='sub_agent' thread every time).
    expect(calls.some((c) => c.method === "POST" && /\/sessions$/.test(new URL(c.url).pathname))).toBe(false);
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/threads"))).toBe(false);

    // The assistant's own message was posted into THAT session, attributed to it.
    const messagePost = calls.find((c) => c.method === "POST" && c.url.includes("/messages"));
    expect(messagePost!.body).toEqual({ role: "assistant", content: "checking on this", agent_id: "naelao-agent" });

    // Dispatched to {sessionId}:{agentId}, same addressing @mention/agent.consult already use —
    // and the thread's own project_id was carried through automatically.
    expect(seenFetches).toHaveLength(1);
    expect(seenFetches[0]!.name).toContain("sess-existing:support-agent");
    expect(seenFetches[0]!.body).toMatchObject({
      goal: "checking on this", agentId: "support-agent", sessionId: "sess-existing", projectId: "proj-1",
    });
  });

  it("mints a session for a thread that doesn't have one yet, then posts into it", async () => {
    const { namespace } = makeAgentDONamespace({ result: { ok: true, output: "ok" } });
    const calls: Call[] = [];
    const doInstance = makeDO(namespace, makeSpacesWorker(calls, { thread: { session_id: null } }));
    const send = getSendToThreadHook(doInstance)!;

    const result = await send({ threadId: "thread-1", message: "hi", spaceId: "space-1", agentId: "support-agent" });
    expect(result.ok).toBe(true);
    expect(result.session_id).toBe("sess-new-1");
    expect(calls.some((c) => c.method === "POST" && /\/sessions$/.test(new URL(c.url).pathname))).toBe(true);
  });

  it("respond:false posts the message and stops — no dispatch, no agent_id needed", async () => {
    const { namespace, seenFetches } = makeAgentDONamespace({ result: { ok: true, output: "should not be called" } });
    const calls: Call[] = [];
    const doInstance = makeDO(namespace, makeSpacesWorker(calls, { thread: { session_id: "sess-existing" } }));
    const send = getSendToThreadHook(doInstance)!;

    const result = await send({ threadId: "thread-1", message: "just a note", spaceId: "space-1", respond: false });
    expect(result).toEqual({ ok: true, session_id: "sess-existing", dispatched: false });
    expect(seenFetches).toHaveLength(0);
    // The message was still posted, visibly, into the real thread.
    const messagePost = calls.find((c) => c.method === "POST" && c.url.includes("/messages"));
    expect(messagePost).toBeDefined();
  });

  it("surfaces a pending approval instead of a bare error", async () => {
    const { namespace } = makeAgentDONamespace({ pending_approval: { action_name: "commerce.payout" } });
    const doInstance = makeDO(namespace, makeSpacesWorker([], { thread: { session_id: "sess-existing" } }));
    const send = getSendToThreadHook(doInstance)!;

    const result = await send({ threadId: "thread-1", message: "pay out $50", spaceId: "space-1", agentId: "wallet-agent" });
    expect(result.ok).toBe(true);
    expect(result.dispatched).toBe(true);
    expect(result.reply).toContain("needs approval");
  });

  it("surfaces the target agent's own error", async () => {
    const { namespace } = makeAgentDONamespace({ result: { ok: false, error: "no such tool" } });
    const doInstance = makeDO(namespace, makeSpacesWorker([], { thread: { session_id: "sess-existing" } }));
    const send = getSendToThreadHook(doInstance)!;

    const result = await send({ threadId: "thread-1", message: "do the impossible", spaceId: "space-1", agentId: "wallet-agent" });
    expect(result.ok).toBe(false);
    expect(result.dispatched).toBe(true);
    expect(result.error).toBe("no such tool");
  });
});
