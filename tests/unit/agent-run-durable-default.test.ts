import { describe, it, expect } from "vitest";
import { resolveRunGoal, fetchRunOrTaskStatus } from "../../workers/agents/src/index.js";

// §A1.17 Phase Q: "closing the tab should never lose an in-flight run." Two real, previously-
// undetected bugs made end-user chat (apps/shell AND apps/portal, which share this exact
// backend contract) non-functional past the first message:
//   1. sendMessage() posts {session_id} with no `goal` — this endpoint required body.goal
//      unconditionally, so the call always 400'd. resolveRunGoal fixes this by falling back to
//      the session's own latest 'user' message.
//   2. handleGetRun (NaelaoAgentDO) returned camelCase (finalAnswer/reactSteps) while every
//      consumer (the SSE stream poller, apps/shell/portal's clients) read snake_case
//      (final_answer/react_steps) — final_answer always came through as undefined. Fixed at the
//      source (see NaelaoAgentDO.handleGetRun); this file exercises the OTHER new behavior the
//      same pass introduced: fetchRunOrTaskStatus's TaskDO fallback + status translation for a
//      durable-by-default run's task_id.

function fetcherOf(handler: (req: Request) => Promise<Response> | Response): Fetcher {
  return { fetch: async (input: string | Request, init?: RequestInit) => {
    const req = typeof input === "string" ? new Request(input, init) : input;
    return handler(req);
  } } as unknown as Fetcher;
}

describe("resolveRunGoal", () => {
  const baseEnv = { PLATFORM_SECRET: "s" };

  it("returns the provided goal unchanged when present", async () => {
    const env = { ...baseEnv, SPACES_WORKER: fetcherOf(() => { throw new Error("should not be called"); }) };
    const goal = await resolveRunGoal(env as never, "tenant-1", "space-1", "sess-1", "do the thing");
    expect(goal).toBe("do the thing");
  });

  it("derives the goal from the session's latest 'user' message when absent", async () => {
    const env = {
      ...baseEnv,
      SPACES_WORKER: fetcherOf(() =>
        Response.json({ data: [
          { role: "user", content: "first message" },
          { role: "assistant", content: "a reply" },
          { role: "user", content: "second message" },
        ] })
      ),
    };
    const goal = await resolveRunGoal(env as never, "tenant-1", "space-1", "sess-1", undefined);
    expect(goal).toBe("second message");
  });

  it("returns null (not a throw) when there is no user message to derive from", async () => {
    const env = { ...baseEnv, SPACES_WORKER: fetcherOf(() => Response.json({ data: [] })) };
    const goal = await resolveRunGoal(env as never, "tenant-1", "space-1", "sess-1", undefined);
    expect(goal).toBeNull();
  });

  it("returns null when SPACES_WORKER is unreachable, rather than throwing", async () => {
    const env = { ...baseEnv, SPACES_WORKER: fetcherOf(() => new Response("err", { status: 500 })) };
    const goal = await resolveRunGoal(env as never, "tenant-1", "space-1", "sess-1", undefined);
    expect(goal).toBeNull();
  });

  it("treats a blank/whitespace-only provided goal the same as absent", async () => {
    const env = {
      ...baseEnv,
      SPACES_WORKER: fetcherOf(() => Response.json({ data: [{ role: "user", content: "real content" }] })),
    };
    const goal = await resolveRunGoal(env as never, "tenant-1", "space-1", "sess-1", "   ");
    expect(goal).toBe("real content");
  });
});

describe("fetchRunOrTaskStatus", () => {
  function makeEnv(opts: { agentDoResponse?: Response; taskDoResponse?: Response }) {
    return {
      PLATFORM_SECRET: "s",
      NAELAO_AGENT_DO: {
        idFromName: (n: string) => n,
        get: () => ({ fetch: async () => opts.agentDoResponse ?? new Response(null, { status: 404 }) }),
      },
      TASK_DO: opts.taskDoResponse === undefined ? undefined : {
        idFromName: (n: string) => n,
        get: () => ({ fetch: async () => opts.taskDoResponse! }),
      },
    };
  }

  it("returns the synchronous NaelaoAgentDO run directly when it exists", async () => {
    const env = makeEnv({ agentDoResponse: Response.json({ id: "run-1", status: "completed", final_answer: "done" }) });
    const { status, body } = await fetchRunOrTaskStatus(env as never, "tenant-1", "sess-1", "space-1", "run-1");
    expect(status).toBe(200);
    expect(body).toEqual({ id: "run-1", status: "completed", final_answer: "done" });
  });

  it("falls back to TaskDO and translates 'complete' -> 'completed', unwrapping result.final_answer", async () => {
    const env = makeEnv({
      taskDoResponse: Response.json({ task_id: "task-1", status: "complete", result: { final_answer: "the answer" }, error: null }),
    });
    const { status, body } = await fetchRunOrTaskStatus(env as never, "tenant-1", "sess-1", "space-1", "task-1");
    expect(status).toBe(200);
    expect(body).toEqual({ id: "task-1", status: "completed", final_answer: "the answer" });
  });

  it("translates 'queued'/'processing' to 'running'", async () => {
    const env = makeEnv({ taskDoResponse: Response.json({ task_id: "task-1", status: "queued", result: null, error: null }) });
    const { body } = await fetchRunOrTaskStatus(env as never, "tenant-1", "sess-1", "space-1", "task-1");
    expect(body.status).toBe("running");
  });

  it("passes through a failed task's error", async () => {
    const env = makeEnv({ taskDoResponse: Response.json({ task_id: "task-1", status: "failed", result: null, error: "boom" }) });
    const { body } = await fetchRunOrTaskStatus(env as never, "tenant-1", "sess-1", "space-1", "task-1");
    expect(body).toEqual({ id: "task-1", status: "failed", error: "boom" });
  });

  it("reports not found when neither NaelaoAgentDO nor TaskDO has the id", async () => {
    const env = makeEnv({ taskDoResponse: new Response(null, { status: 404 }) });
    const { status, body } = await fetchRunOrTaskStatus(env as never, "tenant-1", "sess-1", "space-1", "unknown-id");
    expect(status).toBe(404);
    expect(body.status).toBe("failed");
  });

  it("degrades honestly when TASK_DO isn't configured at all", async () => {
    const env = makeEnv({});
    const { status } = await fetchRunOrTaskStatus(env as never, "tenant-1", "sess-1", "space-1", "unknown-id");
    expect(status).toBe(404);
  });
});
