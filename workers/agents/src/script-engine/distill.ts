import type { DemonstrationStep, ExecutionTier, ScriptMetadata, ScriptParameter } from "./types.js";
import { SkillLibrary } from "./skill-library.js";

export interface DistillTraceOptions {
  library: SkillLibrary;
  description?: string;
  requiresTier?: ExecutionTier;
  /** Optional project workspace mirror implementing the public /.avos layout. */
  workspace?: { bucket: R2Bucket; prefix: string };
}

const safeName = (name: string): string => {
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(name)) throw new Error("Invalid skill name");
  return name;
};

function parameterName(step: DemonstrationStep, key: string, used: Set<string>): string {
  const base = `${step.name.replace(/[^a-z0-9]+/gi, "_")}_${key.replace(/[^a-z0-9]+/gi, "_")}`.replace(/^_+|_+$/g, "");
  let candidate = base || "value";
  for (let n = 2; used.has(candidate); n++) candidate = `${base}_${n}`;
  used.add(candidate);
  return candidate;
}

/** Compile an observed sequence into a deterministic, parameterized universal-runtime module. */
export async function distillSkillFromTrace(
  trace: DemonstrationStep[], skillName: string, options: DistillTraceOptions
): Promise<{ code: string; metadata: ScriptMetadata }> {
  safeName(skillName);
  const successful = trace.filter((step) => step.ok !== false);
  if (successful.length === 0) throw new Error("A skill requires at least one successful demonstration step");
  const used = new Set<string>();
  const parameters: ScriptParameter[] = [];
  const calls = successful.map((step) => {
    const entries = Object.entries(step.params).map(([key, value]) => {
      // User-entered strings and scalar identifiers are dynamic. Structural booleans/null and
      // object configuration remain constants, preventing unusably noisy signatures.
      if (typeof value === "string" || typeof value === "number") {
        const name = parameterName(step, key, used);
        parameters.push({ name, type: typeof value, description: `${key} passed to ${step.name}`, required: true });
        return `${JSON.stringify(key)}: args[${JSON.stringify(name)}]`;
      }
      return `${JSON.stringify(key)}: ${JSON.stringify(value)}`;
    });
    return `  results.push(await ctx.run(${JSON.stringify(step.name)}, { ${entries.join(", ")} }));`;
  });
  const code = [
    'import type { RuntimeContext } from "@avos/runtime";',
    "",
    "export async function run(args: Record<string, any>, ctx: RuntimeContext) {",
    "  const results: unknown[] = [];",
    ...calls,
    "  return results.length === 1 ? results[0] : results;",
    "}", "",
  ].join("\n");
  if (!/export async function run\(args: Record<string, any>, ctx: RuntimeContext\)/.test(code)) {
    throw new Error("Synthesized skill does not implement the runtime contract");
  }
  const description = options.description ?? `Repeat the demonstrated ${skillName} workflow.`;
  const metadata = await options.library.create({ name: skillName, code, metadata: {
    description, domain: "orchestration", requires_tier: options.requiresTier ?? 2,
    parameters, calls: successful.map((s) => s.name), origin: "distilled",
  }});
  if (options.workspace) {
    const dir = `${options.workspace.prefix}.avos/skills/${skillName}/`;
    const frontMatter = ["---", `description: ${JSON.stringify(description)}`,
      `parameters: ${JSON.stringify(parameters)}`, `requires_tier: ${metadata.requires_tier}`, "---", "",
      `# ${skillName}`, "", description, ""].join("\n");
    await Promise.all([
      options.workspace.bucket.put(`${dir}code.ts`, code),
      options.workspace.bucket.put(`${dir}SCRIPT.md`, frontMatter),
    ]);
  }
  return { code, metadata };
}
