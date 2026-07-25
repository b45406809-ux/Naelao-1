// The Project Journal — the file that lets an assistant answer "where is this project at?"
// without reading every thread in it.
//
// The compaction rules are the part with real risk: a bug here silently loses completed work,
// which is worse than any other failure this file could have, because the whole promise is that
// an agent can trust it rather than redoing what a sibling thread already did.

import { describe, it, expect } from "vitest";
import {
  parseJournal,
  renderJournal,
  emptyJournal,
  appendActivity,
  compactJournal,
  needsCompaction,
  deterministicSummary,
  byteLength,
  journalKey,
  DEFAULT_JOURNAL_LIMITS,
  type JournalActivity,
  type ProjectJournal,
} from "../../workers/agents/src/script-engine/project-journal.js";

function activity(n: number, actor = "agent-1", text = "did a thing"): JournalActivity[] {
  return Array.from({ length: n }, (_, i) => ({
    at: `2026-07-${String((i % 28) + 1).padStart(2, "0")}T10:00:00.000Z`,
    actor,
    summary: `${text} #${i}`,
  }));
}

describe("project journal — round-trips through markdown", () => {
  it("renders and re-parses every field without loss", () => {
    const j: ProjectJournal = {
      name: "Wallet",
      goal: "Get the business paid reliably.",
      instructions: "Never move money without owner approval.",
      status: "Wallet provisioned, awaiting KYC.",
      todos: [
        { text: "Add a payout destination", done: false, at: "2026-07-01T00:00:00.000Z" },
        { text: "Verify the Whop account", done: true, at: "2026-07-02T00:00:00.000Z" },
      ],
      activity: [
        { at: "2026-07-01T09:00:00.000Z", actor: "agent-1", summary: "Provisioned the wallet", threadId: "t-1" },
        { at: "2026-07-02T09:00:00.000Z", actor: "owner", summary: "Approved the first payout" },
      ],
      archive: "Earlier: initial setup.",
    };
    const round = parseJournal(renderJournal(j));
    expect(round).toEqual(j);
  });

  it("treats an unreadable file as an empty journal rather than throwing", () => {
    // This sits on the path of every logged action; it must never be the thing that breaks one.
    expect(parseJournal("")).toEqual(emptyJournal());
    expect(parseJournal("total garbage, no structure at all").activity).toEqual([]);
    expect(parseJournal(undefined as unknown as string)).toEqual(emptyJournal());
  });

  it("survives a human hand-editing the file", () => {
    // A builder opening PROJECT.md and typing into it must not corrupt agent reads.
    const md = [
      "# My Project",
      "",
      "## Goal",
      "Ship it",
      "",
      "## Scratch notes",       // an unknown section a human added
      "ignore me",
      "",
      "## Todos",
      "- [ ] one thing",
      "some prose that is not a todo",
      "",
      "## Activity",
      "- 2026-07-01T00:00:00.000Z [me] started",
    ].join("\n");
    const j = parseJournal(md);
    expect(j.goal).toBe("Ship it");
    expect(j.todos).toHaveLength(1);
    expect(j.todos[0]?.text).toBe("one thing");
    expect(j.activity).toHaveLength(1);
  });
});

describe("project journal — stays bounded", () => {
  it("does not compact a journal that is within budget", async () => {
    const j = { ...emptyJournal("P"), activity: activity(5) };
    expect(needsCompaction(j)).toBe(false);
    const r = await compactJournal(j);
    expect(r.compacted).toBe(0);
    expect(r.journal.activity).toHaveLength(5);
  });

  it("folds the oldest entries into the archive once over the entry limit", async () => {
    const j = { ...emptyJournal("P"), activity: activity(DEFAULT_JOURNAL_LIMITS.maxActivityEntries + 10) };
    const r = await compactJournal(j);
    expect(r.compacted).toBeGreaterThan(0);
    expect(r.journal.activity.length).toBeLessThanOrEqual(DEFAULT_JOURNAL_LIMITS.maxActivityEntries);
    expect(r.journal.archive).not.toBe("");
    // The NEWEST entries are what remain — the recent past is what an agent acts on.
    const last = r.journal.activity[r.journal.activity.length - 1];
    expect(last?.summary).toContain(`#${DEFAULT_JOURNAL_LIMITS.maxActivityEntries + 9}`);
  });

  it("keeps the rendered file under the byte ceiling even with very long entries", async () => {
    // A handful of enormous entries can blow the budget without exceeding the entry count —
    // compaction loops rather than assuming one batch is enough.
    const huge = Array.from({ length: 20 }, (_, i) => ({
      at: `2026-07-01T00:00:0${i % 10}.000Z`,
      actor: "agent-1",
      summary: "x".repeat(3000),
    }));
    const r = await compactJournal({ ...emptyJournal("P"), activity: huge });
    expect(byteLength(renderJournal(r.journal))).toBeLessThanOrEqual(DEFAULT_JOURNAL_LIMITS.maxBytes);
  });

  it("never empties the activity log completely", async () => {
    // A project whose entire recent history vanished reads as if nothing is happening, which is
    // a worse failure than being slightly over budget.
    const huge = Array.from({ length: 5 }, () => ({
      at: "2026-07-01T00:00:00.000Z",
      actor: "a",
      summary: "y".repeat(20_000),
    }));
    const r = await compactJournal({ ...emptyJournal("P"), activity: huge });
    expect(r.journal.activity.length).toBeGreaterThanOrEqual(1);
  });
});

describe("project journal — compaction never loses work", () => {
  it("uses the summariser when one is available", async () => {
    const seen: JournalActivity[][] = [];
    const r = await compactJournal({ ...emptyJournal("P"), activity: activity(100) }, async (entries) => {
      seen.push(entries);
      return "A dense summary of what happened.";
    });
    expect(r.usedSummarizer).toBe(true);
    expect(r.journal.archive).toContain("dense summary");
    expect(seen.length).toBeGreaterThan(0);
  });

  it("falls back to the deterministic rollup when the summariser throws", async () => {
    // An LLM outage must not cost the project its history.
    const r = await compactJournal({ ...emptyJournal("P"), activity: activity(100) }, async () => {
      throw new Error("gateway down");
    });
    expect(r.usedSummarizer).toBe(false);
    expect(r.compacted).toBeGreaterThan(0);
    expect(r.journal.archive).toContain("earlier action(s)");
  });

  it("falls back when the summariser returns nothing usable", async () => {
    const r = await compactJournal({ ...emptyJournal("P"), activity: activity(100) }, async () => "   ");
    expect(r.usedSummarizer).toBe(false);
    expect(r.journal.archive).not.toBe("");
  });

  it("the deterministic rollup reports every actor and the real date span", async () => {
    const mixed = [
      { at: "2026-07-01T00:00:00.000Z", actor: "agent-1", summary: "first" },
      { at: "2026-07-05T00:00:00.000Z", actor: "agent-2", summary: "second" },
      { at: "2026-07-09T00:00:00.000Z", actor: "agent-1", summary: "third" },
    ];
    const s = deterministicSummary(mixed);
    expect(s).toContain("3 earlier action(s)");
    expect(s).toContain("2026-07-01 to 2026-07-09");
    expect(s).toContain("agent-1");
    expect(s).toContain("agent-2");
  });
});

describe("project journal — appending", () => {
  it("appends newest-last and compacts in the same call when needed", async () => {
    const j = { ...emptyJournal("P"), activity: activity(DEFAULT_JOURNAL_LIMITS.maxActivityEntries) };
    const r = await appendActivity(j, { at: "2026-07-28T00:00:00.000Z", actor: "agent-9", summary: "the newest thing" });
    const last = r.journal.activity[r.journal.activity.length - 1];
    expect(last?.summary).toBe("the newest thing");
    expect(r.journal.activity.length).toBeLessThanOrEqual(DEFAULT_JOURNAL_LIMITS.maxActivityEntries);
  });

  it("preserves the thread reference so a reader can jump to the full conversation", async () => {
    const r = await appendActivity(emptyJournal("P"), {
      at: "2026-07-01T00:00:00.000Z",
      actor: "agent-1",
      summary: "wrote ledger.csv",
      threadId: "thread-abc",
    });
    expect(parseJournal(renderJournal(r.journal)).activity[0]?.threadId).toBe("thread-abc");
  });
});

describe("project journal — key scoping", () => {
  it("scopes the file per project, as a sibling of the workspace not inside it", () => {
    // Inside workspace/ an ordinary file write could spoof or clobber it, and it would clutter
    // every workspace listing.
    const key = journalKey("space-1", "proj-1");
    expect(key).toBe("spaces/space-1/projects/proj-1/PROJECT.md");
    expect(key).not.toContain("/workspace/");
    expect(journalKey("space-1", "proj-2")).not.toBe(key);
  });
});
