/**
 * project-journal — the project's shared, durable "what is going on here" file.
 *
 * Memory OS already shares Layers 3/4/6 across a project and keeps Layer 5 private per
 * (thread, agent). That boundary is right: one thread's conversational meandering must not
 * contaminate another thread's reasoning. But it leaves project STATE homeless — "invoice.csv
 * now exists", "the payout task is done" is neither a semantic fact nor a private episode, and
 * without somewhere to put it two agents in two threads happily redo each other's work.
 *
 * This prebuilt is that place. One markdown file per project (see project-journal.ts for the
 * format and the compaction rules), read on demand — never injected into every LLM call, which
 * is the whole reason it can afford to hold real detail.
 *
 * Scoping is structural, not advisory: every op derives the project from `ctx.env.projectId`, so
 * an agent cannot read or write another project's journal by passing a different id. A run with
 * no projectId (the Space Assistant's own space-wide slot) has no journal of its own and is told
 * so plainly rather than silently writing to a space-level file nobody reads.
 */

import type { PrebuiltScript, PrebuiltOpContext } from "./index.js";
import {
  parseJournal,
  renderJournal,
  emptyJournal,
  appendActivity,
  compactJournal,
  journalKey,
  DEFAULT_JOURNAL_LIMITS,
  type ProjectJournal,
  type JournalSummarizer,
} from "../project-journal.js";

function bucket(ctx: PrebuiltOpContext): R2Bucket {
  return ctx.env.workspaceBucket ?? ctx.env.scriptsBucket;
}

/** Every op funnels through this so the "which project?" question has exactly one answer. */
function requireProject(ctx: PrebuiltOpContext): { spaceId: string; projectId: string } | { error: string } {
  const projectId = ctx.env.projectId;
  if (!projectId) {
    return {
      error:
        "no project journal here — this run is not bound to a project (the Space Assistant works space-wide). Open or name a project first.",
    };
  }
  return { spaceId: ctx.env.spaceId, projectId };
}

async function loadJournal(ctx: PrebuiltOpContext, spaceId: string, projectId: string): Promise<ProjectJournal> {
  const obj = await bucket(ctx).get(journalKey(spaceId, projectId));
  if (!obj) return emptyJournal();
  return parseJournal(await obj.text());
}

async function saveJournal(ctx: PrebuiltOpContext, spaceId: string, projectId: string, j: ProjectJournal): Promise<void> {
  await bucket(ctx).put(journalKey(spaceId, projectId), renderJournal(j));
}

/** An LLM-backed summariser when one is wired, else undefined so compaction uses its
 *  deterministic rollup. Never throws — compaction treats a failure as "no summary". */
function summarizerFor(ctx: PrebuiltOpContext): JournalSummarizer | undefined {
  const caller = ctx.env.llmCaller;
  if (!caller?.complete) return undefined;
  return async (entries, existingArchive) => {
    const lines = entries.map((e) => `- ${e.at} [${e.actor}] ${e.summary}`).join("\n");
    const prompt = [
      "You maintain a running summary of a project's history.",
      "Rewrite the ARCHIVE so it absorbs the NEW ENTRIES below.",
      "Keep it dense and factual: what was accomplished, what was decided, what changed.",
      "Preserve concrete names (files, customers, amounts) — they are why anyone reads this.",
      "Drop chatter and repetition. Do not invent anything. Under 200 words.",
      "",
      `EXISTING ARCHIVE:\n${existingArchive || "(empty)"}`,
      "",
      `NEW ENTRIES:\n${lines}`,
    ].join("\n");
    const out = await caller.complete!({
      // Compaction is a background maintenance task, not user-facing reasoning — the cheapest
      // capable model is the right default here.
      model: "@cf/ibm-granite/granite-4.0-h-micro",
      prompt,
      maxTokens: 400,
    });
    return out.text?.trim() || null;
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

export const projectJournal: PrebuiltScript = {
  name: "project-journal",
  description:
    "The project's shared journal: its goal, standing instructions, current status, todos and a bounded log of what every agent in the project has done. Read it to find out what is already done before starting work; log to it after doing something.",
  domain: "knowledge",
  requires_tier: 1,
  operations: {
    /** Read the journal. This is the op an assistant calls INSTEAD of walking every thread. */
    async "project_journal.read"(args, ctx) {
      const scope = requireProject(ctx);
      if ("error" in scope) return { ok: false, reason: scope.error };
      const j = await loadJournal(ctx, scope.spaceId, scope.projectId);
      const section = typeof args["section"] === "string" ? (args["section"] as string).toLowerCase() : null;
      if (section) {
        const map: Record<string, unknown> = {
          goal: j.goal,
          instructions: j.instructions,
          status: j.status,
          todos: j.todos,
          activity: j.activity,
          archive: j.archive,
        };
        if (!(section in map)) {
          return { ok: false, reason: `unknown section '${section}' (goal, instructions, status, todos, activity, archive)` };
        }
        return { ok: true, section, value: map[section] };
      }
      return {
        ok: true,
        name: j.name,
        goal: j.goal,
        instructions: j.instructions,
        status: j.status,
        todos: j.todos,
        // Newest last; a reader wanting "what just happened" reads the tail.
        activity: j.activity,
        archive: j.archive,
        markdown: renderJournal(j),
      };
    },

    /** Record something that was done. The op every agent calls after a real action. */
    async "project_journal.log"(args, ctx) {
      const scope = requireProject(ctx);
      if ("error" in scope) return { ok: false, reason: scope.error };
      const summary = String(args["summary"] ?? "").trim();
      if (!summary) throw new Error("project_journal.log requires 'summary' (one line: what you did)");
      const actor = String(args["actor"] ?? ctx.env.agentId ?? "agent");
      // Only ever the caller's explicit thread_id: ScriptEngineEnv carries no thread identity of
      // its own, and inventing one would put a wrong "jump to this conversation" link in the log.
      const threadId = typeof args["thread_id"] === "string" ? (args["thread_id"] as string) : undefined;

      const j = await loadJournal(ctx, scope.spaceId, scope.projectId);
      const result = await appendActivity(
        j,
        { at: nowIso(), actor, summary, ...(threadId ? { threadId } : {}) },
        summarizerFor(ctx),
        DEFAULT_JOURNAL_LIMITS
      );
      await saveJournal(ctx, scope.spaceId, scope.projectId, result.journal);
      return {
        ok: true,
        logged: summary,
        compacted: result.compacted,
        activity_entries: result.journal.activity.length,
      };
    },

    /** Set the goal / standing instructions / status. Separate from `log` because these are
     *  rewritten in place, not appended — a status that accumulated would be a second activity
     *  log with none of its bounds. */
    async "project_journal.set"(args, ctx) {
      const scope = requireProject(ctx);
      if ("error" in scope) return { ok: false, reason: scope.error };
      const j = await loadJournal(ctx, scope.spaceId, scope.projectId);
      let changed = false;
      for (const field of ["goal", "instructions", "status", "name"] as const) {
        const v = args[field];
        if (typeof v === "string") {
          j[field] = v.trim();
          changed = true;
        }
      }
      if (!changed) throw new Error("project_journal.set requires at least one of: goal, instructions, status, name");
      await saveJournal(ctx, scope.spaceId, scope.projectId, j);
      return { ok: true, goal: j.goal, instructions: j.instructions, status: j.status, name: j.name };
    },

    /** Add a todo. */
    async "project_journal.add_todo"(args, ctx) {
      const scope = requireProject(ctx);
      if ("error" in scope) return { ok: false, reason: scope.error };
      const text = String(args["text"] ?? "").trim();
      if (!text) throw new Error("project_journal.add_todo requires 'text'");
      const j = await loadJournal(ctx, scope.spaceId, scope.projectId);
      // Adding the same todo twice is a normal consequence of two threads working in parallel —
      // dedupe rather than letting the list rot into duplicates.
      const existing = j.todos.find((t) => t.text.toLowerCase() === text.toLowerCase());
      if (existing) return { ok: true, todo: existing, already_present: true, todos: j.todos };
      j.todos.push({ text, done: false, at: nowIso() });
      await saveJournal(ctx, scope.spaceId, scope.projectId, j);
      return { ok: true, todos: j.todos };
    },

    /** Mark a todo done (or undone). Matched on exact text, case-insensitive. */
    async "project_journal.complete_todo"(args, ctx) {
      const scope = requireProject(ctx);
      if ("error" in scope) return { ok: false, reason: scope.error };
      const text = String(args["text"] ?? "").trim();
      if (!text) throw new Error("project_journal.complete_todo requires 'text'");
      const done = args["done"] === undefined ? true : Boolean(args["done"]);
      const j = await loadJournal(ctx, scope.spaceId, scope.projectId);
      const todo = j.todos.find((t) => t.text.toLowerCase() === text.toLowerCase());
      if (!todo) return { ok: false, reason: `no todo matching '${text}'`, todos: j.todos };
      todo.done = done;
      todo.at = nowIso();
      await saveJournal(ctx, scope.spaceId, scope.projectId, j);
      return { ok: true, todos: j.todos };
    },

    /** Force a compaction pass. Normally unnecessary — `log` compacts automatically — but
     *  exposed so a scheduled job or an assistant tidying up can trigger it deliberately. */
    async "project_journal.compact"(_args, ctx) {
      const scope = requireProject(ctx);
      if ("error" in scope) return { ok: false, reason: scope.error };
      const j = await loadJournal(ctx, scope.spaceId, scope.projectId);
      const result = await compactJournal(j, summarizerFor(ctx), DEFAULT_JOURNAL_LIMITS);
      if (result.compacted > 0) await saveJournal(ctx, scope.spaceId, scope.projectId, result.journal);
      return {
        ok: true,
        compacted: result.compacted,
        used_summarizer: result.usedSummarizer,
        activity_entries: result.journal.activity.length,
      };
    },
  },
  paramHints: {
    "project_journal.read": "no required fields — the project comes from the run itself, never an argument.",
    "project_journal.log": "summary (string, REQUIRED — ONE factual line about what you actually DID and what resulted, e.g. \"created the Lead Tracking project and briefed the dev agent\"; the field is `summary`, not `content`/`text`).",
    "project_journal.set": "at least one of goal / instructions / status / name (all strings).",
    "project_journal.add_todo": "text (string, REQUIRED).",
    "project_journal.complete_todo": "text (string, REQUIRED — matching an existing todo).",
    "project_journal.compact": "no arguments.",
  },
};
