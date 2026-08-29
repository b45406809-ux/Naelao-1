/**
 * The Project Journal — one durable, bounded, human-readable file per project that answers
 * "what is this project for, what has been done, and what is left" without reading any thread.
 *
 * Why this exists
 * ---------------
 * A project groups threads. Memory OS already shares Layers 3/4/6 across a project (facts,
 * fabric, wiki) while keeping Layer 5 (episodic/semantic) private per (thread, agent) — that
 * boundary is deliberate and stays: one thread's conversational meandering must never leak into
 * another thread's reasoning. But that leaves a real gap. Two agents in two threads of the same
 * project could each redo work the other already finished, because "I created invoice.csv" and
 * "the payout task is done" are neither a semantic fact nor a private episode — they are project
 * STATE.
 *
 * This file is that state. It is the project's equivalent of Claude Code's CLAUDE.md or an
 * agent.md, except it holds project updates, goals and todos rather than agent instructions.
 *
 * Design rules that make it work at scale
 * ---------------------------------------
 *  1. NEVER injected into every LLM call. It is read on demand via project_journal.read. A
 *     growing file that rides along on every request is exactly the context rot this is meant to
 *     avoid.
 *  2. Bounded, not append-forever. Activity is capped (entry count AND rendered bytes). Overflow
 *     is folded into a dense Archive summary rather than truncated, so old work is compressed,
 *     never silently lost — the compression approach Mastra's Observational Memory uses (a
 *     background observer condensing history into timestamped observations at 5-40x).
 *  3. Deterministic structure. Fixed section headers, parsed tolerantly. An agent (or a human)
 *     can edit it by hand without breaking the parser, and a malformed file degrades to an empty
 *     journal rather than throwing on a hot path.
 *  4. Summarisation is pluggable and OPTIONAL. With an LLM available compaction produces a real
 *     prose summary; without one it falls back to a deterministic rollup. It must never fail the
 *     write that triggered it — losing a completed action to a summariser outage is worse than a
 *     slightly coarser archive.
 *
 * This module is pure: no R2, no network, no clock of its own. That keeps compaction — the part
 * with genuinely tricky boundary conditions — testable without standing up a DO.
 */

/** One recorded thing that happened in the project. */
export interface JournalActivity {
  /** ISO-8601. Supplied by the caller so this module stays clock-free and testable. */
  at: string;
  /** Which agent did it. Free-form so a human entry ("owner") is representable too. */
  actor: string;
  /** What was done, one line. */
  summary: string;
  /** Optional thread this happened in — lets a reader jump to the full conversation. */
  threadId?: string | undefined;
}

export interface JournalTodo {
  text: string;
  done: boolean;
  /** ISO-8601 of when it was added. */
  at?: string | undefined;
}

export interface ProjectJournal {
  /** Project display name, for a human opening the raw file. */
  name: string;
  /** What this project is trying to achieve. */
  goal: string;
  /** Standing, project-specific instructions every agent in the project should honour. */
  instructions: string;
  /** Current state in a sentence or two. Rewritten as work progresses, not appended to. */
  status: string;
  todos: JournalTodo[];
  /** Newest LAST, matching how a human reads a log top-to-bottom. */
  activity: JournalActivity[];
  /** Dense summary of activity already compacted out of `activity`. */
  archive: string;
}

export interface JournalLimits {
  /** Activity entries retained verbatim before the oldest are folded into the archive. */
  maxActivityEntries: number;
  /** Hard ceiling on the rendered file. The whole point is that this file cannot grow forever. */
  maxBytes: number;
  /** How many of the oldest entries a single compaction folds away. */
  compactBatch: number;
}

export const DEFAULT_JOURNAL_LIMITS: JournalLimits = {
  maxActivityEntries: 60,
  // ~16KB keeps a full read comfortably inside a single tool observation even on a small-context
  // model, which matters because the assistant reads this INSTEAD of walking every thread.
  maxBytes: 16_000,
  compactBatch: 30,
};

export function emptyJournal(name = ""): ProjectJournal {
  return { name, goal: "", instructions: "", status: "", todos: [], activity: [], archive: "" };
}

const SECTIONS = ["Goal", "Instructions", "Status", "Todos", "Activity", "Archive"] as const;
type SectionName = (typeof SECTIONS)[number];

/** Split the file into its `## <Name>` sections. Unknown sections are ignored rather than
 *  treated as an error — a human adding a scratch section must not break agent reads. */
function splitSections(md: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Only `## ` headings delimit sections; `# ` is the title and `### ` may appear inside prose.
  const lines = md.split(/\r?\n/);
  let current: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (current) out[current] = buf.join("\n").trim();
    buf = [];
  };
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      flush();
      current = m[1] ?? null;
    } else if (current) {
      buf.push(line);
    }
  }
  flush();
  return out;
}

function parseTodos(block: string): JournalTodo[] {
  const todos: JournalTodo[] = [];
  for (const line of block.split(/\r?\n/)) {
    const m = /^\s*[-*]\s*\[( |x|X)\]\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    let text = (m[2] ?? "").trim();
    let at: string | undefined;
    // Trailing "(added <iso>)" / "(done <iso>)" annotation, written by render().
    const ann = /\s*\((?:added|done)\s+([^)]+)\)\s*$/.exec(text);
    if (ann) {
      at = (ann[1] ?? "").trim();
      text = text.slice(0, ann.index).trim();
    }
    if (!text) continue;
    todos.push({ text, done: (m[1] ?? " ").toLowerCase() === "x", ...(at ? { at } : {}) });
  }
  return todos;
}

/** Formats structured tasks into clean, human-readable markdown TODO lines. */
export function formatTasksToTodos(tasks: Array<{ title: string; status: string }>): JournalTodo[] {
  return tasks.map(t => ({
    text: t.title,
    done: t.status === "COMPLETED" || t.status === "completed",
    at: new Date().toISOString()
  }));
}

function parseActivity(block: string): JournalActivity[] {
  const out: JournalActivity[] = [];
  for (const line of block.split(/\r?\n/)) {
    // `- <iso> [actor] summary` with an optional ` (thread <id>)` suffix.
    const m = /^\s*[-*]\s*(\S+)\s+\[([^\]]*)\]\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    let summary = (m[3] ?? "").trim();
    let threadId: string | undefined;
    const t = /\s*\(thread\s+([^)]+)\)\s*$/.exec(summary);
    if (t) {
      threadId = (t[1] ?? "").trim();
      summary = summary.slice(0, t.index).trim();
    }
    if (!summary) continue;
    out.push({ at: m[1] ?? "", actor: (m[2] ?? "").trim(), summary, ...(threadId ? { threadId } : {}) });
  }
  return out;
}

/** Parse a journal file. Never throws: an unreadable file yields an empty journal, because this
 *  sits on the path of every agent action and must not be able to break one. */
export function parseJournal(md: string): ProjectJournal {
  const j = emptyJournal();
  if (typeof md !== "string" || md.trim() === "") return j;
  try {
    const titleMatch = /^#\s+(.+?)\s*$/m.exec(md);
    j.name = titleMatch ? (titleMatch[1] ?? "").trim() : "";
    const sec = splitSections(md);
    j.goal = (sec["Goal"] ?? "").trim();
    j.instructions = (sec["Instructions"] ?? "").trim();
    j.status = (sec["Status"] ?? "").trim();
    j.archive = (sec["Archive"] ?? "").trim();
    j.todos = parseTodos(sec["Todos"] ?? "");
    j.activity = parseActivity(sec["Activity"] ?? "");
  } catch {
    return emptyJournal();
  }
  return j;
}

function renderTodo(t: JournalTodo): string {
  const box = t.done ? "x" : " ";
  const ann = t.at ? ` (${t.done ? "done" : "added"} ${t.at})` : "";
  return `- [${box}] ${t.text}${ann}`;
}

function renderActivity(a: JournalActivity): string {
  const thread = a.threadId ? ` (thread ${a.threadId})` : "";
  return `- ${a.at} [${a.actor}] ${a.summary}${thread}`;
}

/** Render a journal back to markdown. Round-trips with parseJournal. */
export function renderJournal(j: ProjectJournal): string {
  const placeholder = (s: string, empty: string) => (s.trim() ? s.trim() : empty);
  const parts: string[] = [
    `# ${j.name || "Project"}`,
    "",
    "## Goal",
    placeholder(j.goal, "_Not set yet._"),
    "",
    "## Instructions",
    placeholder(j.instructions, "_None._"),
    "",
    "## Status",
    placeholder(j.status, "_Not started._"),
    "",
    "## Todos",
    j.todos.length ? j.todos.map(renderTodo).join("\n") : "_None._",
    "",
    "## Activity",
    j.activity.length ? j.activity.map(renderActivity).join("\n") : "_Nothing recorded yet._",
    "",
    "## Archive",
    placeholder(j.archive, "_Empty._"),
    "",
  ];
  return parts.join("\n");
}

export function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** True when the journal has outgrown its budget and should be compacted. */
export function needsCompaction(j: ProjectJournal, limits: JournalLimits = DEFAULT_JOURNAL_LIMITS): boolean {
  if (j.activity.length > limits.maxActivityEntries) return true;
  return byteLength(renderJournal(j)) > limits.maxBytes;
}

/** Condense a batch of activity entries without an LLM.
 *
 *  Deliberately coarse but never wrong: it groups by actor and by UTC day and reports counts and
 *  the date span, keeping the first and last thing each actor did. An LLM summary is better
 *  prose, but this must remain correct and dependency-free because it is also the fallback when
 *  the model call fails — and losing real completed work to an outage is not acceptable. */
export function deterministicSummary(entries: JournalActivity[]): string {
  if (entries.length === 0) return "";
  const byActor = new Map<string, JournalActivity[]>();
  for (const e of entries) {
    const list = byActor.get(e.actor) ?? [];
    list.push(e);
    byActor.set(e.actor, list);
  }
  const days = new Set(entries.map((e) => (e.at || "").slice(0, 10)).filter(Boolean));
  const sortedDays = [...days].sort();
  const span =
    sortedDays.length === 0
      ? "unknown period"
      : sortedDays.length === 1
        ? sortedDays[0]!
        : `${sortedDays[0]} to ${sortedDays[sortedDays.length - 1]}`;

  const lines = [`${entries.length} earlier action(s), ${span}:`];
  for (const [actor, list] of byActor) {
    const first = list[0]?.summary ?? "";
    const last = list[list.length - 1]?.summary ?? "";
    lines.push(
      list.length === 1
        ? `- ${actor}: ${first}`
        : `- ${actor} (${list.length} actions): started with "${first}"; most recently "${last}".`
    );
  }
  return lines.join("\n");
}

/** Summarises a batch of entries into prose. Returning null means "could not summarise" and the
 *  caller falls back to the deterministic rollup. */
export type JournalSummarizer = (entries: JournalActivity[], existingArchive: string) => Promise<string | null>;

export interface CompactionResult {
  journal: ProjectJournal;
  /** How many activity entries were folded into the archive. 0 means nothing needed doing. */
  compacted: number;
  /** Whether the archive prose came from the summariser or the deterministic fallback. */
  usedSummarizer: boolean;
}

/**
 * Fold the oldest activity into the archive until the journal is back inside its budget.
 *
 * Compaction is idempotent-safe: calling it on an already-small journal is a no-op, and it always
 * leaves at least one activity entry (a project whose entire recent history vanished reads as if
 * nothing is happening, which is worse than a slightly-over-budget file).
 */
export async function compactJournal(
  journal: ProjectJournal,
  summarize?: JournalSummarizer | undefined,
  limits: JournalLimits = DEFAULT_JOURNAL_LIMITS
): Promise<CompactionResult> {
  if (!needsCompaction(journal, limits)) return { journal, compacted: 0, usedSummarizer: false };

  const j: ProjectJournal = { ...journal, activity: [...journal.activity], todos: [...journal.todos] };
  let compacted = 0;
  let usedSummarizer = false;

  // Loop because one batch may not be enough to get back under the byte ceiling (a few very long
  // entries can blow the budget without exceeding the entry count).
  while (needsCompaction(j, limits) && j.activity.length > 1) {
    const take = Math.min(limits.compactBatch, j.activity.length - 1);
    if (take <= 0) break;
    const batch = j.activity.slice(0, take);
    j.activity = j.activity.slice(take);

    let prose: string | null = null;
    if (summarize) {
      try {
        prose = await summarize(batch, j.archive);
      } catch {
        prose = null; // A summariser failure must never lose the batch — fall through.
      }
    }
    if (prose && prose.trim()) {
      usedSummarizer = true;
      j.archive = prose.trim();
    } else {
      const rollup = deterministicSummary(batch);
      j.archive = j.archive ? `${j.archive}\n\n${rollup}` : rollup;
    }
    compacted += take;
  }

  // Last resort: the archive itself has grown past the ceiling. Keep the newest half — it is the
  // only part still describing anything actionable — and say plainly that older detail was
  // dropped, rather than silently presenting a truncated archive as complete.
  if (byteLength(renderJournal(j)) > limits.maxBytes && j.archive) {
    const paras = j.archive.split(/\n{2,}/);
    if (paras.length > 1) {
      const kept = paras.slice(Math.floor(paras.length / 2));
      j.archive = `_(older archive entries dropped to stay within size limits)_\n\n${kept.join("\n\n")}`;
    }
  }

  return { journal: j, compacted, usedSummarizer };
}

/** Append an activity entry, compacting if that pushed the journal over budget. */
export async function appendActivity(
  journal: ProjectJournal,
  entry: JournalActivity,
  summarize?: JournalSummarizer | undefined,
  limits: JournalLimits = DEFAULT_JOURNAL_LIMITS
): Promise<CompactionResult> {
  const j: ProjectJournal = { ...journal, activity: [...journal.activity, entry] };
  return compactJournal(j, summarize, limits);
}

/** R2 key for a project's journal. Deliberately a sibling of `workspace/`, not inside it: the
 *  workspace is the user's/agent's file area and a `project_journal.*` op should not be able to
 *  be spoofed by an ordinary file write, nor should a workspace listing be cluttered by it. */
export function journalKey(spaceId: string, projectId: string): string {
  return `spaces/${spaceId}/projects/${projectId}/PROJECT.md`;
}
