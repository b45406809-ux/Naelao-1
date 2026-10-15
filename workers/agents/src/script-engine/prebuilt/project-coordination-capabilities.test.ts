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
});
