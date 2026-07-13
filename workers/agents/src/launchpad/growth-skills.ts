/**
 * Growth-layer prebuilt skills (AUDIT_TODO.md G-1/G-3): social posting and image/video
 * generation, built as ORDINARY stored scripts (same "SCRIPT.md + code.ts" pattern as
 * scaling-skills.ts, not new engine opcodes) that wrap the mcp-connector prebuilt. The actual
 * capability lives entirely in a connected MCP app (Composio-hosted Twitter/LinkedIn/Instagram/
 * TikTok, or Higgsfield's own hosted MCP for image/video) — these skills are thin, well-tagged
 * wrappers so `script.find` surfaces them, and a friendly one-line instruction to connect the
 * app when it isn't connected yet (mcp-connector.ts's resolveServerId already returns a
 * needs_connector-flagged error naming the exact connector; these skills just relay it rather
 * than swallowing it into a generic failure).
 */

import type { ScalingSkill, SeedableLibrary } from "./scaling-skills.js";

const SOCIAL_POST = `
export async function run(args, ctx) {
  const platform = String(args.platform || "").trim();
  if (!platform) return { error: "social-post requires { platform, text }. platform is one of: twitter, linkedin, instagram, tiktok." };
  const text = args.text || args.caption || "";
  try {
    const result = await ctx.run("mcp.call", {
      server: platform,
      tool: args.tool || "create_post",
      params: { text, ...(args.media_url ? { media_url: args.media_url } : {}), ...(args.params || {}) },
    });
    return { posted: true, platform, result };
  } catch (e) {
    // mcp-connector's resolveServerId already names the exact app to connect when it isn't
    // registered yet — relay that message verbatim rather than a generic "failed."
    return { posted: false, platform, error: String((e && e.message) || e) };
  }
}`;

const GENERATE_IMAGE = `
export async function run(args, ctx) {
  const prompt = String(args.prompt || "").trim();
  if (!prompt) return { error: "generate-image requires { prompt }." };
  try {
    const result = await ctx.run("mcp.call", {
      server: "higgsfield",
      tool: "generate_image",
      params: { prompt, ...(args.model ? { model: args.model } : {}), ...(args.params || {}) },
    });
    return { generated: true, prompt, result };
  } catch (e) {
    return { generated: false, prompt, error: String((e && e.message) || e) };
  }
}`;

const GENERATE_VIDEO = `
export async function run(args, ctx) {
  const prompt = String(args.prompt || "").trim();
  if (!prompt) return { error: "generate-video requires { prompt }." };
  try {
    const result = await ctx.run("mcp.call", {
      server: "higgsfield",
      tool: "generate_video",
      params: { prompt, ...(args.model ? { model: args.model } : {}), ...(args.image_url ? { image_url: args.image_url } : {}), ...(args.params || {}) },
    });
    return { generated: true, prompt, result };
  } catch (e) {
    return { generated: false, prompt, error: String((e && e.message) || e) };
  }
}`;

export const LAUNCHPAD_GROWTH_SKILLS: readonly ScalingSkill[] = [
  { name: "social-post", domain: "marketing", code: SOCIAL_POST,
    description: "Post or schedule an update to a connected social platform (X/Twitter, LinkedIn, Instagram, TikTok). Names the exact app to connect first if it isn't linked yet.",
    tags: ["social", "post", "twitter", "x", "linkedin", "instagram", "tiktok", "marketing", "content"] },
  { name: "content-generate-image", domain: "marketing", code: GENERATE_IMAGE,
    description: "Generate a marketing image from a text prompt via the connected Higgsfield app (product shots, hero images, social graphics).",
    tags: ["image", "generate image", "higgsfield", "marketing", "content", "design", "product photo"] },
  { name: "content-generate-video", domain: "marketing", code: GENERATE_VIDEO,
    description: "Generate a short marketing or social video from a text prompt (optionally from an image) via the connected Higgsfield app.",
    tags: ["video", "generate video", "higgsfield", "kling", "marketing", "content", "social video", "talking head"] },
];

/** Seeds the three growth skills, same idempotent/best-effort contract as seedScalingSkills. */
export async function seedGrowthSkills(library: SeedableLibrary): Promise<string[]> {
  const created: string[] = [];
  for (const skill of LAUNCHPAD_GROWTH_SKILLS) {
    try {
      if (await library.exists(skill.name)) continue;
      await library.create({
        name: skill.name,
        code: skill.code.trim(),
        metadata: { description: skill.description, domain: skill.domain, requires_tier: 2, tags: skill.tags },
      });
      created.push(skill.name);
    } catch {
      /* best-effort — a single skill failing must not abort provisioning */
    }
  }
  return created;
}
