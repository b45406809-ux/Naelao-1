import { describe, expect, it } from "vitest";
import { rankSharedCards, transitionRequest, validateSharedCard } from "./blackboard-domain.js";

describe("space blackboard domain", () => {
  it("accepts only bounded explicitly shared cards", () => {
    const card = { projectId: "p1", summary: " Solve shipping exceptions ", capabilities: ["tracking", "tracking"], evidence: [], updatedAt: "2026-01-01T00:00:00Z" };
    expect(validateSharedCard(card).capabilities).toEqual(["tracking"]);
    expect(() => validateSharedCard({ ...card, projectId: "../other" })).toThrow();
    expect(() => validateSharedCard({ ...card, summary: "x".repeat(4001) })).toThrow();
  });
  it("prevents either party from completing unaccepted work", () => {
    expect(transitionRequest("pending", "accept", "receiver")).toBe("accepted");
    expect(transitionRequest("accepted", "complete", "receiver")).toBe("completed");
    expect(() => transitionRequest("pending", "complete", "receiver")).toThrow();
    expect(() => transitionRequest("accepted", "complete", "requester")).toThrow();
    expect(() => transitionRequest("cancelled", "accept", "receiver")).toThrow();
  });
  it("returns only matching candidates in deterministic order", () => {
    const card = (projectId: string, summary: string) => ({ projectId, summary, capabilities: [], evidence: [], updatedAt: "2026-01-01T00:00:00Z" });
    expect(rankSharedCards("shipping delay", [card("b", "shipping"), card("a", "shipping delay"), card("c", "billing")]).map(item => item.card.projectId)).toEqual(["a", "b"]);
  });
});
