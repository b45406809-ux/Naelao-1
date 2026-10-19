import { describe, expect, it, vi } from "vitest";
import { buildProjectMemoryStore, gateStructuredFacts, roleRankFor } from "./project-memory-client.js";
import type { MemoryRecallResult } from "./types.js";

const candidate = (text: string): MemoryRecallResult => ({
  id: text,
  layer: "structured_fact",
  text,
  score: 1,
});

describe("project memory Jev/Laya relevance gate", () => {
  it("normalizes authorization roles to the shared memory rank", () => {
    expect(roleRankFor("viewer")).toBe(0);
    expect(roleRankFor("editor")).toBe(1);
    expect(roleRankFor("admin")).toBe(2);
    expect(roleRankFor("owner")).toBe(3);
    expect(roleRankFor(9)).toBe(3);
  });

  it("propagates the effective rank to the project fact boundary", async () => {
    const fetch = vi.fn(async (request: Request) => {
      if (request.method === "GET") {
        return Response.json({ data: [{ id: "f1", entity: "launch", relation: "owner", attribute: "team", trust_score: 1, required_role_rank: 2 }] });
      }
      return Response.json({ id: "f1" }, { status: 201 });
    });
    const store = buildProjectMemoryStore({
      spacesWorker: { fetch } as unknown as Fetcher,
      platformSecret: "secret",
      spaceId: "space",
      tenantId: "tenant",
      projectId: "project",
      mintInternalToken: async () => "signed",
      roleRank: () => 2,
    });
    const recalled = await store.recall({ text: "launch team", limit: 1 });
    expect(new URL((fetch.mock.calls[0]![0] as Request).url).searchParams.get("role_rank")).toBe("2");
    expect(recalled[0]).toMatchObject({ role_rank: 2, required_role_rank: 2 });
    await store.remember({ entity: "launch", relation: "owner", attribute: "team", text: "" });
    const write = fetch.mock.calls[1]![0] as Request;
    expect(new URL(write.url).searchParams.get("role_rank")).toBe("2");
  });

  it("uses a high-confidence typed score before admitting a fact", async () => {
    const score = vi.fn(async () => ({
      kind: "score" as const,
      value: 9,
      confidence: 0.96,
      provider: "openrouter" as const,
      policyCode: "project_fact_relevance",
    }));
    // The fact deliberately shares no exact query token: Jev must be allowed to recognize
    // semantic relevance before the deterministic lexical fallback is considered.
    const result = await gateStructuredFacts("refund window", [candidate("money back policy period 30 days")], { score } as never);
    expect(result).toHaveLength(1);
    expect(score).toHaveBeenCalledWith(expect.objectContaining({ policyCode: "project_fact_relevance" }));
  });

  it("rejects a low typed score and remains fail closed", async () => {
    const score = vi.fn(async () => ({
      kind: "score" as const,
      value: 4,
      confidence: 0.95,
      provider: "openrouter" as const,
      policyCode: "project_fact_relevance",
    }));
    await expect(gateStructuredFacts("refund window", [candidate("shipping status")], { score } as never)).resolves.toEqual([]);
  });

  it("falls back to deterministic relevance when the sentry is unavailable", async () => {
    const score = vi.fn(async () => { throw new Error("gateway unavailable"); });
    const result = await gateStructuredFacts("refund window", [candidate("refund policy window 30 days")], { score } as never);
    expect(result).toHaveLength(1);
  });

  it("does not fall back to trust alone when Jev/Laya fails", async () => {
    const score = vi.fn(async () => { throw new Error("system one offline"); });
    const result = await gateStructuredFacts("launch budget", [
      { id: "unrelated", layer: "structured_fact", text: "office color blue", score: 1 },
      { id: "related", layer: "structured_fact", text: "launch budget approved", score: 1 },
    ], { score } as never);
    expect(result.map((candidate) => candidate.id)).toEqual(["related"]);
  });
});
