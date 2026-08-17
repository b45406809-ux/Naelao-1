import { describe, it, expect } from "vitest";
import { projectCoordination } from "../../workers/agents/src/script-engine/prebuilt/project-coordination.js";
import { verifyInternalToken } from "@naelao/http";
import type { ScriptEngineEnv, OrchestrationHooks } from "../../workers/agents/src/script-engine/types.js";

// §A1.18 thread model: `agent.consult` (delegates to the host's orchestration.consultAgent hook —
// see NaelaoAgentDO.consultAgentImpl for the real DO-to-DO dispatch, exercised separately) and
// `thread.list`/`thread.read` (thin spaces-worker wrappers, same verified-internal-token pattern
// as workspace-admin's project.list/agent.list — see workspace-admin-prebuilt.test.ts).

const PLATFORM_SECRET = "test-platform-secret";

interface Call { method: string; url: string; headers: Record<string, string>; body: unknown }

function makeEnv(calls: Call[], responder?: (call: Call) => unknown, orchestration?: OrchestrationHooks): ScriptEngineEnv {
  const spacesWorker = {
    async fetch(reqInput: Request | string, init?: RequestInit) {
      const req = typeof reqInput === "string" ? new Request(reqInput, init) : reqInput;
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => { headers[k] = v; });
      const body = await req.clone().json().catch(() => null);
      const call: Call = { method: req.method, url: req.url, headers, body };
      calls.push(call);
      const result = responder ? responder(call) : {};
      return Response.json(result ?? {});
    },
  };
  return {
    scriptsBucket: {} as never,
    spaceId: "space-1",
    tenantId: "tenant-1",
    platformSecret: PLATFORM_SECRET,
    spacesWorker: spacesWorker as unknown as Fetcher,
    ...(orchestration ? { orchestration } : {}),
  } as unknown as ScriptEngineEnv;
}

const noopRun = async () => ({});

describe("project-coordination prebuilt", () => {
  describe("thread.consult", () => {
    it("requires agent_id and message", async () => {
      const orchestration: OrchestrationHooks = { consultAgent: async () => ({ ok: true }) };
      const env = makeEnv([], undefined, orchestration);
      await expect(
        projectCoordination.operations["thread.consult"]!({ agent_id: "agent1" }, { env, run: noopRun })
      ).rejects.toThrow(/agent_id and message/);
      await expect(
        projectCoordination.operations["thread.consult"]!({ message: "hi" }, { env, run: noopRun })
      ).rejects.toThrow(/agent_id and message/);
    });

    it("reports unavailable, not a throw, when no orchestration hook is wired", async () => {
      const env = makeEnv([]); // no orchestration
      const result = await projectCoordination.operations["thread.consult"]!(
        { agent_id: "agent1", message: "status?" },
        { env, run: noopRun }
      );
      expect(result).toEqual({ ok: false, error: "thread.consult not available in this environment" });
    });

    it("delegates to orchestration.consultAgent with the space id and only the params actually given", async () => {
      let seen: unknown;
      const orchestration: OrchestrationHooks = {
        consultAgent: async (params) => {
          seen = params;
          return { ok: true, thread_id: "thread-1", session_id: "sess-1", reply: "done" };
        },
      };
      const env = makeEnv([], undefined, orchestration);
      const result = await projectCoordination.operations["thread.consult"]!(
        { agent_id: "agent1", message: "please check the wallet" },
        { env, run: noopRun }
      );
      expect(result).toEqual({ ok: true, thread_id: "thread-1", session_id: "sess-1", reply: "done" });
      expect(seen).toEqual({ agentId: "agent1", message: "please check the wallet", spaceId: "space-1" });
    });

    it("passes through project_id, parent_thread_id, and thread_id when given", async () => {
      let seen: unknown;
      const orchestration: OrchestrationHooks = {
        consultAgent: async (params) => { seen = params; return { ok: true }; },
      };
      const env = makeEnv([], undefined, orchestration);
      await projectCoordination.operations["thread.consult"]!(
        {
          agent_id: "agent1",
          message: "continue",
          project_id: "proj-1",
          parent_thread_id: "thread-parent",
          thread_id: "thread-existing",
        },
        { env, run: noopRun }
      );
      expect(seen).toEqual({
        agentId: "agent1",
        message: "continue",
        spaceId: "space-1",
        projectId: "proj-1",
        parentThreadId: "thread-parent",
        threadId: "thread-existing",
      });
    });
  });

  describe("thread.list", () => {
    it("lists a project's threads with an explicit parent_thread_id filter", async () => {
      const calls: Call[] = [];
      const env = makeEnv(calls, () => ({ data: [{ id: "t1" }], count: 1 }));
      const result = await projectCoordination.operations["thread.list"]!(
        { project_id: "proj-1", parent_thread_id: "thread-parent" },
        { env, run: noopRun }
      );
      expect(result).toEqual({ data: [{ id: "t1" }], count: 1 });
      expect(calls[0]!.url).toContain("/spaces/space-1/threads?");
      expect(calls[0]!.url).toContain("project_id=proj-1");
      expect(calls[0]!.url).toContain("parent_thread_id=thread-parent");
      expect(await verifyInternalToken(calls[0]!.headers["x-naelao-internal-token"], "tenant-1", PLATFORM_SECRET)).toBe(true);
    });
  });

  describe("thread.read", () => {
    it("requires thread_id", async () => {
      const env = makeEnv([]);
      await expect(projectCoordination.operations["thread.read"]!({}, { env, run: noopRun })).rejects.toThrow(/thread_id/);
    });

    it("returns an empty message list for a thread with no session (never fetches messages)", async () => {
      const calls: Call[] = [];
      const env = makeEnv(calls, (call) => {
        if (call.url.includes("/threads/thread-1")) return { id: "thread-1", session_id: null };
        return {};
      });
      const result = await projectCoordination.operations["thread.read"]!({ thread_id: "thread-1" }, { env, run: noopRun });
      expect(result).toEqual({ thread: { id: "thread-1", session_id: null }, messages: [] });
      expect(calls).toHaveLength(1); // only the thread lookup, no messages call
    });

    it("reads the thread's messages when it has a session", async () => {
      const calls: Call[] = [];
      const env = makeEnv(calls, (call) => {
        if (call.url.includes("/threads/thread-1")) return { id: "thread-1", session_id: "sess-1" };
        if (call.url.includes("/sessions/sess-1/messages")) return [{ id: "m1", role: "assistant", content: "hi" }];
        return {};
      });
      const result = await projectCoordination.operations["thread.read"]!({ thread_id: "thread-1" }, { env, run: noopRun });
      expect(result).toEqual({
        thread: { id: "thread-1", session_id: "sess-1" },
        messages: [{ id: "m1", role: "assistant", content: "hi" }],
      });
      expect(calls).toHaveLength(2);
    });
  });

  // The assistant can open a real thread, the same as a person clicking "new thread". A thread
  // with no linked session 404s as "Session not found" the moment anyone (including the person
  // who asked for it) opens it — so thread.create must mint and link a real session too, the
  // same thing Chat.tsx's own startSession(thread_id) does for a human-created thread.
  describe("thread.create", () => {
    function threadPlusSessionResponder(calls: Call[]) {
      return (call: Call) => {
        if (call.url.includes("/sessions")) return { id: "sess-9", space_id: "space-1" };
        return { id: "thread-9", title: (call.body as { title?: string } | null)?.title ?? null };
      };
    }

    it("posts a thread with the title and the run's own project, then links a real session", async () => {
      const calls: Call[] = [];
      const env = { ...makeEnv(calls, undefined, undefined), projectId: "proj-1" } as ScriptEngineEnv;
      (env as unknown as { spacesWorker: { fetch: (r: Request) => Promise<Response> } }).spacesWorker = {
        fetch: async (req: Request) => {
          const headers: Record<string, string> = {};
          req.headers.forEach((v, k) => { headers[k] = v; });
          const body = await req.clone().json().catch(() => null);
          calls.push({ method: req.method, url: req.url, headers, body });
          return Response.json(threadPlusSessionResponder(calls)({ method: req.method, url: req.url, headers, body }));
        },
      } as unknown as Fetcher;

      const result = await projectCoordination.operations["thread.create"]!({ title: "Q3 pricing" }, { env, run: noopRun });

      expect(calls).toHaveLength(2);
      expect(calls[0]!.method).toBe("POST");
      expect(calls[0]!.url).toContain("/spaces/space-1/threads");
      expect(calls[0]!.body).toMatchObject({ title: "Q3 pricing", project_id: "proj-1" });
      expect(typeof (calls[0]!.body as { id: string }).id).toBe("string"); // id minted client-side so it can be linked

      expect(calls[1]!.url).toContain("/spaces/space-1/sessions");
      expect(calls[1]!.body).toEqual({ thread_id: (calls[0]!.body as { id: string }).id });

      expect(result).toMatchObject({ id: "thread-9", title: "Q3 pricing", session_id: "sess-9" });
    });

    it("still returns the thread when linking a session fails, rather than throwing", async () => {
      const calls: Call[] = [];
      const env = makeEnv(calls, (call) => {
        if (call.url.includes("/sessions")) throw new Error("boom");
        return { id: "thread-9" };
      });
      const result = await projectCoordination.operations["thread.create"]!({ title: "x" }, { env, run: noopRun });
      expect(result).toEqual({ id: "thread-9" });
    });

    it("an explicit project_id overrides the run's own project", async () => {
      const calls: Call[] = [];
      const env = { ...makeEnv(calls, () => ({ id: "t" })), projectId: "proj-1" } as ScriptEngineEnv;
      await projectCoordination.operations["thread.create"]!({ project_id: "proj-2" }, { env, run: noopRun });
      expect(calls[0]!.body).toMatchObject({ project_id: "proj-2" });
    });

    // thread_kind is deliberately NOT forwardable: 'sub_agent' is the private consult/fan-out lane
    // the orchestration hook owns, and 'channel' is minted by the channel gateway from a verified
    // inbound webhook. An agent forging either would give a message a provenance it didn't have.
    it("never lets the caller forge a thread_kind", async () => {
      const calls: Call[] = [];
      const env = makeEnv(calls, () => ({ id: "t" }));
      await projectCoordination.operations["thread.create"]!(
        { title: "x", thread_kind: "channel", parent_thread_id: "t-other", channel: "whatsapp" },
        { env, run: noopRun }
      );
      expect(calls[0]!.body).toMatchObject({ title: "x" });
      expect(calls[0]!.body).not.toHaveProperty("thread_kind");
      expect(calls[0]!.body).not.toHaveProperty("parent_thread_id");
      expect(calls[0]!.body).not.toHaveProperty("channel");
    });
  });

  // §A1.18 follow-up: the acting user must reach the spaces worker, or anything created lands
  // with created_by=undefined — and a private-by-default project with no creator gets no
  // project_members row, so it's invisible to the very person who asked for it.
  describe("acting user", () => {
    it("forwards x-naelao-user-id when the run has one", async () => {
      const calls: Call[] = [];
      const env = { ...makeEnv(calls, () => ({ id: "t" })), userId: "end-user-7" } as ScriptEngineEnv;
      await projectCoordination.operations["thread.create"]!({ title: "x" }, { env, run: noopRun });
      expect(calls[0]!.headers["x-naelao-user-id"]).toBe("end-user-7");
    });

    it("omits the header entirely for a system run (cron/channel drain), unchanged from before", async () => {
      const calls: Call[] = [];
      const env = makeEnv(calls, () => ({ id: "t" })); // no userId
      await projectCoordination.operations["thread.create"]!({ title: "x" }, { env, run: noopRun });
      expect(calls[0]!.headers["x-naelao-user-id"]).toBeUndefined();
      // still a verified internal caller either way
      expect(await verifyInternalToken(calls[0]!.headers["x-naelao-internal-token"], "tenant-1", PLATFORM_SECRET)).toBe(true);
    });
  });

  it("throws a clear error when the spaces worker binding is missing", async () => {
    const env = { scriptsBucket: {} as never, spaceId: "space-1", tenantId: "tenant-1", platformSecret: PLATFORM_SECRET } as unknown as ScriptEngineEnv;
    await expect(projectCoordination.operations["thread.list"]!({}, { env, run: noopRun })).rejects.toThrow(/spaces worker binding/);
  });

  // Parity ask: the assistant should be able to do what a person managing a thread can — rename
  // it, archive it (there's no hard delete — see SpaceDO.updateThread's own comment), and find one
  // by name.
  describe("thread.rename", () => {
    it("requires thread_id and title", async () => {
      const env = makeEnv([]);
      await expect(projectCoordination.operations["thread.rename"]!({ thread_id: "t1" }, { env, run: noopRun })).rejects.toThrow(/thread_id and title/);
      await expect(projectCoordination.operations["thread.rename"]!({ title: "x" }, { env, run: noopRun })).rejects.toThrow(/thread_id and title/);
    });

    it("PATCHes the thread's title", async () => {
      const calls: Call[] = [];
      const env = makeEnv(calls, () => ({ id: "t1", title: "New name" }));
      const result = await projectCoordination.operations["thread.rename"]!({ thread_id: "t1", title: "New name" }, { env, run: noopRun });
      expect(result).toEqual({ id: "t1", title: "New name" });
      expect(calls[0]!.method).toBe("PATCH");
      expect(calls[0]!.url).toContain("/spaces/space-1/threads/t1");
      expect(calls[0]!.body).toEqual({ title: "New name" });
    });
  });

  describe("thread.delete", () => {
    it("requires thread_id", async () => {
      const env = makeEnv([]);
      await expect(projectCoordination.operations["thread.delete"]!({}, { env, run: noopRun })).rejects.toThrow(/thread_id/);
    });

    it("archives the thread — never a hard delete", async () => {
      const calls: Call[] = [];
      const env = makeEnv(calls, () => ({ id: "t1", status: "archived" }));
      const result = await projectCoordination.operations["thread.delete"]!({ thread_id: "t1" }, { env, run: noopRun });
      expect(result).toEqual({ id: "t1", status: "archived" });
      expect(calls[0]!.method).toBe("PATCH");
      expect(calls[0]!.body).toEqual({ status: "archived" });
    });
  });

  describe("thread.search", () => {
    it("requires a query", async () => {
      const env = makeEnv([]);
      await expect(projectCoordination.operations["thread.search"]!({}, { env, run: noopRun })).rejects.toThrow(/query/);
    });

    it("filters the project's own threads by title, case-insensitively", async () => {
      const calls: Call[] = [];
      const env = { ...makeEnv(calls, () => ({
        data: [
          { id: "t1", title: "Q3 Pricing Review" },
          { id: "t2", title: "Support: refund request" },
          { id: "t3", title: null },
        ],
        count: 3,
      })), projectId: "proj-1" } as ScriptEngineEnv;
      const result = await projectCoordination.operations["thread.search"]!({ query: "pricing" }, { env, run: noopRun });
      expect(result).toEqual({
        query: "pricing",
        matches: [{ id: "t1", title: "Q3 Pricing Review" }],
        matched_count: 1,
      });
      expect(calls[0]!.url).toContain("project_id=proj-1");
    });

    it("returns no matches, not an error, when nothing matches", async () => {
      const calls: Call[] = [];
      const env = makeEnv(calls, () => ({ data: [{ id: "t1", title: "Something else" }], count: 1 }));
      const result = await projectCoordination.operations["thread.search"]!({ query: "nonexistent" }, { env, run: noopRun });
      expect(result).toEqual({ query: "nonexistent", matches: [], matched_count: 0 });
    });
  });

  // The other half of the thread model: actually chatting in a VISIBLE thread, as opposed to
  // agent.consult's private, hidden subthread.
  describe("thread.send_message", () => {
    it("requires thread_id and message", async () => {
      const orchestration: OrchestrationHooks = { sendToThread: async () => ({ ok: true, dispatched: false }) };
      const env = makeEnv([], undefined, orchestration);
      await expect(
        projectCoordination.operations["thread.send_message"]!({ thread_id: "t1" }, { env, run: noopRun })
      ).rejects.toThrow(/thread_id and message/);
      await expect(
        projectCoordination.operations["thread.send_message"]!({ message: "hi" }, { env, run: noopRun })
      ).rejects.toThrow(/thread_id and message/);
    });

    it("reports unavailable, not a throw, when no orchestration hook is wired", async () => {
      const env = makeEnv([]); // no orchestration
      const result = await projectCoordination.operations["thread.send_message"]!(
        { thread_id: "t1", message: "hi" },
        { env, run: noopRun }
      );
      expect(result).toEqual({ ok: false, error: "thread.send_message not available in this environment" });
    });

    it("delegates to orchestration.sendToThread, defaulting respond to true", async () => {
      let seen: unknown;
      const orchestration: OrchestrationHooks = {
        sendToThread: async (params) => { seen = params; return { ok: true, session_id: "sess-1", dispatched: true, reply: "on it" }; },
      };
      const env = makeEnv([], undefined, orchestration);
      const result = await projectCoordination.operations["thread.send_message"]!(
        { thread_id: "t1", message: "please check the invoice" },
        { env, run: noopRun }
      );
      expect(result).toEqual({ ok: true, session_id: "sess-1", dispatched: true, reply: "on it" });
      expect(seen).toEqual({ threadId: "t1", message: "please check the invoice", spaceId: "space-1", respond: true });
    });

    it("passes through agent_id and an explicit respond:false", async () => {
      let seen: unknown;
      const orchestration: OrchestrationHooks = { sendToThread: async (params) => { seen = params; return { ok: true, dispatched: false }; } };
      const env = makeEnv([], undefined, orchestration);
      await projectCoordination.operations["thread.send_message"]!(
        { thread_id: "t1", message: "note for the record", agent_id: "support-agent", respond: false },
        { env, run: noopRun }
      );
      expect(seen).toEqual({ threadId: "t1", message: "note for the record", spaceId: "space-1", agentId: "support-agent", respond: false });
    });
  });
});
