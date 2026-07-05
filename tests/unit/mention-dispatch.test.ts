import { describe, it, expect } from "vitest";
import { resolveMentionRoster } from "../../workers/agents/src/index.js";

// §A1.17 Phase T2: @mention multi-agent dispatch. resolveMentionRoster is the pure(ish) piece —
// given a project id, resolve its @mentionable agent roster (filtered to allowed_agent_ids) and
// default_agent_id fallback. The dispatch loop itself (calling /agent/run per matched agent via
// app.request + posting the reply into messages) is exercised indirectly by
// project-collaboration-t1-t3.test.ts's SpaceDO-level project fixtures and by manual review —
// its only real logic beyond straight-line HTTP calls is parseMentions (tested directly in
// tests/unit/packages/mentions.test.ts) and MAX_MENTION_DISPATCH capping.

function fetcherOf(handler: (req: Request) => Promise<Response> | Response): Fetcher {
  return { fetch: async (input: string | Request, init?: RequestInit) => {
    const req = typeof input === "string" ? new Request(input, init) : input;
    return handler(req);
  } } as unknown as Fetcher;
}

describe("resolveMentionRoster", () => {
  const baseEnv = { PLATFORM_SECRET: "s" };

  it("returns an empty roster and no default when no project_id is given", async () => {
    const env = { ...baseEnv, SPACES_WORKER: fetcherOf(() => { throw new Error("should not be called"); }) };
    const result = await resolveMentionRoster(env as never, "tenant-1", "space-1", undefined);
    expect(result).toEqual({ roster: [], defaultAgentId: null });
  });

  it("resolves the roster filtered to allowed_agent_ids, with default_agent_id passed through", async () => {
    const env = {
      ...baseEnv,
      SPACES_WORKER: fetcherOf((req) => {
        const url = new URL(req.url);
        if (url.pathname.endsWith("/projects/proj-1")) {
          return Response.json({ default_agent_id: "agent-2", allowed_agent_ids: ["agent-1", "agent-2"] });
        }
        if (url.pathname.endsWith("/agent-definitions")) {
          return Response.json({ data: [
            { id: "agent-1", name: "Support Agent" },
            { id: "agent-2", name: "Fulfillment" },
            { id: "agent-3", name: "Not Allowed Here" },
          ] });
        }
        return new Response(null, { status: 404 });
      }),
    };
    const result = await resolveMentionRoster(env as never, "tenant-1", "space-1", "proj-1");
    expect(result.defaultAgentId).toBe("agent-2");
    expect(result.roster).toEqual([
      { id: "agent-1", name: "Support Agent" },
      { id: "agent-2", name: "Fulfillment" },
    ]);
  });

  it("returns default_agent_id with an empty roster when the project has no allowed_agent_ids restriction", async () => {
    const env = {
      ...baseEnv,
      SPACES_WORKER: fetcherOf((req) => {
        if (new URL(req.url).pathname.endsWith("/projects/proj-1")) {
          return Response.json({ default_agent_id: "agent-solo", allowed_agent_ids: null });
        }
        throw new Error("agent-definitions should not be fetched when there's no restriction to filter against");
      }),
    };
    const result = await resolveMentionRoster(env as never, "tenant-1", "space-1", "proj-1");
    expect(result).toEqual({ roster: [], defaultAgentId: "agent-solo" });
  });

  it("degrades to empty/null (never throws) when the project lookup 404s", async () => {
    const env = { ...baseEnv, SPACES_WORKER: fetcherOf(() => new Response(null, { status: 404 })) };
    const result = await resolveMentionRoster(env as never, "tenant-1", "space-1", "unknown-proj");
    expect(result).toEqual({ roster: [], defaultAgentId: null });
  });

  it("degrades to empty/null (never throws) when SPACES_WORKER is unreachable", async () => {
    const env = { ...baseEnv, SPACES_WORKER: fetcherOf(() => { throw new Error("network down"); }) };
    const result = await resolveMentionRoster(env as never, "tenant-1", "space-1", "proj-1");
    expect(result).toEqual({ roster: [], defaultAgentId: null });
  });
});
