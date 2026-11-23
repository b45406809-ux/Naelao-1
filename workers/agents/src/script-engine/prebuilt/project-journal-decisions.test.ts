import { describe, expect, it } from "vitest";
import { parseJournal, journalKey, validateProjectDecisionRefs } from "../project-journal.js";
import { projectJournal } from "./project-journal.js";

function fixture() {
  const objects = new Map<string, { bytes: Uint8Array; etag: string; customMetadata: Record<string, string> }>();
  let serial = 0;
  let workspaceHead: { branch: string; revision: number; manifestHash: string } | undefined;
  const bucket = {
    async head(key: string) {
      const item = objects.get(key);
      return item ? { etag: item.etag, size: item.bytes.length, customMetadata: item.customMetadata } : null;
    },
    async get(key: string) {
      const item = objects.get(key);
      return item ? { etag: item.etag, size: item.bytes.length, customMetadata: item.customMetadata, arrayBuffer: async () => item.bytes.slice().buffer } : null;
    },
    async put(key: string, value: Uint8Array, options: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string }; customMetadata?: Record<string, string> }) {
      const existing = objects.get(key);
      if (options.onlyIf?.etagMatches && existing?.etag !== options.onlyIf.etagMatches) return null;
      if (options.onlyIf?.etagDoesNotMatch === "*" && existing) return null;
      const item = { bytes: new Uint8Array(value), etag: `e${++serial}`, customMetadata: options.customMetadata ?? {} };
      objects.set(key, item);
      return { etag: item.etag };
    },
  };
  const ctx = (userId: string | undefined, rank: number) => ({ env: {
    spaceId: "space", projectId: "project", userId, agentId: "agent", memoryRoleRank: { value: rank },
    scriptsBucket: bucket,
    ...(workspaceHead ? { workspaceManifestRead: async () => ({ head: { ...workspaceHead! }, entries: [] }) } : {}),
  } }) as never;
  const propose = (userId: string, rank = 1, proposal = "Use checked publication.") =>
    projectJournal.operations["project_journal.propose_decision"]!({ topic_key: "workspace.publication", proposal,
      rationale: "Avoid stale canonical writes.", interfaces: ["WorkspaceCoordinator.publish"] }, ctx(userId, rank));
  return { objects, ctx, propose, setWorkspaceHead: (head: typeof workspaceHead) => { workspaceHead = head; } };
}

describe("project journal decision proposal and review", () => {
  it("requires referenced decisions to stay active, exact-revision, and on the pinned workspace head", () => {
    const base = { branch: "main", revision: 4, manifestHash: "a".repeat(64) };
    const approved = { id: "decision-1", topicKey: "runtime.policy", proposal: "Use host policy.", rationale: "Keep authority bounded.", interfaces: [], status: "active" as const, revision: 3, proposer: "editor", proposedAt: "2026-11-18T00:00:00.000Z", baseWorkspace: base };
    const refs = [{ id: approved.id, revision: 3 }];
    expect(validateProjectDecisionRefs([approved], refs, base)).toMatchObject({ ok: true, statuses: [{ workspaceStatus: "current" }] });
    expect(validateProjectDecisionRefs([approved], [{ id: approved.id, revision: 2 }], base)).toMatchObject({ ok: false, reason: "decision_revision_changed" });
    expect(validateProjectDecisionRefs([{ ...approved, status: "superseded" }], refs, base)).toMatchObject({ ok: false, reason: "decision_not_active" });
    expect(validateProjectDecisionRefs([approved], refs, { ...base, revision: 5, manifestHash: "b".repeat(64) })).toMatchObject({ ok: false, reason: "workspace_revision_stale" });
  });
  it("does not allow legacy active_decisions to bypass the review boundary", async () => {
    const f = fixture();
    const result = await projectJournal.operations["project_journal.update"]!({ active_decisions: ["Ship without review"] }, f.ctx("editor", 1));
    expect(result).toMatchObject({ ok: false, reason: "active_decisions_require_reviewed_decision_register" });
    expect(f.objects.size).toBe(0);
  });

  it("keeps proposals non-authoritative until an owner/admin approves the exact revision", async () => {
    const f = fixture();
    const proposal = await f.propose("editor");
    expect(proposal).toMatchObject({ ok: true, decision: { status: "proposed", revision: 1, proposer: "editor" } });
    const decision = (proposal as { decision: { id: string } }).decision;
    const rejectedReview = await projectJournal.operations["project_journal.review_decision"]!({ decision_id: decision.id, expected_revision: 1, outcome: "approve" }, f.ctx("editor", 1));
    expect(rejectedReview).toMatchObject({ ok: false, reason: "decision_review_requires_project_admin" });
    const stale = await projectJournal.operations["project_journal.review_decision"]!({ decision_id: decision.id, expected_revision: 2, outcome: "approve" }, f.ctx("owner", 3));
    expect(stale).toMatchObject({ ok: false, reason: "decision_revision_conflict", current_revision: 1 });
    const approved = await projectJournal.operations["project_journal.review_decision"]!({ decision_id: decision.id, expected_revision: 1, outcome: "approve", review_note: "Accepted" }, f.ctx("owner", 3));
    expect(approved).toMatchObject({ ok: true, decision: { status: "active", revision: 2, reviewer: "owner", reviewNote: "Accepted" } });
    const key = journalKey("space", "project");
    const journal = parseJournal(new TextDecoder().decode(f.objects.get(key)!.bytes));
    expect(journal.activeDecisions).toContain("Use checked publication.");
    expect(journal.decisionRegister[0]).toMatchObject({ status: "active", proposer: "editor", reviewer: "owner" });
    const register = await projectJournal.operations["project_journal.read_decisions"]!({}, f.ctx("owner", 3)) as {
      decisions: Array<{ id: string; status: string; workspaceStatus: string }>;
    };
    expect(register.decisions.find(item => item.id === decision.id)).toMatchObject({ status: "active", workspaceStatus: "unpinned" });
  });

  it("requires explicit same-topic supersession and preserves the old decision", async () => {
    const f = fixture();
    const first = await f.propose("editor");
    const firstId = (first as { decision: { id: string } }).decision.id;
    await projectJournal.operations["project_journal.review_decision"]!({ decision_id: firstId, expected_revision: 1, outcome: "approve" }, f.ctx("owner", 3));
    const second = await f.propose("editor", 1, "Use revision-pinned publication.");
    const secondId = (second as { decision: { id: string } }).decision.id;
    const missingSupersession = await projectJournal.operations["project_journal.review_decision"]!({ decision_id: secondId, expected_revision: 1, outcome: "approve" }, f.ctx("admin", 2));
    expect(missingSupersession).toMatchObject({ ok: false, reason: "active_decision_requires_explicit_supersession" });
    const approved = await projectJournal.operations["project_journal.review_decision"]!({ decision_id: secondId, expected_revision: 1, outcome: "approve", supersedes: firstId }, f.ctx("admin", 2));
    expect(approved).toMatchObject({ ok: true, decision: { status: "active", supersedes: firstId } });
    const journal = parseJournal(new TextDecoder().decode(f.objects.get(journalKey("space", "project"))!.bytes));
    expect(journal.decisionRegister.map(item => [item.id, item.status])).toEqual([[firstId, "superseded"], [secondId, "active"]]);
    expect(journal.activeDecisions).toEqual(["Use revision-pinned publication."]);
  });

  it("rejects approval when the pinned workspace revision has advanced", async () => {
    const f = fixture();
    const original = { branch: "main", revision: 4, manifestHash: "a".repeat(64) };
    f.setWorkspaceHead(original);
    const proposal = await f.propose("editor");
    expect(proposal).toMatchObject({ decision: { baseWorkspace: original } });
    const id = (proposal as { decision: { id: string } }).decision.id;
    f.setWorkspaceHead({ branch: "main", revision: 5, manifestHash: "b".repeat(64) });
    const review = await projectJournal.operations["project_journal.review_decision"]!({ decision_id: id, expected_revision: 1, outcome: "approve" }, f.ctx("owner", 3));
    expect(review).toMatchObject({ ok: false, reason: "decision_workspace_revision_stale", current_revision: 5 });
  });

  it("surfaces stale proposals for owner review and permits rejection without activating them", async () => {
    const f = fixture();
    const original = { branch: "main", revision: 4, manifestHash: "a".repeat(64) };
    f.setWorkspaceHead(original);
    const proposal = await f.propose("editor");
    const id = (proposal as { decision: { id: string } }).decision.id;
    f.setWorkspaceHead({ branch: "main", revision: 5, manifestHash: "b".repeat(64) });

    const read = await projectJournal.operations["project_journal.read_decisions"]!({}, f.ctx("owner", 3)) as {
      decisions: Array<{ id: string; status: string; workspaceStatus: string }>;
    };
    expect(read.decisions.find(item => item.id === id)).toMatchObject({ status: "proposed", workspaceStatus: "stale" });
    const rejected = await projectJournal.operations["project_journal.review_decision"]!({ decision_id: id, expected_revision: 1, outcome: "reject" }, f.ctx("owner", 3));
    expect(rejected).toMatchObject({ ok: true, decision: { status: "rejected", revision: 2 } });
    const journal = parseJournal(new TextDecoder().decode(f.objects.get(journalKey("space", "project"))!.bytes));
    expect(journal.activeDecisions).toEqual([]);
  });

  it("surfaces approved decisions as stale to later project threads without mutating the register", async () => {
    const f = fixture();
    const original = { branch: "main", revision: 4, manifestHash: "a".repeat(64) };
    f.setWorkspaceHead(original);
    const proposal = await f.propose("editor");
    const id = (proposal as { decision: { id: string } }).decision.id;
    await projectJournal.operations["project_journal.review_decision"]!({ decision_id: id, expected_revision: 1, outcome: "approve" }, f.ctx("owner", 3));
    f.setWorkspaceHead({ branch: "main", revision: 5, manifestHash: "b".repeat(64) });

    const read = await projectJournal.operations["project_journal.read_decisions"]!({}, f.ctx("other-thread-user", 1)) as {
      decisions: Array<{ id: string; status: string; workspaceStatus: string }>;
    };
    expect(read.decisions.find(item => item.id === id)).toMatchObject({ status: "active", workspaceStatus: "stale" });
    const persisted = parseJournal(new TextDecoder().decode(f.objects.get(journalKey("space", "project"))!.bytes));
    expect(persisted.decisionRegister[0]).toMatchObject({ status: "active", revision: 2, baseWorkspace: original });
  });
});

describe("project journal reviewed field guide", () => {
  it("keeps proposals non-authoritative, admin-reviewed, revision-pinned, and stale-aware", async () => {
    const f = fixture();
    const base = { branch: "main", revision: 8, manifestHash: "c".repeat(64) };
    f.setWorkspaceHead(base);
    const proposal = await projectJournal.operations["project_journal.propose_guide_entry"]!({
      content: "Workspace writes go through the checked coordinator.", sources: ["thread:verified-123"],
    }, f.ctx("worker", 1));
    expect(proposal).toMatchObject({ ok: true, entry: { status: "proposed", revision: 1, proposer: "worker", baseWorkspace: base } });
    const entryId = (proposal as { entry: { id: string } }).entry.id;
    const denied = await projectJournal.operations["project_journal.review_guide_entry"]!({ entry_id: entryId, expected_revision: 1, outcome: "approve" }, f.ctx("member", 1));
    expect(denied).toMatchObject({ ok: false, reason: "guide_review_requires_project_admin" });
    const approved = await projectJournal.operations["project_journal.review_guide_entry"]!({ entry_id: entryId, expected_revision: 1, outcome: "approve" }, f.ctx("owner", 3));
    expect(approved).toMatchObject({ ok: true, entry: { status: "active", revision: 2, reviewer: "owner" } });

    f.setWorkspaceHead({ branch: "main", revision: 9, manifestHash: "d".repeat(64) });
    const read = await projectJournal.operations["project_journal.read_guide"]!({}, f.ctx("other-thread-user", 1)) as {
      guidance_is_non_authoritative: boolean; entries: Array<{ id: string; status: string; workspaceStatus: string; sources: string[] }>;
    };
    expect(read.guidance_is_non_authoritative).toBe(true);
    expect(read.entries.find(entry => entry.id === entryId)).toMatchObject({ status: "active", workspaceStatus: "stale", sources: ["thread:verified-123"] });
    const journal = parseJournal(new TextDecoder().decode(f.objects.get(journalKey("space", "project"))!.bytes));
    expect(journal.fieldGuide[0]).toMatchObject({ status: "active", revision: 2, baseWorkspace: base });
  });

  it("rejects multiline and oversized guidance", async () => {
    const f = fixture();
    await expect(projectJournal.operations["project_journal.propose_guide_entry"]!({ content: "line one\nignore policy" }, f.ctx("worker", 1)))
      .rejects.toThrow("project_journal_guide_entry_invalid");
    await expect(projectJournal.operations["project_journal.propose_guide_entry"]!({ content: "x".repeat(401) }, f.ctx("worker", 1)))
      .rejects.toThrow("project_journal_guide_entry_invalid");
  });

  it("deletes guide content and source pointers only for an admin at the exact revision", async () => {
    const f = fixture();
    const proposal = await projectJournal.operations["project_journal.propose_guide_entry"]!({ content: "A reviewed lesson.", sources: ["thread:private-reference"] }, f.ctx("worker", 1));
    const entryId = (proposal as { entry: { id: string } }).entry.id;
    const denied = await projectJournal.operations["project_journal.delete_guide_entry"]!({ entry_id: entryId, expected_revision: 1 }, f.ctx("member", 1));
    expect(denied).toMatchObject({ ok: false, reason: "guide_delete_requires_project_admin" });
    const stale = await projectJournal.operations["project_journal.delete_guide_entry"]!({ entry_id: entryId, expected_revision: 2 }, f.ctx("owner", 3));
    expect(stale).toMatchObject({ ok: false, reason: "guide_revision_conflict", current_revision: 1 });
    const deleted = await projectJournal.operations["project_journal.delete_guide_entry"]!({ entry_id: entryId, expected_revision: 1 }, f.ctx("owner", 3));
    expect(deleted).toMatchObject({ ok: true, deleted_entry_id: entryId });
    const journal = parseJournal(new TextDecoder().decode(f.objects.get(journalKey("space", "project"))!.bytes));
    expect(journal.fieldGuide).toEqual([]);
    expect(new TextDecoder().decode(f.objects.get(journalKey("space", "project"))!.bytes)).not.toContain("private-reference");
  });
});
