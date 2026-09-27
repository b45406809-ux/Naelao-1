import type { ScriptEngineEnv, ScriptParameter, VideoSkillAction } from "./types.js";
import { workspacePrefix } from "./types.js";
import { SkillLibrary } from "./skill-library.js";

export function synthesizeVideoSkill(actions: VideoSkillAction[]): { code: string; parameters: ScriptParameter[] } {
  if (!actions.length) throw new Error("The recording contained no reproducible actions");
  const parameters: ScriptParameter[] = [];
  const lines: string[] = ["  const extracted: Record<string, unknown> = {};"];
  for (const action of actions) {
    switch (action.type) {
      case "NAVIGATE": lines.push(`  await ctx.browser.navigate(${JSON.stringify(action.url)});`); break;
      case "CLICK": lines.push(`  await ctx.browser.click(${JSON.stringify(action.selector)});`); break;
      case "TYPE": {
        if (action.parameter) {
          if (!parameters.some((p) => p.name === action.parameter)) parameters.push({ name: action.parameter, type: "string", description: `Text entered into ${action.selector}`, required: true });
          lines.push(`  await ctx.browser.type(${JSON.stringify(action.selector)}, String(args[${JSON.stringify(action.parameter)}]));`);
        } else lines.push(`  await ctx.browser.type(${JSON.stringify(action.selector)}, ${JSON.stringify(action.value)});`);
        break;
      }
      case "EXTRACT": lines.push(`  extracted[${JSON.stringify(action.as)}] = await ctx.browser.extract(${JSON.stringify(action.selector)});`); break;
      case "BASH": lines.push(`  await ctx.Bash(${JSON.stringify(action.command)});`); break;
      case "ASSERT": lines.push(`  await ctx.browser.assert(${JSON.stringify(action.selector)}${action.text === undefined ? "" : `, ${JSON.stringify(action.text)}`});`); break;
    }
  }
  lines.push("  return extracted;");
  const code = ['import type { RuntimeContext } from "@avos/runtime";', "", "export async function run(args: Record<string, any>, ctx: RuntimeContext) {", ...lines, "}", ""].join("\n");
  validateVideoSkill(code);
  return { code, parameters };
}

export function validateVideoSkill(code: string): void {
  if (!/export async function run\(args: Record<string, any>, ctx: RuntimeContext\)/.test(code)) throw new Error("Invalid distilled skill contract");
  if (/\b(?:eval|Function)\s*\(|\bprocess\.|\bimport\s*\(/.test(code)) throw new Error("Unsafe construct in distilled skill");
  // All generated statements must use the deliberately small universal primitive set.
  const calls = [...code.matchAll(/ctx\.([A-Za-z]+(?:\.[A-Za-z]+)?)\s*\(/g)].map((m) => m[1]);
  if (calls.some((call) => !["browser.navigate", "browser.click", "browser.type", "browser.extract", "browser.assert", "Bash"].includes(call!))) throw new Error("Unsupported runtime primitive");
}

export async function distillSkillFromVideo(env: ScriptEngineEnv, input: { videoPath: string; skillName: string; description?: string }) {
  if (!env.videoSkillAnalyzer) throw new Error("Video skill distillation is unavailable: no multimodal analyzer is configured");
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(input.skillName)) throw new Error("Invalid skill name");
  const bucket = env.workspaceBucket ?? env.scriptsBucket;
  const normalized = input.videoPath.replace(/^\/+/, "");
  const object = await bucket.get(`${workspacePrefix(env)}${normalized}`);
  if (!object) throw new Error(`Video not found in project workspace: ${input.videoPath}`);
  const actions = await env.videoSkillAnalyzer.analyze({ data: await object.arrayBuffer(), contentType: object.httpMetadata?.contentType ?? "video/mp4", ...(input.description ? { description: input.description } : {}) });
  const synthesized = synthesizeVideoSkill(actions); // contract/sandbox allowlist pass before registration
  const library = new SkillLibrary(env.scriptsBucket, env.spaceId);
  const metadata = await library.create({ name: input.skillName, code: synthesized.code, metadata: {
    description: input.description ?? `Automation learned from ${input.videoPath}`,
    domain: "browser", requires_tier: 2, parameters: synthesized.parameters, origin: "distilled",
  }});
  const dir = `${workspacePrefix(env)}.avos/skills/${input.skillName}/`;
  await Promise.all([bucket.put(`${dir}code.ts`, synthesized.code), bucket.put(`${dir}SCRIPT.md`, ["---", `description: ${JSON.stringify(metadata.description)}`, `parameters: ${JSON.stringify(metadata.parameters)}`, "requires_tier: 2", "---", "", metadata.description].join("\n"))]);
  return { ok: true, name: input.skillName, actions: actions.length, verified: true, metadata };
}
