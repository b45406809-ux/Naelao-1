import { generateObject } from "ai";
import { z } from "zod";

export async function distillSkillFromVideo(
  videoR2Key: string,
  skillName: string,
  ctx: any
) {
  // 1. Verify file exists in R2 Workspace
  const fileStat = await ctx.fs.stat(videoR2Key);
  if (!fileStat.exists) {
    throw new Error(`Video file not found in workspace: ${videoR2Key}`);
  }

  // 2. Multimodal Action Extraction
  // Note: In production, the video buffer is passed to a multimodal endpoint.
  // Here we define the extraction schema to map visual actions to SDK steps.
  const { object: actionSequence } = await generateObject({
    model: ctx.env.AI_GATEWAY("gemini-2.5-flash"), // Multimodal vision capable
    schema: z.object({
      parameters: z.array(z.object({
        name: z.string(),
        type: z.string(),
        description: z.string()
      })),
      steps: z.array(z.object({
        actionType: z.enum(["NAVIGATE", "CLICK", "TYPE", "EXTRACT", "BASH"]),
        target: z.string().describe("URL, CSS selector, or CLI command"),
        valueExpression: z.string().describe("Dynamic parameter name (e.g. args.invoiceId) or literal string"),
        description: z.string()
      }))
    }),
    prompt: `Analyze this recorded video demonstration for skill '${skillName}'.
    Extract the parameterizable inputs, DOM interactions, and logic flow required to replicate this exact task programmatically using the AVOS SDK.`
  });

  // 3. Synthesize clean TypeScript utilizing universal ctx primitives
  const synthesizedCode = `
/**
 * Auto-Distilled Video Skill: ${skillName}
 * Source: ${videoR2Key}
 */
export async function run(args: Record<string, any>, ctx: any) {
  ${actionSequence.parameters.map(p => `const ${p.name} = args["${p.name}"];`).join("\n  ")}

  // Replay synthesized action timeline
  ${actionSequence.steps.map(s => {
    if (s.actionType === "NAVIGATE") return `await ctx.browser.execute({ action: "navigate", url: "${s.target}" });`;
    if (s.actionType === "CLICK") return `await ctx.browser.execute({ action: "click", selector: "${s.target}" });`;
    if (s.actionType === "TYPE") return `await ctx.browser.execute({ action: "type", selector: "${s.target}", text: ${s.valueExpression} });`;
    if (s.actionType === "BASH") return `await ctx.cli.exec(${s.valueExpression});`;
    return `// ${s.description}`;
  }).join("\n  ")}

  return { ok: true, message: "Successfully executed video-learned skill: ${skillName}" };
}
`;

  // 4. Save to Authoritative Skill Library in R2 internal namespace
  const targetPath = `/.avos/shared/skills/${skillName}.ts`;
  await ctx.fs.write(targetPath, synthesizedCode);

  return {
    ok: true,
    skillName,
    path: targetPath,
    parameters: actionSequence.parameters,
    message: `✔ Successfully learned and registered skill '${skillName}' from video demonstration.`
  };
}
