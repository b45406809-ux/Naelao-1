import { describe, expect, it } from "vitest";
import {
  rankSharedCards,
  rerankSharedCards,
  transitionRequest,
  validateSharedCard,
} from "./blackboard-domain.js";

describe("space blackboard domain", () => {
  it("accepts only bounded explicitly shared cards", () => {
    const card = {
      projectId: "p1",
      summary: " Solve shipping exceptions ",
      capabilities: ["tracking", "tracking"],
      evidence: [],
      updatedAt: "2026-01-01T00:00:00Z",
    };
    expect(validateSharedCard(card).capabilities).toEqual(["tracking"]);
    expect(() =>
      validateSharedCard({ ...card, projectId: "../other" })
    ).toThrow();
    expect(() =>
      validateSharedCard({ ...card, summary: "x".repeat(4001) })
    ).toThrow();
  });
  it("prevents either party from completing unaccepted work", () => {
    expect(transitionRequest("pending", "accept", "receiver")).toBe("accepted");
    expect(transitionRequest("accepted", "complete", "receiver")).toBe(
      "completed"
    );
    expect(() =>
      transitionRequest("pending", "complete", "receiver")
    ).toThrow();
    expect(() =>
      transitionRequest("accepted", "complete", "requester")
    ).toThrow();
    expect(() =>
      transitionRequest("cancelled", "accept", "receiver")
    ).toThrow();
  });
  it("returns only matching candidates in deterministic order", () => {
    const card = (projectId: string, summary: string) => ({
      projectId,
      summary,
      capabilities: [],
      evidence: [],
      updatedAt: "2026-01-01T00:00:00Z",
    });
    expect(
      rankSharedCards("shipping delay", [
        card("b", "shipping"),
        card("a", "shipping delay"),
        card("c", "billing"),
      ]).map((item) => item.card.projectId)
    ).toEqual(["a", "b"]);
  });
  it("can include zero-match cards for a separately bounded semantic candidate-pool experiment", () => {
    const card = (projectId: string, summary: string) => ({
      projectId,
      summary,
      capabilities: [],
      evidence: [],
      updatedAt: "2026-01-01T00:00:00Z",
    });
    const cards = [card("a", "freight clearance"), card("b", "clinic visits")];
    expect(
      rankSharedCards("repair a resident's broken tap", cards)
    ).toHaveLength(0);
    expect(
      rankSharedCards("repair a resident's broken tap", cards, {
        includeZeroScore: true,
      }).map((item) => item.card.projectId)
    ).toEqual(["a", "b"]);
  });
  it("reranks scored candidates while retaining lexical order for unscored cards and ties", () => {
    const card = (projectId: string, score: number) => ({
      card: {
        projectId,
        summary: projectId,
        capabilities: [],
        evidence: [],
        updatedAt: "2026-01-01T00:00:00Z",
      },
      score,
    });
    const candidates = [card("a", 3), card("b", 2), card("c", 1)];
    expect(
      rerankSharedCards(
        candidates,
        new Map([
          ["b", 2],
          ["a", 2],
        ])
      ).map((item) => item.card.projectId)
    ).toEqual(["a", "b", "c"]);
    expect(
      rerankSharedCards(candidates, new Map([["c", 2]])).map(
        (item) => item.card.projectId
      )
    ).toEqual(["c", "a", "b"]);
  });
});
