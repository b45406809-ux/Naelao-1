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
});
