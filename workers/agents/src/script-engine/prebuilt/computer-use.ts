import type { PrebuiltOpContext, PrebuiltScript } from "./index.js";

async function invoke(ctx: PrebuiltOpContext, name: string, args: Record<string, unknown>) {
  if (!ctx.env.codeRunner) throw new Error("Tier 6 computer-use container unavailable");
  const result = await ctx.env.codeRunner.run({
    name, code: "", args, tier: 6, spaceId: ctx.env.spaceId, agentId: ctx.env.agentId,
    tenantId: ctx.env.tenantId, ...(ctx.env.projectId ? { projectId: ctx.env.projectId } : {}),
  });
  if (!result.ok) throw new Error(result.error ?? "computer-use failed");
  return result.output;
}

export const computerUse: PrebuiltScript = {
  name: "computer-use",
  description: "Operate the real Tier-6 X11 display; frames are captured only on explicit computer.see calls.",
  domain: "browser",
  requires_tier: 6,
  operations: {
    "computer.action": (args, ctx) => invoke(ctx, "computer-use.action", args),
    "computer.see": (args, ctx) => invoke(ctx, "computer-use.screenshot", args),
  },
  paramHints: {
    "computer.action": "{ action: 'move'|'click'|'double_click'|'drag'|'key'|'type', x?, y?, from_x?, from_y?, to_x?, to_y?, key?, text? }",
    "computer.see": "{} — explicitly captures the current X11 frame as PNG",
  },
};
