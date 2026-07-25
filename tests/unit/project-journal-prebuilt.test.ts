// The project-journal prebuilt — the ops an agent actually calls.
//
// The security-relevant property here is that a journal is addressed by the RUN's own projectId,
// never by an argument: an agent working in project A must not be able to read or rewrite
// project B's state by passing a different id. That is asserted directly below.

import { describe, it, expect } from "vitest";
import { projectJournal } from "../../workers/agents/src/script-engine/prebuilt/project-journal.js";
import type { PrebuiltOpContext } from "../../workers/agents/src/script-engine/prebuilt/index.js";
import { parseJournal, journalKey, DEFAULT_JOURNAL_LIMITS } from "../../workers/agents/src/script-engine/project-journal.js";

function makeR2() {
  const store = new Map<string, string>();
  const bucket = {
    async put(key: string, value: unknown) {
      store.set(key, typeof value === "string" ? value : String(value));
      return {} as R2Object;
    },
    async get(key: string) {
      const v = store.get(key);
      if (v === undefined) return null;
      return { text: async () => v } as unknown as R2ObjectBody;
    },
    async delete(key: string) { store.delete(key); },
  } as unknown as R2Bucket;
  return { bucket, store };
}

function makeCtx(opts: { projectId?: string; spaceId?: string; complete?: (a: { prompt: string }) => Promise<{ text: string }> } = {}) {
  const { bucket, store } = makeR2();
  const ctx = {
    env: {
      spaceId: opts.spaceId ?? "space-1",
      agentId: "agent-1",
      tenantId: "tenant-1",
      sessionId: "sess-1",
      scriptsBucket: bucket,
      ...(opts.projectId ? { projectId: opts.projectId } : {}),
      ...(opts.complete
        ? {
            llmCaller: {
              callWithNativeWebSearch: async () => { throw new Error("not used"); },
              complete: async (a: { model: string; prompt: string }) => ({
                ...(await opts.complete!({ prompt: a.prompt })),
                tokens_used: 10, input_tokens: 5, output_tokens: 5,
              }),
            },
          }
        : {}),
    },
    run: async () => ({}),
  } as unknown as PrebuiltOpContext;
  return { ctx, store };
}

const op = (name: string) => projectJournal.operations[name]!;

describe("project-journal prebuilt — reading and writing", () => {
  it("logs an action and reads it back", async () => {
    const { ctx, store } = makeCtx({ projectId: "proj-1" });
    const logged = await op("project_journal.log")({ summary: "Provisioned the wallet" }, ctx) as { ok: boolean };
    expect(logged.ok).toBe(true);

    const read = await op("project_journal.read")({}, ctx) as { ok: boolean; activity: Array<{ summary: string; actor: string; threadId?: string }> };
    expect(read.ok).toBe(true);
    expect(read.activity).toHaveLength(1);
    expect(read.activity[0]?.summary).toBe("Provisioned the wallet");
    // Actor and thread default from the run's own identity, not from arguments.
    expect(read.activity[0]?.actor).toBe("agent-1");
    // No thread id was passed and the engine env carries none — better absent than invented.
    expect(read.activity[0]?.threadId).toBeUndefined();
    expect(store.has(journalKey("space-1", "proj-1"))).toBe(true);
  });

  it("sets goal, instructions and status, and keeps them on later logs", async () => {
    const { ctx } = makeCtx({ projectId: "proj-1" });
    await op("project_journal.set")({ goal: "Get paid reliably", instructions: "Never move money unapproved" }, ctx);
    await op("project_journal.log")({ summary: "did a thing" }, ctx);
    const read = await op("project_journal.read")({}, ctx) as { goal: string; instructions: string };
    expect(read.goal).toBe("Get paid reliably");
    expect(read.instructions).toBe("Never move money unapproved");
  });

  it("rejects a set with no recognised field rather than silently doing nothing", async () => {
    const { ctx } = makeCtx({ projectId: "proj-1" });
    await expect(op("project_journal.set")({ nonsense: "x" }, ctx)).rejects.toThrow(/requires at least one/);
  });

  it("reads a single section when asked, and names the valid ones when asked for a bad one", async () => {
    const { ctx } = makeCtx({ projectId: "proj-1" });
    await op("project_journal.set")({ status: "Awaiting KYC" }, ctx);
    const sec = await op("project_journal.read")({ section: "status" }, ctx) as { ok: boolean; value: string };
    expect(sec.value).toBe("Awaiting KYC");
    const bad = await op("project_journal.read")({ section: "nope" }, ctx) as { ok: boolean; reason: string };
    expect(bad.ok).toBe(false);
    expect(bad.reason).toContain("goal");
  });
});

describe("project-journal prebuilt — todos", () => {
  it("adds, dedupes and completes todos", async () => {
    const { ctx } = makeCtx({ projectId: "proj-1" });
    await op("project_journal.add_todo")({ text: "Add a payout destination" }, ctx);
    // Two threads working in parallel will add the same todo; that must not rot the list.
    const dup = await op("project_journal.add_todo")({ text: "add a PAYOUT destination" }, ctx) as { already_present: boolean; todos: unknown[] };
    expect(dup.already_present).toBe(true);
    expect(dup.todos).toHaveLength(1);

    const done = await op("project_journal.complete_todo")({ text: "Add a payout destination" }, ctx) as { ok: boolean; todos: Array<{ done: boolean }> };
    expect(done.ok).toBe(true);
    expect(done.todos[0]?.done).toBe(true);
  });

  it("reports a miss instead of silently succeeding on an unknown todo", async () => {
    const { ctx } = makeCtx({ projectId: "proj-1" });
    const r = await op("project_journal.complete_todo")({ text: "never existed" }, ctx) as { ok: boolean; reason: string };
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("never existed");
  });
});

describe("project-journal prebuilt — scoping is structural", () => {
  it("cannot be pointed at another project by argument", async () => {
    const { ctx, store } = makeCtx({ projectId: "proj-1" });
    // A hostile or confused agent passing someone else's project id changes nothing.
    await op("project_journal.log")({ summary: "mine", project_id: "proj-2", projectId: "proj-2" }, ctx);
    expect(store.has(journalKey("space-1", "proj-1"))).toBe(true);
    expect(store.has(journalKey("space-1", "proj-2"))).toBe(false);
  });

  it("refuses clearly when the run is not bound to a project", async () => {
    // The Space Assistant works space-wide and has no journal of its own; saying so is better
    // than silently writing a space-level file nobody reads.
    const { ctx, store } = makeCtx({});
    const r = await op("project_journal.log")({ summary: "x" }, ctx) as { ok: boolean; reason: string };
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("not bound to a project");
    expect(store.size).toBe(0);
  });

  it("two projects in one space keep separate journals", async () => {
    const a = makeCtx({ projectId: "proj-a" });
    await op("project_journal.log")({ summary: "wallet work" }, a.ctx);
    const readA = await op("project_journal.read")({}, a.ctx) as { activity: unknown[] };
    expect(readA.activity).toHaveLength(1);

    const b = makeCtx({ projectId: "proj-b" });
    const readB = await op("project_journal.read")({}, b.ctx) as { activity: unknown[] };
    expect(readB.activity).toHaveLength(0);
  });
});

describe("project-journal prebuilt — compaction through the op surface", () => {
  it("compacts automatically once logging pushes it over budget", async () => {
    const { ctx, store } = makeCtx({ projectId: "proj-1" });
    let last: { compacted: number; activity_entries: number } | null = null;
    for (let i = 0; i < DEFAULT_JOURNAL_LIMITS.maxActivityEntries + 5; i++) {
      last = await op("project_journal.log")({ summary: `action ${i}` }, ctx) as typeof last;
    }
    expect(last!.activity_entries).toBeLessThanOrEqual(DEFAULT_JOURNAL_LIMITS.maxActivityEntries);
    const md = store.get(journalKey("space-1", "proj-1"))!;
    expect(parseJournal(md).archive).not.toBe("");
  });

  it("uses the LLM summariser when one is wired", async () => {
    const prompts: string[] = [];
    const { ctx } = makeCtx({
      projectId: "proj-1",
      complete: async ({ prompt }) => { prompts.push(prompt); return { text: "Condensed history." }; },
    });
    for (let i = 0; i < DEFAULT_JOURNAL_LIMITS.maxActivityEntries + 5; i++) {
      await op("project_journal.log")({ summary: `action ${i}` }, ctx);
    }
    const read = await op("project_journal.read")({}, ctx) as { archive: string };
    expect(read.archive).toContain("Condensed history");
    expect(prompts[0]).toContain("EXISTING ARCHIVE");
  });

  it("still records the action when the summariser fails", async () => {
    // Losing a completed action because a background summariser was down is not acceptable.
    const { ctx } = makeCtx({
      projectId: "proj-1",
      complete: async () => { throw new Error("gateway down"); },
    });
    for (let i = 0; i < DEFAULT_JOURNAL_LIMITS.maxActivityEntries + 2; i++) {
      await op("project_journal.log")({ summary: `action ${i}` }, ctx);
    }
    const read = await op("project_journal.read")({}, ctx) as { activity: Array<{ summary: string }>; archive: string };
    expect(read.activity[read.activity.length - 1]?.summary).toContain(`action ${DEFAULT_JOURNAL_LIMITS.maxActivityEntries + 1}`);
    expect(read.archive).not.toBe("");
  });
});
