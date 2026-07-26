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
  describe("agent.consult", () => {
    it("requires agent_id and message", async () => {
      const orchestration: OrchestrationHooks = { consultAgent: async () => ({ ok: true }) };
      const env = makeEnv([], undefined, orchestration);
      await expect(
        projectCoordination.operations["agent.consult"]!({ agent_id: "agent1" }, { env, run: noopRun })
      ).rejects.toThrow(/agent_id and message/);
      await expect(
        projectCoordination.operations["agent.consult"]!({ message: "hi" }, { env, run: noopRun })
      ).rejects.toThrow(/agent_id and message/);
    });

    it("reports unavailable, not a throw, when no orchestration hook is wired", async () => {
      const env = makeEnv([]); // no orchestration
      const result = await projectCoordination.operations["agent.consult"]!(
        { agent_id: "agent1", message: "status?" },
        { env, run: noopRun }
      );
      expect(result).toEqual({ ok: false, error: "agent.consult not available in this environment" });
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
      const result = await projectCoordination.operations["agent.consult"]!(
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
      await projectCoordination.operations["agent.consult"]!(
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

  it("throws a clear error when the spaces worker binding is missing", async () => {
    const env = { scriptsBucket: {} as never, spaceId: "space-1", tenantId: "tenant-1", platformSecret: PLATFORM_SECRET } as unknown as ScriptEngineEnv;
    await expect(projectCoordination.operations["thread.list"]!({}, { env, run: noopRun })).rejects.toThrow(/spaces worker binding/);
  });
});
