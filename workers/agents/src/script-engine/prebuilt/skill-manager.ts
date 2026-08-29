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
import type { ScriptMetadata, ExecutionTier } from "../types.js";
import { SkillLibrary } from "../skill-library.js";
import { assessSkillHealth } from "../skill-health.js";
import { isPromotable } from "../federation.js";
import { removeScriptEmbedding } from "../script-find.js";
import { mintInternalToken } from "@naelao/http";

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

async function distillSkill(a: Record<string, unknown>, ctx: PrebuiltOpContext): Promise<unknown> {
  const skillName = String(a["name"] ?? a["skill_name"] ?? "").trim();
  if (!skillName) throw new Error("skill.distill requires a skill name");
  const rawTrace = a["trace"];
  const description = String(a["description"] ?? `Automated skill distilled from task demonstration: ${skillName}`);
  const domain = String(a["domain"] ?? "automation");
  const requiresTier = Number(a["requires_tier"] ?? a["requiresTier"] ?? 2) as 1 | 2 | 3 | 4 | 5;

  let trace: Array<{ op?: string; input?: unknown; output?: unknown; action?: string; args?: unknown; result?: unknown }> = [];
  if (Array.isArray(rawTrace)) {
    trace = rawTrace as typeof trace;
  } else if (typeof a["code"] === "string") {
    // If code is already provided, directly synthesize and commit to R2 Skill Library
    const lib = library(ctx);
    const existing = await lib.readMetadata(skillName);
    if (existing) {
      const updated = await lib.update({
        name: skillName,
        code: a["code"] as string,
        patchType: "minor_fix",
        reason: "Distilled skill code updated from demonstration",
        metadata: {
          description,
          domain,
          requires_tier: requiresTier,
          parameters: Array.isArray(a["parameters"]) ? (a["parameters"] as ScriptMetadata["parameters"]) : [],
        },
      });
      return { ok: true, skillName: updated.name, version: updated.version, mode: "updated" };
    }
    const created = await lib.create({
      name: skillName,
      code: a["code"] as string,
      metadata: {
        description,
        domain,
        requires_tier: requiresTier,
        origin: "distilled",
        stability_score: 1.0,
        parameters: Array.isArray(a["parameters"]) ? (a["parameters"] as ScriptMetadata["parameters"]) : [],
      },
    });
    return { ok: true, skillName: created.name, version: 1, mode: "created" };
  } else {
    throw new Error("skill.distill requires either a 'trace' array or synthesized 'code' string");
  }

  // 1. Synthesize parameterized TypeScript module from raw trace
  const paramMap = new Map<string, { type: string; description: string; required: boolean }>();
  const steps: string[] = [];

  for (let i = 0; i < trace.length; i++) {
    const step = trace[i];
    const op = step.op ?? step.action ?? `step_${i + 1}`;
    const input = step.input ?? step.args ?? {};
    
    // Parameter extraction: detect dynamic variable patterns
    if (typeof input === "object" && input !== null) {
      for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
        if (!paramMap.has(k) && typeof v === "string" && (k.includes("url") || k.includes("path") || k.includes("email") || k.includes("id") || k.includes("name"))) {
          paramMap.set(k, { type: typeof v, description: `Parameter ${k} extracted from demonstration`, required: true });
        }
      }
    }
    steps.push(`  // Step ${i + 1}: ${op}\n  const step${i + 1} = await ctx.run(${JSON.stringify(op)}, ${JSON.stringify(input)});`);
  }

  const synthesizedCode = `// Skill: ${skillName}
// Distilled from ${trace.length} demonstration step(s)
export async function run(args: Record<string, unknown>, ctx: { run: (name: string, params: Record<string, unknown>) => Promise<unknown> }) {
${steps.join("\n\n")}
  return { ok: true, message: "Demonstration executed successfully" };
}
`;

  // 2. Persist to Authoritative Skill Library in R2
  const lib = library(ctx);
  const parameters: ScriptMetadata["parameters"] = Array.from(paramMap.entries()).map(([name, conf]) => ({
    name,
    type: conf.type,
    description: conf.description,
    required: conf.required,
  }));

  const existing = await lib.readMetadata(skillName);
  if (existing) {
    const updated = await lib.update({
      name: skillName,
      code: synthesizedCode,
      patchType: "minor_fix",
      reason: `Distilled from new demonstration trace (${trace.length} steps)`,
      metadata: {
        description,
        domain,
        requires_tier: requiresTier,
        parameters,
      },
    });
    return { ok: true, skillName: updated.name, version: updated.version, mode: "updated" };
  }

  const created = await lib.create({
    name: skillName,
    code: synthesizedCode,
    metadata: {
      description,
      domain,
      requires_tier: requiresTier,
      origin: "distilled",
      stability_score: 1.0,
      parameters,
    },
  });

  return { ok: true, skillName: created.name, version: 1, mode: "created" };
}

async function distillSkillFromVideo(a: Record<string, unknown>, ctx: PrebuiltOpContext): Promise<unknown> {
  const skillName = String(a["name"] ?? a["skill_name"] ?? a["skillName"] ?? "").trim();
  if (!skillName) throw new Error("skill.distill_from_video requires a skill name");
  const videoPath = String(a["video_path"] ?? a["videoPath"] ?? a["video_key"] ?? a["videoKey"] ?? a["video"] ?? "").trim();
  const description = String(a["description"] ?? `Automated skill learned from video demonstration: ${skillName}`);
  const domain = String(a["domain"] ?? "automation");
  const requiresTier = Number(a["requires_tier"] ?? a["requiresTier"] ?? 4) as ExecutionTier;
  const runtime = a["runtime"] === "workflow" || requiresTier === 3 ? "workflow" : "isolate";

  // Action Sequence Extraction from video representation or input parameters
  const rawActions = a["actions"] ?? a["steps"] ?? a["actionSequence"];
  const userParams = Array.isArray(a["parameters"]) ? (a["parameters"] as ScriptMetadata["parameters"]) : [];
  const paramMap = new Map<string, { type: string; description: string; required: boolean }>();

  for (const p of userParams) {
    paramMap.set(p.name, { type: p.type, description: p.description, required: p.required });
  }

  const steps: string[] = [];
  if (Array.isArray(rawActions)) {
    for (let i = 0; i < rawActions.length; i++) {
      const act = rawActions[i] as { actionType?: string; type?: string; target?: string; selector?: string; url?: string; valueExpression?: string; text?: string; command?: string; description?: string };
      const actionType = (act.actionType ?? act.type ?? "ACTION").toUpperCase();
      const target = act.target ?? act.selector ?? act.url ?? "";
      const text = act.valueExpression ?? act.text ?? act.command ?? "";
      const desc = act.description ?? `Step ${i + 1}`;

      if (actionType === "NAVIGATE") {
        steps.push(`  // ${desc}\n  await ctx.run("browser.navigate", { url: ${JSON.stringify(target)} });`);
      } else if (actionType === "TYPE") {
        steps.push(`  // ${desc}\n  await ctx.run("browser.type", { selector: ${JSON.stringify(target)}, text: ${JSON.stringify(text)} });`);
      } else if (actionType === "CLICK") {
        steps.push(`  // ${desc}\n  await ctx.run("browser.click", { selector: ${JSON.stringify(target)} });`);
      } else if (actionType === "BASH" || actionType === "COMMAND") {
        steps.push(`  // ${desc}\n  await ctx.run("Bash", { command: ${JSON.stringify(text || target)} });`);
      } else if (actionType === "EXTRACT") {
        steps.push(`  // ${desc}\n  const data${i + 1} = await ctx.run("browser.extract", { selector: ${JSON.stringify(target)} });`);
      } else {
        steps.push(`  // ${desc}\n  await ctx.run(${JSON.stringify(act.type || "action")}, ${JSON.stringify({ target, text })});`);
      }
    }
  } else if (typeof a["code"] === "string") {
    // Custom synthesized code provided directly
    steps.push(a["code"] as string);
  } else {
    // Synthesize generic video-distilled action pipeline
    steps.push(
      `  // Step 1: Navigate to target interface\n  const page = await ctx.run("browser.navigate", { url: args["target_url"] || args["url"] || "" });\n` +
      `  // Step 2: Fill input fields and trigger action\n  if (args["input_text"]) { await ctx.run("browser.type", { text: String(args["input_text"]) }); }\n` +
      `  // Step 3: Extract results\n  const extracted = await ctx.run("browser.extract", {});`
    );
    if (!paramMap.has("url")) paramMap.set("url", { type: "string", description: "Target URL to navigate and execute", required: true });
    if (!paramMap.has("input_text")) paramMap.set("input_text", { type: "string", description: "Dynamic parameter input", required: false });
  }

  const synthesizedCode = typeof a["code"] === "string"
    ? (a["code"] as string)
    : `/**
 * Auto-Distilled Skill: ${skillName}
 * ${description}
 * Distilled from video recording: ${videoPath || "uploaded_demo"}
 */
export async function run(args: Record<string, any>, ctx: any) {
  ${Array.from(paramMap.keys()).map((p) => `const ${p} = args["${p}"];`).join("\n  ")}

  // Replay synthesized action timeline
${steps.join("\n\n")}

  return { ok: true, message: "Successfully executed learned skill: ${skillName}" };
}
`;

  const lib = library(ctx);
  const parameters: ScriptMetadata["parameters"] = Array.from(paramMap.entries()).map(([name, conf]) => ({
    name,
    type: conf.type,
    description: conf.description,
    required: conf.required,
  }));

  const existing = await lib.readMetadata(skillName);
  if (existing) {
    const updated = await lib.update({
      name: skillName,
      code: synthesizedCode,
      patchType: "minor_fix",
      reason: `Distilled from video demonstration (${videoPath || "demo"})`,
      metadata: {
        description,
        domain,
        requires_tier: requiresTier,
        runtime,
        parameters,
      },
    });
    return {
      ok: true,
      skillName: updated.name,
      version: updated.version,
      mode: "updated",
      parameters,
      message: `✔ Successfully updated skill '${skillName}' from video demonstration.`,
    };
  }

  const created = await lib.create({
    name: skillName,
    code: synthesizedCode,
    metadata: {
      description,
      domain,
      requires_tier: requiresTier,
      runtime,
      origin: "distilled",
      stability_score: 1.0,
      parameters,
    },
  });

  return {
    ok: true,
    skillName: created.name,
    version: 1,
    mode: "created",
    parameters,
    message: `✔ Successfully learned and registered skill '${skillName}' from video demonstration.`,
  };
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
    "skill.distill": distillSkill,
    "skill.distill_demonstration": distillSkill,
    "skill.distill_from_video": distillSkillFromVideo,
    "skill.distill_video": distillSkillFromVideo,
  },
};
