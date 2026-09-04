/**
 * Demonstration-to-skill distillation.
 *
 * This intentionally writes beneath `.avos/shared/skills`, an AVOS-owned namespace
 * in the virtual workspace. It never writes into a user's source tree or local
 * `/workspace` checkout. The generated module is verified before it is persisted:
 * a failed demonstration is not a reusable automation.
 */

import type { PrebuiltOpContext } from "./index.js";
import { writeFileImpl } from "./r2-workspace.js";

export interface DemonstrationTraceStep {
  op: string;
  input: Record<string, unknown>;
  output?: unknown;
}

export interface DistilledSkillIndexEntry {
  name: string;
  path: string;
  description: string;
  parameters: Array<{ name: string; type: string; required: boolean }>;
}

type DistillationContext = PrebuiltOpContext & {
  env: PrebuiltOpContext["env"] & {
    fs?: { write(path: string, content: string): Promise<void> };
    indexSkillMetadata?: (entry: DistilledSkillIndexEntry) => Promise<void>;
  };
};

const SKILLS_ROOT = "/.avos/shared/skills";

function assertSkillName(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(name)) {
    throw new Error("Skill names may only contain letters, numbers, dots, underscores, and hyphens.");
  }
}

function parametersFromTrace(trace: DemonstrationTraceStep[]): DistilledSkillIndexEntry["parameters"] {
  const parameters = new Map<string, { name: string; type: string; required: boolean }>();
  for (const step of trace) {
    for (const [name, value] of Object.entries(step.input)) {
      // Trace values are examples. Values named as identifiers/targets are intentionally
      // parameterized; incidental flags remain deterministic constants in the skill.
      if (/(email|id|url|path|selector|name)$/i.test(name) && !parameters.has(name)) {
        parameters.set(name, { name, type: Array.isArray(value) ? "array" : typeof value, required: true });
      }
    }
  }
  return [...parameters.values()];
}

function synthesizeSkillCode(skillName: string, trace: DemonstrationTraceStep[], parameters: DistilledSkillIndexEntry["parameters"]): string {
  const parameterNames = new Set(parameters.map((parameter) => parameter.name));
  const steps = trace.map((step, index) => {
    const input = Object.fromEntries(Object.entries(step.input).map(([name, value]) => [
      name,
      parameterNames.has(name) ? `args[${JSON.stringify(name)}]` : JSON.stringify(value),
    ]));
    const argumentExpression = `{ ${Object.entries(input).map(([name, value]) => `${JSON.stringify(name)}: ${value}`).join(", ")} }`;
    return `  // Demonstrated step ${index + 1}: ${step.op}\n  await ctx.run(${JSON.stringify(step.op)}, ${argumentExpression});`;
  });

  return `/** Distilled AVOS skill: ${skillName}. Generated from a verified demonstration. */
export async function run(args: Record<string, unknown>, ctx: { run(name: string, params: Record<string, unknown>): Promise<unknown> }) {
${steps.join("\n\n")}
  return { ok: true };
}
`;
}

/** Compile, verify, persist, and semantically index one recorded demonstration. */
export async function distillSkillFromTrace(
  trace: DemonstrationTraceStep[],
  skillName: string,
  ctx: DistillationContext
): Promise<{ ok: true; skillName: string; path: string; parameters: DistilledSkillIndexEntry["parameters"] }> {
  assertSkillName(skillName);
  if (trace.length === 0) throw new Error("Skill distillation requires at least one recorded operation.");
  if (trace.some((step) => !step || typeof step.op !== "string" || !step.op || !step.input || typeof step.input !== "object" || Array.isArray(step.input))) {
    throw new Error("Each demonstration step must include an operation and an object input.");
  }
  if (!ctx.env.codeRunner) throw new Error("Skill distillation verification requires a Tier 2 code runner.");

  const parameters = parametersFromTrace(trace);
  const code = synthesizeSkillCode(skillName, trace, parameters);
  const verification = await ctx.env.codeRunner.run({
    name: `verify_${skillName}`,
    code,
    tier: 2,
    args: trace[0]!.input,
    spaceId: ctx.env.spaceId,
    agentId: ctx.env.agentId,
    tenantId: ctx.env.tenantId,
    ...(ctx.env.projectId ? { projectId: ctx.env.projectId } : {}),
  });
  if (!verification.ok) throw new Error(`Skill distillation failed verification: ${verification.error ?? "unknown error"}`);

  const path = `${SKILLS_ROOT}/${skillName}.ts`;
  // The injected adapter is used by the isolated runtime. The R2 workspace fallback
  // keeps the prebuilt usable in current DO deployments while retaining the same
  // AVOS-owned virtual path and never touching a local checkout.
  if (ctx.env.fs) await ctx.env.fs.write(path, code);
  else await writeFileImpl(ctx, path, code);
  await ctx.env.indexSkillMetadata?.({
    name: skillName,
    path,
    description: `Distilled skill: ${skillName}`,
    parameters,
  });
  return { ok: true, skillName, path, parameters };
}
