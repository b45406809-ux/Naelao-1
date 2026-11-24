import { describe, expect, it, vi } from "vitest";
import { projectCoordination } from "./project-coordination.js";

describe("project worker capability roster", () => {
  it("returns configured capability names without forwarding stored agent configuration", async () => {
    const fetch = vi.fn(async () => Response.json({ data: [{
      id: "worker-1", name: "Invoice Worker", description: "Reconciles invoices",
      config: { scripts: { prebuilt: ["knowledge-base", "finance-ops", "unsafe/path"] }, prompts: { systemPrompt: "private config" } },
    }, {
      id: "worker-2", name: "Web Worker", description: "Builds user interfaces",
      config: { scripts: { prebuilt: ["code-exec", "web-search"] } },
    }] }));
    const list = projectCoordination.operations["thread.list_project_agents"]!;
    const result = await list({}, {
      env: { spacesWorker: { fetch } as never, spaceId: "space-1", tenantId: "tenant-1", platformSecret: "secret" },
      run: vi.fn(),
    } as never) as { agents: Array<Record<string, unknown>> };

    expect(result.agents.find(agent => agent.id === "worker-1")).toEqual({
      id: "worker-1", name: "Invoice Worker", description: "Reconciles invoices",
      available_capabilities: ["knowledge-base", "finance-ops"],
    });
    expect(JSON.stringify(result)).not.toContain("private config");
    expect(result.agents.some(agent => agent.id === "naelao-agent")).toBe(true);

    const ranked = await list({ query: "invoice reconciliation" }, {
      env: { spacesWorker: { fetch } as never, spaceId: "space-1", tenantId: "tenant-1", platformSecret: "secret" },
      run: vi.fn(),
    } as never) as { agents: Array<{ id: string; match_score?: number }>; ranking?: string };
    expect(ranked.agents[0]).toMatchObject({ id: "worker-1", match_score: 2 });
    expect(ranked.ranking).toContain("literal");
  });

  it("keeps a Project planner's thread list, search, and exact read inside its bound Project", async () => {
    const fetch = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/threads/foreign")) return Response.json({
        id: "foreign", space_id: "space-1", project_id: "project-2", session_id: "session-foreign",
      });
      if (url.pathname.endsWith("/sessions/session-foreign/messages")) return Response.json({ messages: [{ text: "secret" }] });
      return Response.json({ data: [] });
    });
    const ctx = { env: {
      spacesWorker: { fetch } as never, spaceId: "space-1", projectId: "project-1", tenantId: "tenant-1", platformSecret: "secret",
    }, run: vi.fn() } as never;

    await projectCoordination.operations["thread.list"]!({}, ctx);
    const listUrl = new URL(fetch.mock.calls[0]![0].url);
    expect(listUrl.searchParams.get("project_id")).toBe("project-1");
    expect(() => projectCoordination.operations["thread.list"]!({ project_id: "project-2" }, ctx))
      .toThrow("thread_project_scope_denied");
    await expect(projectCoordination.operations["thread.search"]!({ query: "secret", project_id: "project-2" }, ctx))
      .rejects.toThrow("thread_project_scope_denied");
    await expect(projectCoordination.operations["thread.read"]!({ thread_id: "foreign" }, ctx))
      .rejects.toThrow("thread_read_scope_denied");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("limits a Project planner's worker roster and consult target to the Project allowlist", async () => {
    const fetch = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/projects/project-1")) return Response.json({
        id: "project-1", default_agent_id: "worker-2", allowed_agent_ids: ["worker-2"],
      });
      if (url.pathname.endsWith("/agent-definitions")) return Response.json({ data: [
        { id: "worker-1", name: "Other Project Worker", config: { scripts: { prebuilt: ["finance-ops"] } } },
        { id: "worker-2", name: "Allowed Worker", config: { scripts: { prebuilt: ["knowledge-base"] } } },
      ] });
      return Response.json({ data: [] });
    });
    const consultAgent = vi.fn();
    const ctx = { env: {
      spacesWorker: { fetch } as never, spaceId: "space-1", projectId: "project-1", tenantId: "tenant-1", platformSecret: "secret",
      orchestration: { consultAgent },
    }, run: vi.fn() } as never;

    const roster = await projectCoordination.operations["thread.list_project_agents"]!({}, ctx) as { agents: Array<{ id: string }> };
    expect(roster.agents.map(agent => agent.id)).toEqual(["naelao-agent", "worker-2"]);
    const result = await projectCoordination.operations["thread.consult"]!({ agent_id: "worker-1", message: "inspect the private project" }, ctx) as { ok: boolean; error: string };
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("was not found in this project") });
    expect(consultAgent).not.toHaveBeenCalled();
  });
});
