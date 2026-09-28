import { describe, expect, it, vi } from "vitest";
import { validateCompanyAutomationOperations } from "./company-automation-workflow.js";
import { executeGenericSubagent, NO_CODE_SUBAGENT_CONTEXT_CEILING } from "./generic-subagent-workflow.js";

describe("dual-role and generic subagent workflows", () => {
  it("requires company automations to remain at least 90% deterministic", () => {
    expect(() => validateCompanyAutomationOperations(Array.from({ length: 10 }, (_, index) => ({ name: `step-${index}`, semantic: index === 9 })))).not.toThrow();
    expect(() => validateCompanyAutomationOperations([{ name: "etl" }, { name: "ai", semantic: true }])).toThrow("below_90_percent");
  });
  it("dispatches an ephemeral generic subagent with the hard context ceiling", async () => {
    let body: Record<string, unknown> = {};
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => { body = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ answer: "done" })); });
    const result = await executeGenericSubagent({ PLATFORM_SECRET: "test-secret", AGENTS_WORKER: { fetch } as unknown as Fetcher }, { tenantId: "t", spaceId: "s", sessionId: "session", invokerId: "u", goal: "research", manifest: { id: "subagent_research", name: "Research", description: "Research", creatorRoleRank: 1, allowedTools: ["search"], knowledgeBaseIds: ["public"], triggers: [] } });
    expect(body).toMatchObject({ ephemeral: true, createThread: false, maxContextTokens: NO_CODE_SUBAGENT_CONTEXT_CEILING, allowedTools: ["search"] });
    expect(result.receiptCard.lines).toHaveLength(2);
  });
});
