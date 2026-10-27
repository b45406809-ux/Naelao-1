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
    const result = await spaceBlackboard.operations["blackboard.search"]!({ query: "shipping", after: "project-1" }, ctx) as { next_cursor: string };
    expect(result.next_cursor).toBe("next");
    expect(new URL(fetch.mock.calls[0]![0].url).searchParams.get("after")).toBe("project-1");
    await expect(spaceBlackboard.operations["blackboard.search"]!({ query: "shipping", after: "../other" }, ctx)).rejects.toThrow("blackboard_cursor_invalid");
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
});
