import { describe, expect, it } from "vitest";
import { emptyJournal, finalizeCompletedJournal } from "./project-journal.js";

describe("finite project final milestone", () => {
  it("records one terminal milestone when all journal tasks are complete", () => {
    const journal = { ...emptyJournal("Build"), todos: [{ text: "ship", done: true }] };
    const done = finalizeCompletedJournal(journal, "2026-09-28T00:00:00.000Z");
    expect(done.status).toBe("HIBERNATED_COMPLETED");
    expect(finalizeCompletedJournal(done, "later").activity).toHaveLength(1);
  });
  it("does not hibernate while work remains", () => {
    const journal = { ...emptyJournal(), todos: [{ text: "ship", done: false }] };
    expect(finalizeCompletedJournal(journal, "now")).toBe(journal);
  });
});
