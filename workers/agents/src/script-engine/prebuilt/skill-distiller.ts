import { generateObject } from "ai";
import { z } from "zod";

export async function distillSkillFromTrace(
  trace: Array<{ op: string; input: Record<string, any>; output: any }>,
  skillName: string,
  ctx: any
) {
  // 1. Synthesize parameterized TypeScript module from raw execution trace
  const { object: skillSpec } = await generateObject({
    model: ctx.env.AI_GATEWAY("gemini-2.5-flash"), // Fast model for code synthesis
    schema: z.object({
      description: z.string(),
      parameters: z.array(z.object({
        name: z.string(),
        type: z.enum(["string", "number", "boolean"]),
        description: z.string()
      })),
      handlerCode: z.string().describe("The full TypeScript function body. MUST use ctx primitives (ctx.cli, ctx.fs, ctx.vault). Do not wrap in markdown blocks.")
    }),
    prompt: `Convert this raw execution trace into a reusable, parameterized TypeScript skill.
    Name: ${skillName}
    Trace: ${JSON.stringify(trace)}
    
    Return a clean, optimized function body that executes this sequence using the AVOS ctx SDK.`
  });

  const synthesizedCode = `
/**
 * Auto-Distilled Skill: ${skillName}
 * ${skillSpec.description}
 */
export async function run(args: Record<string, any>, ctx: any) {
  ${skillSpec.parameters.map(p => `const ${p.name} = args["${p.name}"];`).join("\n  ")}
  
  try {
${skillSpec.handlerCode.split('\n').map(line => `    ${line}`).join('\n')}
    return { ok: true, message: "Successfully executed skill: ${skillName}" };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}`;

  // 2. Verify compilation in isolated Tier 2 V8 sandbox
  const verifyRun = await ctx.env.codeRunner.run({
    name: `verify_${skillName}`,
    code: synthesizedCode,
    tier: 2,
    args: {}, // Run without args just to check compilation/syntax
    dryRun: true,
    spaceId: ctx.env.spaceId,
    agentId: ctx.env.agentId
  });

  if (verifyRun.exitCode !== 0 && verifyRun.exitCode !== undefined) {
    throw new Error(`Skill distillation failed syntax verification: ${verifyRun.stderr}`);
  }

  // 3. Persist to shared skills directory (Git-ignored internal meta-state)
  const targetPath = `/.avos/shared/skills/${skillName}.ts`;
  await ctx.fs.write(targetPath, synthesizedCode);

  return { 
    ok: true, 
    skillName, 
    path: targetPath, 
    parameters: skillSpec.parameters 
  };
}
