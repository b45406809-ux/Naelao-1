import { describe, expect, it, vi } from "vitest";
import { spaceBlackboard } from "./space-blackboard.js";
import type { PrebuiltOpContext } from "./index.js";

describe("space blackboard commands", () => {
  it("rejects publication without a project or host-verified user", async () => {
    const ctx = { env: { tenantId: "tenant", spaceId: "space", platformSecret: "secret", spacesWorker: { fetch: vi.fn() } } } as unknown as PrebuiltOpContext;
    await expect(spaceBlackboard.operations["blackboard.publish"]!({ summary: "private" }, ctx)).rejects.toThrow("blackboard_project_context_required");
    ctx.env.projectId = "project";
    await expect(spaceBlackboard.operations["blackboard.publish"]!({ summary: "private" }, ctx)).rejects.toThrow("blackboard_publication_consent_required");
    ctx.env.authorizeBlackboardPublication = async () => true;
    await expect(spaceBlackboard.operations["blackboard.publish"]!({ summary: "private" }, ctx)).rejects.toThrow("blackboard_user_context_required");
  });
  it("searches only the cards returned by the host and reports truncation", async () => {
    const fetch = vi.fn(async () => Response.json({ truncated: true, cards: [{ projectId: "p", summary: "shipment tracking", capabilities: [], evidence: [], updatedAt: "2026-01-01T00:00:00Z" }] }));
    const ctx = { env: { tenantId: "tenant", spaceId: "space", userId: "user", platformSecret: "secret", spacesWorker: { fetch } } } as unknown as PrebuiltOpContext;
    const result = await spaceBlackboard.operations["blackboard.search"]!({ query: "shipment" }, ctx) as { candidates: unknown[]; truncated: boolean; untrusted: boolean };
    expect(result.candidates).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(result.untrusted).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("requires host consent before sharing a request and binds its source to the current project", async () => {
    const fetch = vi.fn(async (_request: Request) => Response.json({ request: { status: "pending" } }));
    const ctx = { env: { tenantId: "tenant", spaceId: "space", projectId: "source", userId: "user", platformSecret: "secret", spacesWorker: { fetch } } } as unknown as PrebuiltOpContext;
    const args = { id: "req-1", target_project_id: "target", source_project_id: "forged", objective: "Help", expected_result: "Result" };
    await expect(spaceBlackboard.operations["blackboard.request"]!(args, ctx)).rejects.toThrow("blackboard_request_consent_required");
    expect(fetch).not.toHaveBeenCalled();
    ctx.env.authorizeBlackboardAction = async (action, input) => action === "blackboard.request" && input === args;
    await spaceBlackboard.operations["blackboard.request"]!(args, ctx);
    const request = fetch.mock.calls[0]![0] as Request;
    expect(await request.json()).toMatchObject({ source_project_id: "source", target_project_id: "target" });
  });
  it("passes a valid search cursor to the host and rejects invalid cursors", async () => {
    const fetch = vi.fn(async (_request: Request) => Response.json({ cards: [], next_cursor: "next", truncated: true }));
    const ctx = { env: { tenantId: "tenant", spaceId: "space", userId: "user", platformSecret: "secret", spacesWorker: { fetch } } } as unknown as PrebuiltOpContext;
    const result = await spaceBlackboard.operations["blackboard.search"]!({ query: "shipping", after: "project-1", max_pages: 1 }, ctx) as { next_cursor: string };
    expect(result.next_cursor).toBe("next");
    expect(new URL(fetch.mock.calls[0]![0].url).searchParams.get("after")).toBe("project-1");
    await expect(spaceBlackboard.operations["blackboard.search"]!({ query: "shipping", after: "../other" }, ctx)).rejects.toThrow("blackboard_cursor_invalid");
  });
  it("scans a bounded cursor batch and ranks hits from later pages before returning the continuation cursor", async () => {
    const fetch = vi.fn(async (request: Request) => {
      const after = new URL(request.url).searchParams.get("after");
      if (after === null) return Response.json({ cards: [{ projectId: "first", summary: "ordinary project", capabilities: [], evidence: [], updatedAt: "2026-01-01T00:00:00Z" }], next_cursor: "page-1", truncated: true });
      if (after === "page-1") return Response.json({ cards: [{ projectId: "target", summary: "needle routing task", capabilities: [], evidence: [], updatedAt: "2026-01-01T00:00:00Z" }], next_cursor: "page-2", truncated: true });
      return Response.json({ cards: [], next_cursor: null, truncated: false });
    });
    const ctx = { env: { tenantId: "tenant", spaceId: "space", userId: "user", platformSecret: "secret", spacesWorker: { fetch } } } as unknown as PrebuiltOpContext;
    const result = await spaceBlackboard.operations["blackboard.search"]!({ query: "needle routing" }, ctx) as {
      candidates: Array<{ card: { projectId: string } }>;
      pages_scanned: number;
      next_cursor: string | null;
      truncated: boolean;
    };
    expect(result.candidates[0]?.card.projectId).toBe("target");
    expect(result.pages_scanned).toBe(3);
    expect(result.next_cursor).toBeNull();
    expect(result.truncated).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("rejects cursor batch sizes above the bounded maximum", async () => {
    const fetch = vi.fn();
    const ctx = { env: { tenantId: "t", spaceId: "s", userId: "u", platformSecret: "secret", spacesWorker: { fetch } } } as unknown as PrebuiltOpContext;
    await expect(spaceBlackboard.operations["blackboard.search"]!({ query: "needle", max_pages: 11 }, ctx)).rejects.toThrow("blackboard_max_pages_out_of_range");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("prepares a reviewable journal draft without publishing private instructions or making a network call", async () => {
    const fetch = vi.fn();
    const ctx = { env: { projectId: "p", spacesWorker: { fetch } }, run: vi.fn(async () => ({ ok: true, goal: "Improve tracking", status: "In progress", instructions: "private", archive: "private" })) } as unknown as PrebuiltOpContext;
    const result = await spaceBlackboard.operations["blackboard.prepare_journal"]!({}, ctx) as { draft: { summary: string }; published: boolean };
    expect(result.published).toBe(false);
    expect(result.draft.summary).toBe("Goal: Improve tracking\nStatus: In progress");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("uses decision triage only when requested and falls back to lexical candidates on failure", async () => {
    const score = vi.fn().mockRejectedValue(new Error("unavailable"));
    const fetch = vi.fn(async () => Response.json({ cards: [{ projectId: "p", summary: "shipment tracking", capabilities: [], evidence: ["private-link"], updatedAt: "2026-01-01T00:00:00Z" }] }));
    const ctx = { env: { tenantId: "t", spaceId: "s", userId: "u", platformSecret: "secret", spacesWorker: { fetch }, fastDecision: { score } } } as unknown as PrebuiltOpContext;
    await spaceBlackboard.operations["blackboard.search"]!({ query: "shipment" }, ctx);
    expect(score).not.toHaveBeenCalled();
    const result = await spaceBlackboard.operations["blackboard.search"]!({ query: "shipment", model_triage: true }, ctx) as { candidates: unknown[]; triage?: unknown };
    expect(result.candidates).toHaveLength(1);
    expect(result.triage).toBeUndefined();
    expect(JSON.stringify(score.mock.calls[0])).not.toContain("private-link");
  });
  it("reranks at most five shared cards by decision score and preserves lexical order for the rest", async () => {
    const cards = [
      { projectId: "a", summary: "shipment tracking", capabilities: [], evidence: [], updatedAt: "2026-01-01T00:00:00Z" },
      { projectId: "b", summary: "shipment tracking strong match", capabilities: [], evidence: [], updatedAt: "2026-01-01T00:00:00Z" },
      { projectId: "c", summary: "shipment tracking possible match", capabilities: [], evidence: [], updatedAt: "2026-01-01T00:00:00Z" },
      ...Array.from({ length: 18 }, (_, index) => ({ projectId: `extra-${String(index).padStart(2, "0")}`, summary: "shipment tracking", capabilities: [], evidence: [], updatedAt: "2026-01-01T00:00:00Z" })),
    ];
    const score = vi.fn(async ({ state }: { state: { summary: string } }) => ({
      value: state.summary.includes("strong match") ? 2 : state.summary.includes("possible match") ? 1 : 0,
      provider: "decisions-test",
      latencyMs: 12,
      usage: { inputTokens: 100, outputTokens: 5, costUsd: 0.001 },
    }));
    const fetch = vi.fn(async () => Response.json({ cards }));
    const ctx = { env: { tenantId: "t", spaceId: "s", userId: "u", platformSecret: "secret", spacesWorker: { fetch }, fastDecision: { score } } } as unknown as PrebuiltOpContext;
    const result = await spaceBlackboard.operations["blackboard.search"]!({ query: "shipment tracking", model_triage: true }, ctx) as {
      candidates: Array<{ card: { projectId: string } }>;
      triage: Array<{ projectId: string; latencyMs?: number; usage?: { costUsd?: number } }>;
      triage_usage: { calls: number; calls_with_usage: number; input_tokens: number; output_tokens: number; provider_reported_cost_usd: number | null; latency_ms: number[] };
    };
    expect(score).toHaveBeenCalledTimes(5);
    expect(result.candidates.slice(0, 5).map(candidate => candidate.card.projectId)).toEqual(["b", "c", "a", "extra-00", "extra-01"]);
    expect(result.candidates.slice(5).map(candidate => candidate.card.projectId)).toEqual(cards.slice(5, 20).map(card => card.projectId));
    expect(result.triage.map(item => item.projectId)).toEqual(["a", "b", "c", "extra-00", "extra-01"]);
    expect(result.triage_usage).toEqual({ calls: 5, calls_with_usage: 5, input_tokens: 500, output_tokens: 25, latency_ms: [12, 12, 12, 12, 12], provider_reported_cost_usd: 0.005 });
    expect(result.triage[0]?.usage?.costUsd).toBe(0.001);
  });
  it("does not invent a cost when the decision adapter supplies token usage without price evidence", async () => {
    const score = vi.fn(async () => ({ value: 1, provider: "decisions-test", usage: { inputTokens: 40, outputTokens: 3 } }));
    const fetch = vi.fn(async () => Response.json({ cards: [{ projectId: "p", summary: "shipment tracking", capabilities: [], evidence: [], updatedAt: "2026-01-01T00:00:00Z" }] }));
    const ctx = { env: { tenantId: "t", spaceId: "s", userId: "u", platformSecret: "secret", spacesWorker: { fetch }, fastDecision: { score } } } as unknown as PrebuiltOpContext;
    const result = await spaceBlackboard.operations["blackboard.search"]!({ query: "shipment", model_triage: true }, ctx) as { triage_usage: { input_tokens: number; output_tokens: number; provider_reported_cost_usd: number | null } };
    expect(result.triage_usage).toMatchObject({ input_tokens: 40, output_tokens: 3, provider_reported_cost_usd: null });
  });
});
