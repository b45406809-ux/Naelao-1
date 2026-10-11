/**
 * The Skill Library (spec §4, §10) — a queryable, versioned, metadata-rich R2 store.
 * It is the primary asset an agent accumulates over time.
 *
 * R2 layout (spec §10.1), scoped per space:
 *   spaces/{spaceId}/scripts/{name}/
 *     SCRIPT.md          ← current metadata (JSON source of truth, latest version)
 *     code.ts            ← current code (latest version)
 *     versions/
 *       v1.ts  v1.meta.json
 *       v2.ts  v2.meta.json   ← why/what changed
 *       ...
 *
 * Scripts are NEVER overwritten in place — every update creates a new version, preserving
 * the full history. SCRIPT.md and code.ts always reflect the latest version.
 */

import type { ScriptMetadata, StoredScript, PatchRecord } from "./types.js";
import { recordRecentOutcome } from "./skill-health.js";

/** Derive stability_score in [0,1] from health counters (spec §4 "Health"). */
export function computeStabilityScore(m: Pick<ScriptMetadata, "success_count" | "failure_count" | "patch_history">): number {
  const runs = m.success_count + m.failure_count;
  const successRate = runs === 0 ? 0.5 : m.success_count / runs; // unproven scripts start neutral
  // Each patch erodes confidence; failed patches erode more.
  const patchPenalty = m.patch_history.reduce(
    (acc, p) => acc + (p.patch_type === "failed_patch" ? 0.08 : 0.03),
    0
  );
  return Math.max(0, Math.min(1, successRate - patchPenalty));
}

export class SkillLibrary {
  /**
   * A library is scoped either to a space (`spaces/{id}/scripts/…`, the agent's own learned
   * skills) or to a template (`templates/{id}/scripts/…`, the SHARED library all spaces on that
   * template inherit from and promote proven skills back into — federated learning, A1.9).
   */
  constructor(
    private readonly bucket: R2Bucket,
    private readonly scopeId: string,
    private readonly scope: "space" | "template" = "space"
  ) {}

  /** Build a template-scoped (shared) library. */
  static forTemplate(bucket: R2Bucket, templateId: string): SkillLibrary {
    return new SkillLibrary(bucket, templateId, "template");
  }

  private root(): string {
    return this.scope === "template"
      ? `templates/${this.scopeId}/scripts`
      : `spaces/${this.scopeId}/scripts`;
  }

  private dir(name: string): string {
    return `${this.root()}/${name}`;
  }

  /** True when a name is safe to use as a path segment under the script directory. */
  private isUsableName(name: string): boolean {
    return /^[a-zA-Z0-9._-]{1,128}$/.test(name);
  }

  /** Reject names that could escape the script directory or collide with the layout. */
  private assertName(name: string): void {
    if (!this.isUsableName(name)) {
      throw new Error(`Invalid script name: ${JSON.stringify(name)}`);
    }
  }

  // NOTE: the two LOOKUPS below deliberately do NOT throw on an unusable name — they report
  // "no such script", because their caller is a model choosing a name, not code constructing a
  // path. A model that writes `"notifications prebuilt"` instead of `notifications.send` should
  // see a recoverable step failure it can correct on the next turn; throwing here escapes
  // ScriptToolSurface.run()'s per-step error handling entirely and kills the whole run. That
  // was fatal on the unattended proactive path, where nobody is watching to retry (the job just
  // records consecutive_failures and goes quiet). Path safety is unaffected: an unusable name
  // never reaches the bucket. Every WRITE path still calls assertName() and still throws, since
  // there a bad name is a bug or an attack, not a typo.
  async exists(name: string): Promise<boolean> {
    if (!this.isUsableName(name)) return false;
    const head = await this.bucket.head(`${this.dir(name)}/SCRIPT.md`);
    return head !== null;
  }

  async read(name: string): Promise<StoredScript | null> {
    if (!this.isUsableName(name)) return null;
    const [metaObj, codeObj] = await Promise.all([
      this.bucket.get(`${this.dir(name)}/SCRIPT.md`),
      this.bucket.get(`${this.dir(name)}/code.ts`),
    ]);
    if (!metaObj) return null;
    const metadata = JSON.parse(await metaObj.text()) as ScriptMetadata;
    const result: StoredScript = { metadata };
    if (codeObj) result.code = await codeObj.text();
    return result;
  }

  async readMetadata(name: string): Promise<ScriptMetadata | null> {
    if (!this.isUsableName(name)) return null;
    const object = await this.bucket.get(`${this.dir(name)}/SCRIPT.md`);
    return object ? JSON.parse(await object.text()) as ScriptMetadata : null;
  }

  /**
   * Create a new script (version 1). Throws if it already exists — use update() to revise.
   */
  async create(input: {
    name: string;
    code?: string;
    metadata: Partial<ScriptMetadata> & Pick<ScriptMetadata, "description" | "domain" | "requires_tier">;
  }): Promise<ScriptMetadata> {
    this.assertName(input.name);
    if (await this.exists(input.name)) {
      throw new Error(`Script already exists: ${input.name}`);
    }
    const now = Date.now();
    const metadata: ScriptMetadata = {
      name: input.name,
      version: 1,
      domain: input.metadata.domain,
      description: input.metadata.description,
      ...(input.metadata.embedding_vector !== undefined
        ? { embedding_vector: input.metadata.embedding_vector }
        : {}),
      tags: input.metadata.tags ?? [],
      fingerprint_schema: input.metadata.fingerprint_schema ?? {},
      preconditions: input.metadata.preconditions ?? [],
      parameters: input.metadata.parameters ?? [],
      calls: input.metadata.calls ?? [],
      requires_tier: input.metadata.requires_tier,
      ...(input.metadata.runtime ? { runtime: input.metadata.runtime } : {}),
      ...(input.metadata.code_capabilities ? { code_capabilities: input.metadata.code_capabilities } : {}),
      ...(input.metadata.code_language ? { code_language: input.metadata.code_language } : {}),
      ...(input.metadata.required_credentials !== undefined
        ? { required_credentials: input.metadata.required_credentials }
        : {}),
      success_count: 0,
      failure_count: 0,
      patch_history: [
        {
          version: 1,
          created_at: now,
          patch_type: "initial",
          reason: "initial creation",
          success_count_at_patch: 0,
          failure_count_at_patch: 0,
        },
      ],
      stability_score: 0.5,
      origin: input.metadata.origin ?? "distilled",
      created_at: now,
      updated_at: now,
    };
    await this.persistVersion(input.name, metadata, input.code);
    return metadata;
  }

  /**
   * Apply a versioned update (new version N+1). Preserves the prior version under versions/.
   * `patch` may revise code and/or any metadata fields; `reason` is recorded in patch_history.
   */
  async update(
    name: string,
    patch: { code?: string; metadata?: Partial<ScriptMetadata> },
    reason: string,
    patchType: PatchRecord["patch_type"] = "minor_fix"
  ): Promise<ScriptMetadata> {
    this.assertName(name);
    const current = await this.read(name);
    if (!current) throw new Error(`Script not found: ${name}`);

    const prev = current.metadata;
    const now = Date.now();
    const nextVersion = prev.version + 1;

    const merged: ScriptMetadata = {
      ...prev,
      ...patch.metadata,
      name, // never let a patch rename
      version: nextVersion,
      updated_at: now,
      patch_history: [
        ...prev.patch_history,
        {
          version: nextVersion,
          created_at: now,
          patch_type: patchType,
          reason,
          fingerprint_before: (patch.metadata?.fingerprint_schema?.["fingerprint"] as string) ?? undefined,
          success_count_at_patch: prev.success_count,
          failure_count_at_patch: prev.failure_count,
        },
      ],
    };
    merged.stability_score = computeStabilityScore(merged);

    const newCode = patch.code ?? current.code;
    await this.persistVersion(name, merged, newCode);
    return merged;
  }

  /** Roll the current pointer back to a prior version (spec §10.3 automatic rollback). */
  async rollback(name: string, toVersion: number): Promise<ScriptMetadata> {
    this.assertName(name);
    const [metaObj, codeObj] = await Promise.all([
      this.bucket.get(`${this.dir(name)}/versions/v${toVersion}.meta.json`),
      this.bucket.get(`${this.dir(name)}/versions/v${toVersion}.ts`),
    ]);
    if (!metaObj) throw new Error(`Version ${toVersion} of ${name} not found`);
    const metadata = JSON.parse(await metaObj.text()) as ScriptMetadata;
    const code = codeObj ? await codeObj.text() : undefined;
    // Write the rolled-back content as the current pointer (history is preserved as-is).
    await Promise.all([
      this.bucket.put(`${this.dir(name)}/SCRIPT.md`, JSON.stringify(metadata, null, 2)),
      code !== undefined
        ? this.bucket.put(`${this.dir(name)}/code.ts`, code)
        : this.bucket.delete(`${this.dir(name)}/code.ts`),
    ]);
    return metadata;
  }

  async delete(name: string): Promise<void> {
    this.assertName(name);
    const prefix = `${this.dir(name)}/`;
    // R2 has no recursive delete — list and delete each object.
    let cursor: string | undefined;
    do {
      const listing = await this.bucket.list(cursor ? { prefix, cursor } : { prefix });
      if (listing.objects.length > 0) {
        await this.bucket.delete(listing.objects.map((o) => o.key));
      }
      cursor = listing.truncated ? listing.cursor : undefined;
    } while (cursor);
  }

  /** List all script names in this library (space- or template-scoped). */
  async list(): Promise<string[]> {
    const prefix = `${this.root()}/`;
    const names = new Set<string>();
    let cursor: string | undefined;
    do {
      const listing = await this.bucket.list(cursor ? { prefix, cursor } : { prefix });
      for (const o of listing.objects) {
        const rest = o.key.slice(prefix.length);
        const name = rest.split("/")[0];
        if (name) names.add(name);
      }
      cursor = listing.truncated ? listing.cursor : undefined;
    } while (cursor);
    return [...names];
  }

  /**
   * Record the outcome of a run, updating health counters + stability (no new version).
   *
   * `error` is what makes this a diagnosis rather than a tally: it lands in the bounded recent
   * window (skill-health.ts), which is what lets a later run see "this failed its last three
   * runs, and here is what it said" and repair the skill instead of re-running it.
   */
  async recordOutcome(name: string, success: boolean, error?: string): Promise<void> {
    const current = await this.readMetadata(name);
    if (!current) return;
    if (success) current.success_count += 1;
    else current.failure_count += 1;
    current.stability_score = computeStabilityScore(current);
    current.recent_outcomes = recordRecentOutcome(current.recent_outcomes, {
      ok: success,
      at: Date.now(),
      error,
    });
    current.updated_at = Date.now();
    await this.bucket.put(`${this.dir(name)}/SCRIPT.md`, JSON.stringify(current, null, 2));
  }

  /**
   * Import a script wholesale into this library (federated learning, A1.9): create it as v1 if
   * absent, else lay a new version on top. Used to promote a proven space skill up to the shared
   * template library, and to inherit shared template skills down into a new space. Provenance is
   * preserved via `origin` and a patch_history note.
   */
  async import(metadata: ScriptMetadata, code: string | undefined, reason: string): Promise<ScriptMetadata> {
    this.assertName(metadata.name);
    if (await this.exists(metadata.name)) {
      return this.update(metadata.name, { ...(code !== undefined ? { code } : {}), metadata }, reason, "re_derivation");
    }
    const now = Date.now();
    const meta: ScriptMetadata = {
      ...metadata,
      version: 1,
      created_at: now,
      updated_at: now,
      patch_history: [
        { version: 1, created_at: now, patch_type: "initial", reason, success_count_at_patch: 0, failure_count_at_patch: 0 },
      ],
    };
    await this.persistVersion(meta.name, meta, code);
    return meta;
  }

  /** Write current pointers + archive the new version. */
  private async persistVersion(name: string, metadata: ScriptMetadata, code?: string): Promise<void> {
    const dir = this.dir(name);
    const v = metadata.version;
    const writes: Promise<unknown>[] = [
      this.bucket.put(`${dir}/SCRIPT.md`, JSON.stringify(metadata, null, 2)),
      this.bucket.put(`${dir}/versions/v${v}.meta.json`, JSON.stringify(metadata, null, 2)),
    ];
    if (code !== undefined) {
      writes.push(this.bucket.put(`${dir}/code.ts`, code));
      writes.push(this.bucket.put(`${dir}/versions/v${v}.ts`, code));
    }
    await Promise.all(writes);
  }
}
