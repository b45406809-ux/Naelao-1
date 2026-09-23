/**
 * The complete agent tool surface (spec §3) — exactly six operations. Everything the agent
 * can do flows through these; there are no other hardcoded tools.
 *
 *   script.create(name, code, metadata)
 *   script.read(name)
 *   script.update(name, patch, reason)
 *   script.delete(name)
 *   script.find(query, fingerprint?)
 *   script.run(name, params)
 *
 * script.run resolves `name` in this order:
 *   1. a prebuilt operation (bundled platform code, e.g. read_file, notify.email)
 *   2. a stored script in the skill library (executed via the execution ladder)
 */

import type {
  ScriptEngineEnv,
  ScriptMetadata,
  StoredScript,
  ScriptRunResult,
  FindCandidate,
  ObserveSnapshot,
  ScriptDomain,
  ExecutionTier,
} from "./types.js";
import { SkillLibrary } from "./skill-library.js";
import { scriptFind, indexScriptEmbedding, removeScriptEmbedding } from "./script-find.js";
import { runStoredScript } from "./execution-ladder.js";
import { buildOperationMap, type PrebuiltOp, type PrebuiltScript } from "./prebuilt/index.js";
import { assertNoReservedViolation } from "./reserved-capabilities.js";
import { isReadSafeOperation } from "./assistant-access.js";
import { enforceWriteGuard } from "@naelao/agent-sdk";

/** Plain edit distance — used only to rank "did you mean" suggestions by how close a guess
 *  actually is, never for anything security-relevant. Op names are short (well under 40 chars),
 *  so the O(n*m) table is trivial here. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = prev[j]!;
      prev[j] = a[i - 1] === b[j - 1]
        ? diagonal
        : 1 + Math.min(diagonal, prev[j]!, prev[j - 1]!);
      diagonal = temp;
    }
  }
  return prev[b.length]!;
}

/** Shape of one entry in the reasoner's `available_operations` — shared by both full and
 *  reduced (progressive-disclosure) payloads so the two can never drift apart in shape. */
export interface OperationGroup {
  script: string;
  description: string;
  operations: string[];
  /** opName → one-line parameter hint, only for ops this agent actually has enabled AND whose
   *  owning script declares one — see PrebuiltScript.paramHints's own doc for why this exists. */
  paramHints?: Record<string, string>;
}

/**
 * Progressive tool disclosure's always-visible core set (see disclosureGroups()'s own doc).
 * Deliberately small — the handful of cross-cutting operations useful in nearly every run.
 * Every name here is verified against the OWNING SCRIPT's real `operations` map key, not
 * assumed — this file's own history has a real, previously-shipped bug where an allowlist used
 * a dot-prefixed guess ("web-search.search") instead of the actual bare key ("search"), which
 * silently never matched anything a model could call. Get this list wrong and these operations
 * simply vanish from the reduced payload with no error to signal it.
 */
const CORE_OPERATIONS = new Set<string>([
  "search",               // web-search.ts (bare key)
  "knowledge.search",     // knowledge-base.ts
  "memory.recall",        // memory.ts
  "project_journal.read", // project-journal.ts
  "notify.email",         // notifications.ts
  "conversation.search",  // conversation.ts
  // Claude-Code-shaped REPL primitives (r2-workspace.ts / code-exec.ts) — kept visible even under
  // reduced disclosure since these are the most-used verbs in any multi-step run, mirroring how a
  // coding agent's own default tool list always shows its file/search/exec primitives. This only
  // controls what the REDUCED payload shows, never permission — the HITL gate/approval allowlist
  // is a separate mechanism (assistant_policy.auto_approved_actions), untouched by this set.
  "Read",
  "Edit",
  "Write",
  "Grep",
  "Glob",
  "Bash",
]);

/** Consecutive "unknown operation" misses in reduced-disclosure mode before this run
 *  automatically falls back to showing every available operation (see disclosureGroups' doc). */
const MISS_FALLBACK_THRESHOLD = 2;

/**
 * Old operation name → the name it was renamed to.
 *
 * Renaming an operation is not just an edit to this repo: learned skills are stored CODE in R2 that
 * a deploy cannot rewrite, so any skill already written against the old spelling would start failing
 * on businesses that were working fine before. Entries here keep those calls resolving. Deliberately
 * NOT advertised in the operation listing — the old name works, it just isn't offered.
 */
const RENAMED_OPERATIONS: Record<string, string> = {
  // Every thread-scoped operation is namespaced `thread.*`; consulting an agent privately is one of
  // them, and being the lone `agent.*` member of that script made it read like a different subsystem.
  "agent.consult": "thread.consult",
  // Lowercase spellings of the REPL primitives — a model reaching for the more familiar casing
  // (matching how it would type a shell verb) still resolves to the real, PascalCase op name.
  "read": "Read",
  "edit": "Edit",
  "write": "Write",
  "grep": "Grep",
  "glob": "Glob",
  "bash": "Bash",
  "execute_bash": "Bash",
  "patch_file": "Edit",
};

// ── Tool-result pagination (step 9) ─────────────────────────────────────────────────────────
// Some ops (thread.list, agent.list, knowledge.search, analytics, …) can return far more data
// than a run's context can hold. Rather than make every op re-implement paging, run() applies a
// generic, opt-out size-guard: when a result is oversized OR the caller explicitly passed a paging
// arg, page the result's primary list and attach a `_pagination` note telling the model exactly how
// to fetch the next page (call the SAME op with the same args + a bumped offset). Never drops data
// silently — the note always carries the true total and the next-offset instruction.
const MAX_TOOL_RESULT_BYTES = 16_000; // ~4k tokens — a safety ceiling, not a hard per-op contract.
const DEFAULT_TOOL_PAGE_SIZE = 50;

/** Read a numeric paging arg, accepting both `limit`/`offset` and `_limit`/`_offset` spellings. */
function pageArg(params: Record<string, unknown>, ...names: string[]): number | undefined {
  for (const n of names) {
    const v = params[n];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  }
  return undefined;
}

/** Locate the "primary" array in an op's output: the output itself if it's an array, else the
 *  longest array-valued field of a plain object. Returns null when there's nothing list-shaped. */
function findPrimaryArray(
  output: unknown
): { arr: unknown[]; rebuild: (page: unknown[], note: unknown) => unknown } | null {
  if (Array.isArray(output)) {
    return { arr: output, rebuild: (page, note) => ({ items: page, _pagination: note }) };
  }
  if (output && typeof output === "object") {
    const obj = output as Record<string, unknown>;
    let bestKey: string | null = null;
    let bestLen = -1;
    for (const [k, v] of Object.entries(obj)) {
      if (Array.isArray(v) && v.length > bestLen) {
        bestKey = k;
        bestLen = v.length;
      }
    }
    if (bestKey !== null) {
      const key = bestKey;
      return { arr: obj[key] as unknown[], rebuild: (page, note) => ({ ...obj, [key]: page, _pagination: note }) };
    }
  }
  return null;
}

/**
 * Apply the generic result limit. Untouched (byte-identical) when the result is small AND the
 * caller passed no paging arg — so ordinary small results keep their exact shape. Otherwise pages
 * the primary list, or (no list to page) truncates a genuinely oversized blob with an instruction.
 * Exported for direct unit testing — it must behave the same in isolation as inside run().
 */
export function applyToolResultLimit(output: unknown, params: Record<string, unknown>): unknown {
  const explicitLimit = pageArg(params, "limit", "_limit");
  const explicitOffset = pageArg(params, "offset", "_offset");
  let bytes: number;
  try {
    bytes = JSON.stringify(output ?? null).length;
  } catch {
    return output; // Non-serializable (shouldn't happen for a real op result) — leave it be.
  }
  const oversized = bytes > MAX_TOOL_RESULT_BYTES;
  const pagingRequested = explicitLimit !== undefined || explicitOffset !== undefined;
  if (!oversized && !pagingRequested) return output;

  const primary = findPrimaryArray(output);
  if (primary) {
    const total = primary.arr.length;
    let limit = explicitLimit ?? DEFAULT_TOOL_PAGE_SIZE;
    if (explicitLimit === undefined && oversized && total > 0) {
      // Shrink the page until it fits the byte budget: average per-item bytes → items that fit.
      const perItem = Math.max(1, Math.floor(bytes / total));
      limit = Math.max(1, Math.floor(MAX_TOOL_RESULT_BYTES / perItem));
    }
    const offset = Math.max(0, explicitOffset ?? 0);
    const page = primary.arr.slice(offset, offset + limit);
    const hasMore = offset + limit < total;
    const note: Record<string, unknown> = {
      total,
      offset,
      limit,
      returned: page.length,
      has_more: hasMore,
    };
    if (hasMore) {
      note["next_offset"] = offset + limit;
      note["instruction"] =
        `Showing ${page.length} of ${total} items. To see more, call this SAME operation again ` +
        `with the same arguments plus offset=${offset + limit} (add limit=<n> to change the page size).`;
    }
    return primary.rebuild(page, note);
  }

  // No list to page, but genuinely oversized — a large scalar/blob. Truncate the string view.
  if (oversized) {
    let s: string;
    try {
      s = typeof output === "string" ? output : JSON.stringify(output);
    } catch {
      s = String(output);
    }
    return {
      _truncated: true,
      _total_bytes: bytes,
      preview: s.slice(0, MAX_TOOL_RESULT_BYTES),
      instruction:
        `This result is ${bytes} bytes and was truncated to ${MAX_TOOL_RESULT_BYTES}. ` +
        `Use a search/read operation with a query or offset to fetch only the part you need ` +
        `rather than the whole thing.`,
    };
  }
  return output;
}

export class ScriptToolSurface {
  private readonly library: SkillLibrary;
  private readonly ops: Map<string, { op: PrebuiltOp; prebuilt: PrebuiltScript }>;
  /** Progressive tool disclosure mode for THIS run — see disclosureGroups()'s own doc. Starts
   *  "reduced" only when the caller opted in (env.progressiveToolDisclosure); can only ever
   *  move toward "full" during a run (the automatic miss-streak fallback), never the reverse. */
  private disclosureMode: "full" | "reduced";
  /** Consecutive "unknown operation" errors since the last successfully-resolved call, tracked
   *  only while disclosureMode is "reduced" — see the miss-streak comment in run(). */
  private missStreak = 0;

  constructor(
    private readonly env: ScriptEngineEnv,
    /** Enabled prebuilt scripts from the agent's scripts.json `prebuilt` list. */
    enabledPrebuilt: string[]
  ) {
    this.library = new SkillLibrary(env.scriptsBucket, env.spaceId);
    this.ops = buildOperationMap(enabledPrebuilt);
    this.disclosureMode = env.progressiveToolDisclosure ? "reduced" : "full";
    // tools.search/tools.describe are meta-operations ABOUT whatever is already enabled — always
    // registered (regardless of disclosureMode) so they're callable even in full-disclosure mode,
    // and so a test/caller doesn't need to special-case their existence. They cost nothing and
    // touch no external system; requires_tier 1 (the cheapest) reflects that honestly.
    const toolsMeta: PrebuiltScript = {
      name: "tools",
      description:
        "Search for an operation by what it does, or look up its exact parameters by name — " +
        "for anything not already shown in available_operations.",
      domain: "api",
      requires_tier: 1,
      operations: {},
      paramHints: {
        "tools.search": "query is required — what you're trying to do, in plain words (e.g. 'send an email', 'list projects'). Always returns at least a few results, never empty.",
        "tools.describe": "name is required — the exact operation name (e.g. 'thread.send_message'), usually one tools.search already gave you.",
      },
    };
    this.ops.set("tools.search", { prebuilt: toolsMeta, op: async (args) => this.searchOperations(String(args["query"] ?? "")) });
    this.ops.set("tools.describe", { prebuilt: toolsMeta, op: async (args) => this.describeOperation(String(args["name"] ?? "")) });
  }

  /**
   * Rank every enabled operation (INCLUDING ones not in CORE_OPERATIONS) against `query` by
   * simple token overlap against its name, owning script, description, and param hint. Never
   * returns empty: a zero-hit search falls back to the core set, and if that's somehow empty
   * too, the first 8 operations overall — a search must always give the model somewhere to go
   * next rather than a dead end.
   */
  private searchOperations(query: string): { query: string; results: Array<{ name: string; script: string; description: string; param_hint?: string }> } {
    const tokenize = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean);
    const wanted = tokenize(query);
    const scored: Array<{ name: string; script: string; description: string; paramHint?: string; hits: number }> = [];
    for (const [opName, { prebuilt }] of this.ops) {
      const hint = prebuilt.paramHints?.[opName];
      const haystack = new Set(tokenize(`${opName} ${prebuilt.name} ${prebuilt.description} ${hint ?? ""}`));
      const hits = wanted.length === 0 ? 0 : wanted.filter((w) => haystack.has(w)).length;
      scored.push({ name: opName, script: prebuilt.name, description: prebuilt.description, ...(hint ? { paramHint: hint } : {}), hits });
    }
    scored.sort((a, b) => b.hits - a.hits || a.name.localeCompare(b.name));
    let top = scored.filter((s) => s.hits > 0).slice(0, 8);
    if (top.length === 0) top = scored.filter((s) => CORE_OPERATIONS.has(s.name)).slice(0, 8);
    if (top.length === 0) top = scored.slice(0, 8);
    return {
      query,
      results: top.map(({ name, script, description, paramHint }) => ({
        name,
        script,
        description,
        ...(paramHint ? { param_hint: paramHint } : {}),
      })),
    };
  }

  /** Full detail for one named operation — its owning script, tier, and exact parameter hint
   *  when one is declared. An unknown name reuses the same "did you mean" suggestion run() gives
   *  a bad script.run call, so tools.describe and script.run never disagree about what exists. */
  private describeOperation(name: string): unknown {
    const entry = this.ops.get(name);
    if (!entry) return { ok: false, error: `Unknown operation: ${name}.${this.suggestOperations(name)}` };
    return {
      name,
      script: entry.prebuilt.name,
      script_description: entry.prebuilt.description,
      requires_tier: entry.prebuilt.requires_tier,
      ...(entry.prebuilt.paramHints?.[name] ? { param_hint: entry.prebuilt.paramHints[name] } : {}),
    };
  }

  get skillLibrary(): SkillLibrary {
    return this.library;
  }

  /** Names of all available prebuilt operations (for prompt construction / discovery). */
  availableOperations(): string[] {
    return [...this.ops.keys()];
  }

  /**
   * Live-reported bug: `available_operations` reached the reasoner as a bare flat list of op
   * NAMES with no description or grouping (e.g. "thread.create", "thread.send_message" sitting
   * unexplained among 60+ other names). A model asked to "communicate with an agent directly in
   * a thread" reasonably concluded no such capability existed — it never had enough context to
   * recognize those two names as the answer, and had no parameter schema to call them correctly
   * even if it guessed right. Grouped by owning prebuilt SCRIPT with that script's own
   * (already-written) description gives the model the same "what is this for" context
   * `candidate_scripts` already carries for the skill library, without writing a new description
   * per individual operation — one line of real, already-maintained prose per group is enough to
   * make "thread.send_message" legible as "the thing that lets me chat inside an existing
   * thread" instead of an opaque string.
   */
  availableOperationsGrouped(): OperationGroup[] {
    const byScript = new Map<
      string,
      { description: string; operations: string[]; paramHints: Record<string, string> }
    >();
    for (const [opName, { prebuilt }] of this.ops) {
      const existing = byScript.get(prebuilt.name);
      const hint = prebuilt.paramHints?.[opName];
      if (existing) {
        existing.operations.push(opName);
        if (hint) existing.paramHints[opName] = hint;
      } else {
        byScript.set(prebuilt.name, {
          description: prebuilt.description,
          operations: [opName],
          paramHints: hint ? { [opName]: hint } : {},
        });
      }
    }
    return [...byScript.entries()].map(([script, v]) => ({
      script,
      description: v.description,
      operations: v.operations,
      ...(Object.keys(v.paramHints).length > 0 ? { paramHints: v.paramHints } : {}),
    }));
  }

  /**
   * What actually reaches the reasoner payload as `available_operations` — see
   * ScriptEngineEnv.progressiveToolDisclosure's own doc for the design rationale.
   *
   * "full" mode (default): byte-identical to availableOperationsGrouped() — every enabled
   * operation, every turn, unchanged from before this feature existed.
   *
   * "reduced" mode (opt-in): only CORE_OPERATIONS, plus a synthetic "tools" group describing
   * tools.search/tools.describe for finding everything else. Execution is NOT restricted either
   * way — script.run still accepts any enabled operation whether or not it was shown here, so
   * this can only ever shrink what the model reads, never block a call it correctly guesses or
   * finds via tools.search.
   *
   * Automatic fallback: once run() records MISS_FALLBACK_THRESHOLD consecutive "unknown
   * operation" errors while in reduced mode, disclosureMode flips to "full" — since loop.ts
   * calls this fresh every reasoning turn, the very next call returns the full dump with no
   * further plumbing needed. A model that can't find what it needs through search is never
   * permanently stuck; it falls back to the old, proven-reliable behavior for the rest of the run.
   */
  disclosureGroups(): OperationGroup[] {
    const full = this.availableOperationsGrouped();
    if (this.disclosureMode === "full") return full;

    const core = full
      .map((g) => {
        const operations = g.operations.filter((op) => CORE_OPERATIONS.has(op));
        const paramHints = g.paramHints
          ? Object.fromEntries(Object.entries(g.paramHints).filter(([op]) => CORE_OPERATIONS.has(op)))
          : undefined;
        return { ...g, operations, ...(paramHints && Object.keys(paramHints).length ? { paramHints } : {}) };
      })
      .filter((g) => g.operations.length > 0);
    const shownCount = core.reduce((n, g) => n + g.operations.length, 0);
    const remaining = this.ops.size - shownCount - 2; // -2: tools.search/tools.describe themselves
    core.push({
      script: "tools",
      description:
        `${Math.max(remaining, 0)} more operation(s) exist across other scripts, not shown here to ` +
        `keep this list short. Call tools.search({query}) to find one by what it does (never empty ` +
        `— always returns the nearest matches), or tools.describe({name}) for its exact parameters ` +
        `once you know the name.`,
      operations: ["tools.search", "tools.describe"],
    });
    return core;
  }

  /**
   * Restricted-project execution ceiling (e.g. a customer-bot project capped at Tier 2) —
   * fail closed on any tier above it, for both authoring (script.create/update) and running
   * (script.run). Structural, not a prompt instruction: a compromised or over-eager reasoner
   * cannot talk its way past this.
   */
  private assertWithinCeiling(tier: ExecutionTier, context: string): void {
    if (this.env.maxTier !== undefined && tier > this.env.maxTier) {
      throw new Error(
        `Tier ${tier} exceeds this project's execution ceiling (${this.env.maxTier}) for ${context}. ` +
        `This project is configured as a restricted customer-facing bot — ask an admin to raise ` +
        `its execution ceiling if this capability is actually needed.`
      );
    }
  }

  /**
   * F-36 read-only clamp (see assistant-access.ts / ScriptEngineEnv.effectiveRole) — this run
   * acts on behalf of a user whose effective role in the bound project is `viewer`, so every
   * mutation is structurally refused. Same posture as assertWithinCeiling: a compromised or
   * over-eager reasoner cannot talk its way past this, and the error tells the agent to relay
   * the limitation honestly instead of retrying.
   */
  private assertWritable(context: string): void {
    if (this.env.effectiveRole === "viewer") {
      throw new Error(
        `${context} refused: this run acts on behalf of a user whose assistant access to this ` +
        `project is read-only (F-36 clamp). Only read operations are permitted — tell the user ` +
        `a project owner/editor must make this change (or adjust their assistant_mode).`
      );
    }
  }

  // ── script.create ──────────────────────────────────────────────────────────
  async create(input: {
    name: string;
    code?: string;
    metadata: Partial<ScriptMetadata> & Pick<ScriptMetadata, "description" | "domain" | "requires_tier">;
  }): Promise<ScriptMetadata> {
    this.assertWritable(`script.create('${input.name}')`);
    this.assertWithinCeiling(input.metadata.requires_tier, `script.create('${input.name}')`);

    // Income-wallet protection: a user/agent script may never collect money. Only the
    // prebuilt commerce op (Naelao's Lemon Squeezy store) may — that is how the platform
    // fee is guaranteed. Reject reserved-capability authoring at create time (fail-closed).
    assertNoReservedViolation({
      name: input.name,
      code: input.code,
      tags: input.metadata.tags,
      domain: input.metadata.domain,
    });

    // Embed at create time (spec §16) so script.find can retrieve it.
    if (this.env.embedder && !input.metadata.embedding_vector) {
      try {
        input.metadata.embedding_vector = await this.env.embedder.embed(
          `${input.metadata.description}\n${input.code ?? ""}`.slice(0, 4000)
        );
      } catch {
        /* embedding is best-effort; find degrades to tag/text scan */
      }
    }
    const meta = await this.library.create(input);
    await indexScriptEmbedding(this.env, meta);
    return meta;
  }

  // ── script.read ────────────────────────────────────────────────────────────
  read(name: string): Promise<StoredScript | null> {
    return this.library.read(name);
  }

  // ── script.update ──────────────────────────────────────────────────────────
  async update(
    name: string,
    patch: { code?: string; metadata?: Partial<ScriptMetadata> },
    reason: string
  ): Promise<ScriptMetadata> {
    this.assertWritable(`script.update('${name}')`);
    // Re-check on update so a benign script can't be edited into a money-in bypass — and so a
    // ceiling lowered AFTER creation (admin restricts a project) is enforced retroactively.
    if (patch.metadata?.requires_tier !== undefined) {
      this.assertWithinCeiling(patch.metadata.requires_tier, `script.update('${name}')`);
    } else {
      const existing = await this.library.read(name);
      if (existing) this.assertWithinCeiling(existing.metadata.requires_tier, `script.update('${name}')`);
    }
    assertNoReservedViolation({
      name,
      code: patch.code,
      tags: patch.metadata?.tags,
      domain: patch.metadata?.domain,
    });
    const meta = await this.library.update(name, patch, reason);
    await indexScriptEmbedding(this.env, meta);
    return meta;
  }

  // ── script.delete ──────────────────────────────────────────────────────────
  async delete(name: string): Promise<void> {
    this.assertWritable(`script.delete('${name}')`);
    await this.library.delete(name);
    await removeScriptEmbedding(this.env, name);
  }

  // ── script.find ────────────────────────────────────────────────────────────
  find(
    query: string,
    opts?: { snapshot?: ObserveSnapshot; domain?: ScriptDomain; limit?: number }
  ): Promise<FindCandidate[]> {
    return scriptFind(this.env, query, opts);
  }

  // ── script.run ─────────────────────────────────────────────────────────────
  /**
   * Name the real operations closest to one a model got wrong, so the next turn can correct
   * itself instead of re-guessing until the stall budget runs out. A bare "Unknown script or
   * operation: X" gives a model nothing to work with — and the observed real failure was a
   * model writing a prebuilt's descriptive phrase ("notifications prebuilt") rather than an op
   * name, which shares a token with the answer it wanted. Prebuilt ops only: they're already in
   * memory, so a miss costs nothing, whereas listing the R2 skill library would turn every
   * mistyped name into a bucket listing.
   *
   * Live-reported: a namespaced guess like "project-coordination:thread.create" tokenizes to
   * include the PREBUILT's own name ("project", "coordination"), which gives every single op in
   * that one script the same inflated hit count purely from matching the prefix the model added —
   * and the old alphabetical tie-break then arbitrarily excluded whichever op sorted last among
   * the tied group once the top-6 cap was hit. In the observed case that was
   * "thread.send_message", the one op that was actually the answer, cut from a list of 7 tied
   * siblings by nothing more than its name coming last alphabetically. Most of THIS specific
   * failure mode is now resolved upstream (reasoner.ts's stripNamespacePrefix runs a colon-guess
   * directly rather than ever reaching this error path) — this fixes the suggestion quality for
   * every OTHER wrong-name guess, which still reaches here.
   */
  private suggestOperations(name: string): string {
    const tokenize = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean);
    // Prefer the part after a colon, if there is one — that is the model's actual guess at the
    // OP name; the prefix before it (if any) is its guess at the owning script, already captured
    // separately below. Tokenizing the whole raw string here is what inflated every op in one
    // script to the same score in the first place.
    const hasNamespace = name.includes(":");
    const opPart = hasNamespace ? name.slice(name.lastIndexOf(":") + 1).trim() || name : name;
    const wanted = tokenize(opPart);
    if (wanted.length === 0) return "";
    // Match against the owning PREBUILT's name as well as the op name — but only from the
    // NAMESPACE part of a colon-guess (already captured separately, not re-added into `wanted`),
    // so a genuine descriptive-phrase miss ("notifications prebuilt", no colon — covered by
    // `wanted` already equalling the whole name) still benefits from this without a colon-guess
    // getting its script-name tokens counted twice.
    const namespaceTokens = hasNamespace ? tokenize(name.slice(0, name.lastIndexOf(":"))) : [];
    const scored: Array<{ op: string; hits: number; distance: number }> = [];
    for (const [op, entry] of this.ops) {
      const tokens = new Set([...tokenize(op), ...tokenize(entry.prebuilt.name)]);
      const hits = wanted.filter((w) => tokens.has(w)).length + namespaceTokens.filter((w) => tokens.has(w)).length;
      if (hits > 0) scored.push({ op, hits, distance: levenshtein(opPart.toLowerCase(), op.toLowerCase()) });
    }
    if (scored.length === 0) return "";
    // Ties broken on edit distance to the actual guess — closer string wins — instead of
    // alphabetical order, which had no relationship to relevance and is what silently dropped the
    // real answer from the live-reported case above.
    scored.sort((a, b) => b.hits - a.hits || a.distance - b.distance || a.op.localeCompare(b.op));
    const names = scored.slice(0, 8).map((s) => s.op);
    return ` Did you mean one of: ${names.join(", ")}? Use the exact operation name.`;
  }

  /**
   * Run a prebuilt operation or a stored script. Records success/failure health on stored
   * scripts so stability_score stays accurate.
   */
  /**
   * Resolve the two ways a model addresses an operation THROUGH the script that owns it.
   *
   * `available_operations` is grouped by script, so a model reading it sees both names and
   * reaches for the pair. Observed live in a single unattended run, twice, each costing two
   * steps: `workspace-admin.project.list` (owning script, dot, real op) and `business-diagnostics`
   * with `params.operation = "diagnostics.overview"` (owning script alone, operation moved into
   * the arguments). Both name a real script AND a real operation of it — the intent is not in
   * doubt, only the spelling — so failing them wastes a reasoning turn on a self-correction the
   * platform can just do.
   *
   * Deliberately narrow: a prefix is only stripped when it matches a script that actually exists
   * AND the remainder is an operation that script actually owns. That is what makes this
   * incapable of inventing an action — it can only ever map onto something already callable. It
   * must also run UPSTREAM of the HITL gate (see the loop's call site and stripNamespacePrefix's
   * own doc): resolving here rather than inside run() is what stops an alias of a gated action
   * slipping past a `gate_listed` allowlist unapproved.
   */
  resolveOperationAlias(
    name: string,
    params: Record<string, unknown>
  ): { name: string; params: Record<string, unknown> } {
    if (this.ops.has(name)) return { name, params };

    // An operation that has been RENAMED still answers to its old name. Learned skills live in R2
    // as stored code that this deploy cannot rewrite, and an agent profile's wording is only ever
    // advisory — so a rename that isn't aliased silently breaks every skill already written against
    // the old spelling, on businesses that were working fine yesterday.
    const renamed = RENAMED_OPERATIONS[name];
    if (renamed && this.ops.has(renamed)) return { name: renamed, params };

    // "<script>.<op>" / "<script>:<op>" — a real op cannot be found by splitting on the last dot
    // (op names are themselves dotted: project.list, notify.email), so match the script instead.
    for (const [opName, { prebuilt }] of this.ops) {
      for (const sep of [".", ":"]) {
        if (name === `${prebuilt.name}${sep}${opName}`) return { name: opName, params };
      }
    }

    // The bare script name, with the operation named in the arguments.
    for (const key of ["operation", "op", "action", "name"]) {
      const candidate = params[key];
      if (typeof candidate !== "string") continue;
      const entry = this.ops.get(candidate);
      if (!entry || entry.prebuilt.name !== name) continue;
      const { [key]: _moved, ...rest } = params;
      return { name: candidate, params: rest };
    }

    // The bare script name, with the operation used as a KEY whose value is the real argument
    // object: `workspace-admin` + `{"project.create": {name: "..."}}`. Seen live, and the most
    // expensive of the three spellings — the model had assembled correct arguments, lost them
    // when the call was refused, and then retried the right operation with nothing in it.
    const opKeys = Object.keys(params).filter(
      (k) => this.ops.get(k)?.prebuilt.name === name && params[k] !== null && typeof params[k] === "object"
    );
    if (opKeys.length === 1) {
      const key = opKeys[0]!;
      return { name: key, params: params[key] as Record<string, unknown> };
    }

    return { name, params };
  }

  async run(name: string, params: Record<string, unknown> = {}): Promise<ScriptRunResult> {
    const started = Date.now();
    const mutationIntent = name === "Bash"
      ? String(params["commands"] ?? params["command"] ?? params["cmd"] ?? "")
      : `${name} ${JSON.stringify(params)}`;
    try {
      await enforceWriteGuard(mutationIntent, this.env.mutationGrant, this.env.platformSecret ?? "", {
        subject: this.env.humanInvokerId ?? "system",
        resource: this.env.projectId ?? this.env.spaceId,
      });
    } catch {
      return { ok: false, error: "destructive_mutation_denied", tier: 1, duration_ms: Date.now() - started, tokens_used: 0 };
    }

    // F-36 read-only clamp: a viewer-clamped run may execute only explicitly read-safe
    // prebuilt ops — never a stored script (arbitrary agent-authored code is assumed to
    // mutate; fail closed). Checked before resolution so a refused name never even reads
    // the library (no outcome recorded against the script's stability score).
    if (this.env.effectiveRole === "viewer" && !isReadSafeOperation(name)) {
      return {
        ok: false,
        error:
          `script.run('${name}') refused: this run acts on behalf of a user whose assistant ` +
          `access to this project is read-only (F-36 clamp). Only read operations are ` +
          `permitted — tell the user a project owner/editor must perform this action ` +
          `(or adjust their assistant_mode).`,
        tier: 1,
        duration_ms: Date.now() - started,
        tokens_used: 0,
      };
    }

    // 1. Prebuilt operation?
    const prebuilt = this.ops.get(name);
    if (prebuilt) {
      // A resolved name — whatever happens next, this was not a "guessed the wrong name" miss.
      // See the miss-streak comment at the "Unknown script or operation" branch below.
      this.missStreak = 0;
      if (this.env.maxTier !== undefined && prebuilt.prebuilt.requires_tier > this.env.maxTier) {
        return {
          ok: false,
          error: `Tier ${prebuilt.prebuilt.requires_tier} exceeds this project's execution ceiling (${this.env.maxTier}) for script.run('${name}').`,
          tier: prebuilt.prebuilt.requires_tier,
          duration_ms: Date.now() - started,
          tokens_used: 0,
        };
      }
      try {
        const output = await prebuilt.op(params, {
          env: this.env,
          // skills calling skills (§7): a prebuilt op may invoke another op/script.
          run: async (n, p) => {
            const r = await this.run(n, p ?? {});
            if (!r.ok) throw new Error(r.error ?? `nested script ${n} failed`);
            return r.output;
          },
        });
        // §A1.25: a prebuilt op that made its OWN LLM call internally (e.g. web-search's
        // grounded_answer, which calls the native-web-search-enabled LLM directly rather than
        // going through the reasoner) reports its real usage in `output.usage` — surfaced here
        // so it's billed exactly like reasoner-driven tokens are (settleRunBilling reads
        // ScriptRunResult.tokens_used/input_tokens/output_tokens via withTokenUsage). An op that
        // never touches an LLM leaves this at 0, unchanged from before this feature existed.
        const usage = (output as { usage?: { tokens_used?: number; input_tokens?: number; output_tokens?: number } } | null)?.usage;
        // Step 9: generic result-size guard. Read usage from the ORIGINAL output above (the
        // paginated view may replace the primary list), then hand the model the size-limited view.
        const limited = applyToolResultLimit(output, params);
        return {
          ok: true,
          output: limited,
          tier: prebuilt.prebuilt.requires_tier,
          duration_ms: Date.now() - started,
          tokens_used: usage?.tokens_used ?? 0,
          ...(usage?.input_tokens !== undefined ? { input_tokens: usage.input_tokens } : {}),
          ...(usage?.output_tokens !== undefined ? { output_tokens: usage.output_tokens } : {}),
        };
      } catch (err) {
        // Growth-layer "click Install" onboarding (mcp-connector.ts's resolveServerId): a thrown
        // Error can carry needsConnector/connectorId/connectorName metadata (same precedent as
        // reserved-capabilities.ts's `reserved` flag) — surfaced as real result fields so the
        // reasoning loop's answer, and any future UI, sees a structured signal rather than only
        // free text buried in the error message.
        const meta = err as unknown as Record<string, unknown>;
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          tier: prebuilt.prebuilt.requires_tier,
          duration_ms: Date.now() - started,
          tokens_used: 0,
          ...(typeof meta["needsConnector"] === "boolean" ? { needs_connector: meta["needsConnector"] as boolean } : {}),
          ...(typeof meta["connectorId"] === "string" ? { connector_id: meta["connectorId"] as string } : {}),
          ...(typeof meta["connectorName"] === "string" ? { connector_name: meta["connectorName"] as string } : {}),
        };
      }
    }

    // 2. Stored script in the skill library?
    const stored = await this.library.read(name);
    if (!stored) {
      // Genuinely unresolvable name. In reduced-disclosure mode this is the one real risk of
      // showing less up front — a model that can't find something through tools.search might
      // otherwise just keep guessing. Track it, and once it happens MISS_FALLBACK_THRESHOLD
      // times in a row (reset by any successfully-resolved call above), permanently widen this
      // run to full disclosure — disclosureGroups() is called fresh every turn, so the very next
      // reasoning call sees everything, no further plumbing required.
      let fallbackNote = "";
      if (this.disclosureMode === "reduced") {
        this.missStreak++;
        if (this.missStreak >= MISS_FALLBACK_THRESHOLD) {
          this.disclosureMode = "full";
          fallbackNote = " Switched to showing every available operation for the rest of this run.";
        }
      }
      return {
        ok: false,
        error: `Unknown script or operation: ${name}.${this.suggestOperations(name)}${fallbackNote}`,
        tier: 1,
        duration_ms: Date.now() - started,
        tokens_used: 0,
      };
    }
    this.missStreak = 0;
    if (this.env.maxTier !== undefined && stored.metadata.requires_tier > this.env.maxTier) {
      return {
        ok: false,
        error: `Tier ${stored.metadata.requires_tier} exceeds this project's execution ceiling (${this.env.maxTier}) for script.run('${name}').`,
        tier: stored.metadata.requires_tier,
        duration_ms: Date.now() - started,
        tokens_used: 0,
      };
    }
    const result = await runStoredScript(this.env, stored, params);
    // The error, not just the boolean: it is what a later repair is aimed at, and what lets the
    // next run see "failed its last three times, and here is why" instead of a lower number.
    await this.library.recordOutcome(name, result.ok, result.error);
    return result;
  }
}
