/**
 * Federated template learning (A1.9 / the user's template vision).
 *
 * A template is a *living* skill library: it ships seeded skills, and as agents on that template
 * distill new working skills, the proven ones flow back up to the shared template library so
 * EVERY space on the template inherits them. The flywheel: one agent learns, everyone benefits.
 *
 *   promote(space → template)  — a proven space skill is copied up to the shared library
 *   inherit(template → space)  — a new/existing space pulls the shared library down
 *
 * Promotion is GATED: a skill must be genuinely proven on the space that derived it (high
 * stability + a track record) before it pollutes the shared library. Pure functions over two
 * SkillLibrary instances — no platform deps, unit-testable.
 */

import type { SkillLibrary } from "./skill-library.js";
import type { ScriptMetadata } from "./types.js";

/** Promotion threshold — a skill is worth sharing once it's proven (mirrors shouldPromote). */
export const PROMOTE_MIN_STABILITY = 0.8;
export const PROMOTE_MIN_SUCCESSES = 5;

export function isPromotable(m: Pick<ScriptMetadata, "stability_score" | "success_count">): boolean {
  return m.stability_score >= PROMOTE_MIN_STABILITY && m.success_count >= PROMOTE_MIN_SUCCESSES;
}

export interface PromoteResult {
  promoted: boolean;
  name: string;
  reason?: string;
  stability_score?: number;
  success_count?: number;
}

/**
 * Promote one proven skill from a space's library up to the shared template library. The promoted
 * copy is marked origin "authored" (it's now a curated template asset) and its health counters are
 * reset — the shared copy earns its own track record across the fleet.
 */
export async function promoteSkill(
  spaceLib: SkillLibrary,
  templateLib: SkillLibrary,
  name: string
): Promise<PromoteResult> {
  const stored = await spaceLib.read(name);
  if (!stored) return { promoted: false, name, reason: "not_found" };
  const m = stored.metadata;
  if (!isPromotable(m)) {
    return {
      promoted: false,
      name,
      reason: `not yet proven (needs stability ≥ ${PROMOTE_MIN_STABILITY} and ≥ ${PROMOTE_MIN_SUCCESSES} successes)`,
      stability_score: m.stability_score,
      success_count: m.success_count,
    };
  }
  const shared: ScriptMetadata = {
    ...m,
    origin: "authored",
    success_count: 0,
    failure_count: 0,
    stability_score: 0.5,
  };
  await templateLib.import(shared, stored.code, `promoted from a space (proven: stability ${m.stability_score.toFixed(2)}, ${m.success_count} successes)`);
  return { promoted: true, name, stability_score: m.stability_score, success_count: m.success_count };
}

export interface InheritResult {
  inherited: string[];
  skipped: string[];
}

/**
 * Inherit the shared template library into a space. By default only adds skills the space does not
 * already have (so a space's own learned/patched version is never clobbered). Called at
 * provisioning so a new space starts with everything the fleet has figured out.
 */
export async function inheritTemplateSkills(
  templateLib: SkillLibrary,
  spaceLib: SkillLibrary,
  opts: { overwrite?: boolean } = {}
): Promise<InheritResult> {
  const names = await templateLib.list();
  const inherited: string[] = [];
  const skipped: string[] = [];
  for (const name of names) {
    if (!opts.overwrite && (await spaceLib.exists(name))) {
      skipped.push(name);
      continue;
    }
    const stored = await templateLib.read(name);
    if (!stored) continue;
    const seed: ScriptMetadata = { ...stored.metadata, origin: "authored", success_count: 0, failure_count: 0, stability_score: 0.5 };
    await spaceLib.import(seed, stored.code, "inherited from the shared template library");
    inherited.push(name);
  }
  return { inherited, skipped };
}
