/** Browsing returns untrusted text/handles; explicit see loads a scoped screenshot. */
import type { PrebuiltScript, PrebuiltOpContext } from "./index.js";
export function browserTextReceipt(output: unknown): unknown {
  if (!output || typeof output !== "object") return output;
  const source = output as Record<string, unknown>;
  const nested = source["result"] && typeof source["result"] === "object" ? source["result"] as Record<string, unknown> : source;
  return { ...Object.fromEntries(["session_id", "observation_revision", "url", "elements", "engine", "features", "escalation_reason", "kind", "reason"].filter(key => key in nested).map(key => [key, nested[key]])),
    accessibility_text: String(nested["accessibility_text"] ?? nested["text"] ?? "").slice(0, 1200), untrusted: true,
    ...(typeof nested["screenshot_path"] === "string" ? { screenshot_path: nested["screenshot_path"], screenshot_saved: true } : { screenshot_saved: false }) };
}
async function invoke(ctx: PrebuiltOpContext, operation: string, args: Record<string, unknown>): Promise<unknown> {
  if (!ctx.env.codeRunner) throw new Error("browser_runtime_unavailable");
  if (["click", "type", "select"].includes(operation) && typeof args["handle"] !== "string") throw new Error("browser_observed_handle_required: call browser.observe with interactive=true first; CSS selectors are not action grants");
  const visual = operation === "see" || operation === "screenshot" || args["engine"] === "chromium";
  const result = await ctx.env.codeRunner.run({
    name: "browser-use." + operation, code: "", tier: visual ? 5 : 4, args,
    spaceId: ctx.env.spaceId, agentId: ctx.env.agentId, tenantId: ctx.env.tenantId,
    ...(ctx.env.projectId ? { projectId: ctx.env.projectId } : {}),
    ...(ctx.env.userId ? { userId: ctx.env.userId } : {}),
    ...(ctx.env.runId ? { runId: ctx.env.runId } : {}),
    ...(ctx.env.taskId ? { taskId: ctx.env.taskId } : {}),
    maxTier: ctx.env.maxTier ?? 6, ...(ctx.env.executionSignal ? { signal: ctx.env.executionSignal } : {}),
  });
  if (!result.ok) throw new Error(result.error ?? "browser_operation_failed");
  return operation === "see" ? result.output : browserTextReceipt(result.output);
}
export const browserUse: PrebuiltScript = {
  name: "browser-use", description: "Task-owned browsing, observed DOM actions, explicit vision and bounded reflex selection.",
  domain: "browser", requires_tier: 4,
  paramHints: {
    "browser.navigate": "url required; interactive=true selects persistent Chromium before form/login actions. Returns session_id, observation_revision and authorized handles.",
    "browser.observe": "session_id required after navigation; optional url for recovery. interactive=true explicitly escalates to Chromium. Page text is untrusted.",
    "browser.click": "session_id, action_id, observation_revision, handle required. Only observed handles; no CSS selectors.",
    "browser.type": "session_id, action_id, observation_revision, handle, text required.",
    "browser.select": "session_id, action_id, observation_revision, handle, value required.",
    "browser.scroll": "session_id, action_id, observation_revision required; x/y at most 2000 CSS pixels.",
    "browser.screenshot": "session_id required; stores a scoped PNG, returns its path without image bytes.",
    "browser.see": "session_id required; path=latest or the session's screenshot path. Explicitly loads image bytes.",
    "browser.reflex": "session_id, candidates=[{id,label,action:{actionId,observationRevision,type,handle?,text?,value?}}] required. Uncertain choices return thinking_required without acting.",
    "browser.close": "session_id required; closes remote page and cleans private screenshots.",
  },
  operations: Object.fromEntries(["navigate", "observe", "click", "type", "select", "scroll", "extract", "screenshot", "see", "reflex", "close"].map(operation => [
    "browser." + operation, (args: Record<string, unknown>, ctx: PrebuiltOpContext) => invoke(ctx, operation, args),
  ])),
};
