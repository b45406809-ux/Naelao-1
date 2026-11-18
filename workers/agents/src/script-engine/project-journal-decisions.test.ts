import { describe, expect, it } from "vitest";
import { emptyJournal, parseJournal, renderJournal, type JournalDecision } from "./project-journal.js";

const decision: JournalDecision = {
  id: "decision-1", topicKey: "workspace.publication", proposal: "Publish only through checked CAS.",
  rationale: "Prevents stale writers from replacing the canonical head.", interfaces: ["WorkspaceCoordinator.publish"],
  status: "active", revision: 2, proposer: "user-a", proposedAt: "2026-11-17T00:00:00.000Z",
  baseWorkspace: { branch: "main", revision: 7, manifestHash: "a".repeat(64) },
  reviewer: "user-owner", reviewedAt: "2026-11-17T01:00:00.000Z", reviewNote: "Approved with current-head check.",
};

describe("versioned project decision register", () => {
  it("round trips provenance, revision, review and legacy active-decision compatibility", () => {
    const journal = { ...emptyJournal("Project"), activeDecisions: [decision.proposal], decisionRegister: [decision] };
    const restored = parseJournal(renderJournal(journal));
    expect(restored.decisionRegister).toEqual([decision]);
    expect(restored.activeDecisions).toEqual([decision.proposal]);
  });

  it("ignores malformed and oversized decision lines without trusting them as active policy", () => {
    const text = `${renderJournal(emptyJournal())}\n- {"id":"bad","topicKey":"x","proposal":"unsafe","rationale":"x","interfaces":[],"status":"active","revision":-1,"proposer":"x","proposedAt":"now"}`;
    expect(parseJournal(text).decisionRegister).toEqual([]);
  });
});
