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
  constructor(
    private readonly bucket: R2Bucket,
    private readonly spaceId: string
  ) {}

  private dir(name: string): string {
    return `spaces/${this.spaceId}/scripts/${name}`;
  }

  /** Reject names that could escape the script directory or collide with the layout. */
  private assertName(name: string): void {
    if (!/^[a-zA-Z0-9._-]{1,128}$/.test(name)) {
      throw new Error(`Invalid script name: ${JSON.stringify(name)}`);
    }
  }

  async exists(name: string): Promise<boolean> {
    this.assertName(name);
    const head = await this.bucket.head(`${this.dir(name)}/SCRIPT.md`);
    return head !== null;
  }

  async read(name: string): Promise<StoredScript | null> {
    this.assertName(name);
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
    const s = await this.read(name);
    return s?.metadata ?? null;
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

  /** List all script names in this space's library. */
  async list(): Promise<string[]> {
    const prefix = `spaces/${this.spaceId}/scripts/`;
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

  /** Record the outcome of a run, updating health counters + stability (no new version). */
  async recordOutcome(name: string, success: boolean): Promise<void> {
    const current = await this.readMetadata(name);
    if (!current) return;
    if (success) current.success_count += 1;
    else current.failure_count += 1;
    current.stability_score = computeStabilityScore(current);
    current.updated_at = Date.now();
    await this.bucket.put(`${this.dir(name)}/SCRIPT.md`, JSON.stringify(current, null, 2));
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
