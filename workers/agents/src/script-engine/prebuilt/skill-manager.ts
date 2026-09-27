/**
 * skill-manager — the agent's own view of, and control over, the skills it has learned.
 *
 * The engine already records outcomes, derives a health verdict (skill-health.ts), demotes a
 * failing skill in `script.find`, and refuses to auto-run one at L1. That is the automatic half
 * of the loop, and it is enough to stop a broken skill being picked. It is NOT enough to get the
 * skill fixed: nothing decides to repair a skill that isn't currently being reached for, nothing
 * removes one that will never work again, and nothing shares one that has genuinely proven out.
 *
 * Those are judgment calls, which on this platform means they belong to the agent rather than to
 * a hardcoded sweep. So this is a real tool surface over the library:
 *
 *   skill.health    — what has been going wrong, what's proven, what's worth sharing
 *   skill.inspect   — one skill in full: version, health, patch history, recent errors
 *   skill.rollback  — undo a patch that made things worse
 *   skill.retire    — delete a skill that is beyond repair (and stop it being found)
 *   skill.promote   — publish a proven skill to the shared template library
 *
 * Read ops are safe and are auto-approved in guided mode. The three that change the library are
 * gated like any other mutation — retiring a skill another project depends on is exactly the kind
 * of thing an owner should get to see first.
 *
 * Promotion deliberately does NOT happen here: it needs the space's template id, which is a D1
 * lookup this DO has no binding for. `skill.promote` calls the agents worker's already-existing
 * `/skills/promote` route, which owns that lookup and the promotion threshold — one gate, not two
 * that can drift.
 */

import type { PrebuiltScript, PrebuiltOpContext } from "./index.js";
import type { ScriptMetadata } from "../types.js";
import { SkillLibrary } from "../skill-library.js";
import { assessSkillHealth } from "../skill-health.js";
import { isPromotable } from "../federation.js";
import { removeScriptEmbedding } from "../script-find.js";
import { mintInternalToken } from "@naelao/http";
import { distillSkillFromTrace } from "../distill.js";
import { distillSkillFromVideo } from "../video-distill.js";
import { workspacePrefix } from "../types.js";

function library(ctx: PrebuiltOpContext): SkillLibrary {
  return new SkillLibrary(ctx.env.scriptsBucket, ctx.env.spaceId);
}

/** How many recent errors to surface per skill. Enough to see a pattern, not a log dump. */
const ERRORS_SHOWN = 3;

function summarize(metadata: ScriptMetadata) {
  const health = assessSkillHealth(metadata);
  return {
    name: metadata.name,
    version: metadata.version,
    domain: metadata.domain,
    description: metadata.description,
    state: health.state,
    consecutive_failures: health.consecutive_failures,
    successes: metadata.success_count,
    failures: metadata.failure_count,
    ...(health.last_error ? { last_error: health.last_error } : {}),
    note: health.recommendation,
    promotable: isPromotable(metadata),
  };
}

async function loadAll(ctx: PrebuiltOpContext): Promise<ScriptMetadata[]> {
  const lib = library(ctx);
  const names = await lib.list();
  const metas = await Promise.all(names.map((n) => lib.readMetadata(n)));
  return metas.filter((m): m is ScriptMetadata => m !== null);
}

async function health(_a: Record<string, unknown>, ctx: PrebuiltOpContext): Promise<unknown> {
  const all = await loadAll(ctx);
  if (all.length === 0) {
    return {
      skills: [],
      count: 0,
      assessment: "No learned skills yet — nothing has been distilled in this space.",
    };
  }

  const rows = all.map(summarize);
  const broken = rows.filter((r) => r.state === "broken");
  const degrading = rows.filter((r) => r.state === "degrading");
  const promotable = rows.filter((r) => r.promotable);

  // The point of a summary is to say what to do about it, not to restate the table.
  const parts: string[] = [];
  if (broken.length > 0) {
    parts.push(
      `${broken.length} skill(s) are broken and will not be run unattended: ${broken.map((r) => r.name).join(", ")}. Fix them with a patch aimed at their last_error, or retire them.`
    );
  }
  if (degrading.length > 0) {
    parts.push(`${degrading.length} skill(s) are failing more than they should: ${degrading.map((r) => r.name).join(", ")}.`);
  }
  if (promotable.length > 0) {
    parts.push(`${promotable.length} skill(s) have proven out and could be shared with every business on this template: ${promotable.map((r) => r.name).join(", ")}.`);
  }
  if (parts.length === 0) parts.push(`All ${rows.length} learned skill(s) are healthy.`);

  return {
    skills: rows,
    count: rows.length,
    broken: broken.length,
    degrading: degrading.length,
    promotable: promotable.length,
    assessment: parts.join(" "),
  };
}

async function inspect(a: Record<string, unknown>, ctx: PrebuiltOpContext): Promise<unknown> {
  const name = String(a["name"] ?? "").trim();
  if (!name) throw new Error("skill.inspect requires a skill name");
  const stored = await library(ctx).read(name);
  if (!stored) return { found: false, name, message: `No learned skill named ${name} in this space.` };

  const m = stored.metadata;
  const recent = m.recent_outcomes ?? [];
  return {
    found: true,
    ...summarize(m),
    requires_tier: m.requires_tier,
    parameters: m.parameters,
    // The errors themselves, so a patch can be aimed rather than guessed.
    recent_errors: recent
      .filter((o) => !o.ok && o.error)
      .slice(0, ERRORS_SHOWN)
      .map((o) => ({ at: o.at, error: o.error })),
    recent_runs: recent.map((o) => ({ ok: o.ok, at: o.at })),
    patch_history: m.patch_history.map((p) => ({
      version: p.version,
      at: p.created_at,
      type: p.patch_type,
      reason: p.reason,
    })),
  };
}

async function rollback(a: Record<string, unknown>, ctx: PrebuiltOpContext): Promise<unknown> {
  const name = String(a["name"] ?? "").trim();
  if (!name) throw new Error("skill.rollback requires a skill name");
  const lib = library(ctx);
  const current = await lib.readMetadata(name);
  if (!current) return { ok: false, name, message: `No learned skill named ${name} in this space.` };
  if (current.version <= 1) {
    return { ok: false, name, message: `${name} is still on its first version — there is nothing to roll back to.` };
  }
  const target = a["to_version"] !== undefined ? Number(a["to_version"]) : current.version - 1;
  if (!Number.isInteger(target) || target < 1 || target >= current.version) {
    return { ok: false, name, message: `to_version must be a whole number between 1 and ${current.version - 1}.` };
  }
  const restored = await lib.rollback(name, target);
  return {
    ok: true,
    name,
    from_version: current.version,
    to_version: restored.version,
    message: `Rolled ${name} back to v${target}. Its health record is unchanged — run it to find out whether the older version actually works.`,
  };
}

async function retire(a: Record<string, unknown>, ctx: PrebuiltOpContext): Promise<unknown> {
  const name = String(a["name"] ?? "").trim();
  if (!name) throw new Error("skill.retire requires a skill name");
  const lib = library(ctx);
  const meta = await lib.readMetadata(name);
  if (!meta) return { ok: false, name, message: `No learned skill named ${name} in this space.` };

  await lib.delete(name);
  // Leaving the embedding behind would keep the skill turning up in script.find as a candidate
  // whose metadata no longer resolves — findable, unusable, and confusing.
  await removeScriptEmbedding(ctx.env, name);
  return {
    ok: true,
    name,
    retired_at_version: meta.version,
    message: `Retired ${name} (was v${meta.version}, ${meta.success_count} successes / ${meta.failure_count} failures). It will no longer be found or run. Anything that depended on it will need a new approach.`,
  };
}

async function promote(a: Record<string, unknown>, ctx: PrebuiltOpContext): Promise<unknown> {
  const name = String(a["name"] ?? "").trim();
  if (!name) throw new Error("skill.promote requires a skill name");
  if (!ctx.env.agentsWorker) {
    return { ok: false, name, message: "Skill promotion is not available in this environment." };
  }
  const meta = await library(ctx).readMetadata(name);
  if (!meta) return { ok: false, name, message: `No learned skill named ${name} in this space.` };
  if (!isPromotable(meta)) {
    const h = assessSkillHealth(meta);
    return {
      ok: false,
      name,
      message: `${name} is not proven enough to share yet (stability ${meta.stability_score.toFixed(2)}, ${meta.success_count} successes). ${h.recommendation}`,
    };
  }

  const resp = await ctx.env.agentsWorker.fetch(
    new Request("http://agents-worker/skills/promote", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": ctx.env.tenantId,
        "x-naelao-internal-token": await mintInternalToken(ctx.env.platformSecret ?? "", ctx.env.tenantId),
      },
      body: JSON.stringify({ space_id: ctx.env.spaceId, name }),
    })
  );
  const body = await resp.json<Record<string, unknown>>().catch(() => null);
  if (!resp.ok) {
    return {
      ok: false,
      name,
      message: String(body?.["message"] ?? `Could not promote ${name} (${resp.status}).`),
    };
  }
  return {
    ok: true,
    name,
    template_id: body?.["template_id"],
    message: `Promoted ${name} to the shared library — every business on this template inherits it from now on.`,
  };
}

async function distillTrace(a: Record<string, unknown>, ctx: PrebuiltOpContext): Promise<unknown> {
  if (!Array.isArray(a["trace"])) throw new Error("skill.distill_from_trace requires trace[]");
  const result = await distillSkillFromTrace(a["trace"] as never[], String(a["skillName"] ?? ""), {
    library: library(ctx),
    ...(typeof a["description"] === "string" ? { description: a["description"] } : {}),
    workspace: { bucket: ctx.env.workspaceBucket ?? ctx.env.scriptsBucket, prefix: workspacePrefix(ctx.env) },
  });
  return { ok: true, name: result.metadata.name, parameters: result.metadata.parameters, verified: true };
}

async function distillVideo(a: Record<string, unknown>, ctx: PrebuiltOpContext): Promise<unknown> {
  return distillSkillFromVideo(ctx.env, { videoPath: String(a["videoPath"] ?? ""), skillName: String(a["skillName"] ?? ""), ...(typeof a["description"] === "string" ? { description: a["description"] } : {}) });
}

export const skillManager: PrebuiltScript = {
  name: "skill-manager",
  description:
    "Inspect and maintain the skills this space has learned: see which are working, which are broken and why, roll back a bad patch, retire one that is beyond repair, or share a proven one with every business on this template.",
  domain: "compute",
  requires_tier: 1,
  operations: {
    "skill.health": health,
    "skill.inspect": inspect,
    "skill.rollback": rollback,
    "skill.retire": retire,
    "skill.promote": promote,
    "skill.distill_from_trace": distillTrace,
    "skill.distill_from_video": distillVideo,
  },
  paramHints: {
    "skill.distill_from_trace": "trace and skillName are required; description is optional.",
    "skill.distill_from_video": "videoPath and skillName are required; description is optional.",
  },
};
