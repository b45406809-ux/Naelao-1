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

export class ScriptToolSurface {
  private readonly library: SkillLibrary;
  private readonly ops: Map<string, { op: PrebuiltOp; prebuilt: PrebuiltScript }>;

  constructor(
    private readonly env: ScriptEngineEnv,
    /** Enabled prebuilt scripts from the agent's scripts.json `prebuilt` list. */
    enabledPrebuilt: string[]
  ) {
    this.library = new SkillLibrary(env.scriptsBucket, env.spaceId);
    this.ops = buildOperationMap(enabledPrebuilt);
  }

  get skillLibrary(): SkillLibrary {
    return this.library;
  }

  /** Names of all available prebuilt operations (for prompt construction / discovery). */
  availableOperations(): string[] {
    return [...this.ops.keys()];
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
   */
  private suggestOperations(name: string): string {
    const tokenize = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean);
    const wanted = tokenize(name);
    if (wanted.length === 0) return "";
    // Match against the owning PREBUILT's name as well as the op name. Several prebuilts expose
    // ops under a different prefix than the prebuilt they belong to (`notifications` owns
    // `notify.email`, `notify.slack`, ...), and the prebuilt name is what a model sees listed in
    // its own profile — so the name it reaches for is often the one that shares no token with any
    // op. Matching op names alone would have returned nothing for the real observed failure.
    const scored: Array<{ op: string; hits: number }> = [];
    for (const [op, entry] of this.ops) {
      const tokens = new Set([...tokenize(op), ...tokenize(entry.prebuilt.name)]);
      const hits = wanted.filter((w) => tokens.has(w)).length;
      if (hits > 0) scored.push({ op, hits });
    }
    if (scored.length === 0) return "";
    scored.sort((a, b) => b.hits - a.hits || a.op.localeCompare(b.op));
    const names = scored.slice(0, 6).map((s) => s.op);
    return ` Did you mean one of: ${names.join(", ")}? Use the exact operation name.`;
  }

  /**
   * Run a prebuilt operation or a stored script. Records success/failure health on stored
   * scripts so stability_score stays accurate.
   */
  async run(name: string, params: Record<string, unknown> = {}): Promise<ScriptRunResult> {
    const started = Date.now();

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
        return {
          ok: true,
          output,
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
      return {
        ok: false,
        error: `Unknown script or operation: ${name}.${this.suggestOperations(name)}`,
        tier: 1,
        duration_ms: Date.now() - started,
        tokens_used: 0,
      };
    }
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
