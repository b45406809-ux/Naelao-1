import type {
  ScriptEngineEnv,
  ScriptParameter,
  VideoSkillAction,
} from "./types.js";
import { workspacePrefix } from "./types.js";
import { assertWorkspaceFileAllowed } from "./workspace-paths.js";
import {
  BrowserDemonstrationStore,
  validateDemoSteps,
  type BrowserDemoStep,
} from "./browser-demonstrations.js";

/** Video observations produce semantic drafts, never executable CSS-selector code. */
export function synthesizeVideoSkill(actions: VideoSkillAction[]): {
  steps: BrowserDemoStep[];
  parameters: ScriptParameter[];
} {
  if (!Array.isArray(actions) || actions.length < 2 || actions.length > 32)
    throw new Error("invalid_video_demonstration_actions");
  const parameters: ScriptParameter[] = [];
  const steps = actions.map((action, index) => {
    if (action.type === "NAVIGATE" && index === 0) return { type: "navigate" };
    if (
      action.type !== "CLICK" &&
      action.type !== "TYPE" &&
      action.type !== "ASSERT"
    )
      throw new Error("video_demonstration_requires_manual_review");
    if (!action.target)
      throw new Error("video_demonstration_semantic_target_required");
    if (action.type === "TYPE") {
      const parameter = action.parameter ?? "input_" + index;
      if (!parameters.some((p) => p.name === parameter))
        parameters.push({
          name: parameter,
          type: "string",
          description: "Input for " + action.target.name,
          required: true,
        });
      return { type: "type", target: action.target, parameter };
    }
    return {
      type: action.type === "CLICK" ? "click" : "assert",
      target: action.target,
    };
  });
  return { steps: validateDemoSteps(steps), parameters };
}

export async function distillSkillFromVideo(
  env: ScriptEngineEnv,
  input: { videoPath: string; skillName: string; description?: string }
) {
  const library = new BrowserDemonstrationStore(env.scriptsBucket, env);
  // Validate name, workspace jail and delegated file grant before fetching/reading video bytes.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(input.skillName))
    throw new Error("invalid_demonstration_name");
  const normalized = assertWorkspaceFileAllowed(
    env.workspaceFileScope,
    input.videoPath
  );
  if (!/\.(mp4|webm)$/i.test(normalized))
    throw new Error("unsupported_demonstration_video_type");
  if (!env.videoSkillAnalyzer)
    throw new Error("video_demonstration_analyzer_unavailable");
  const bucket = env.workspaceBucket ?? env.scriptsBucket;
  const object = await bucket.get(workspacePrefix(env) + normalized);
  if (!object) throw new Error("demonstration_video_not_found");
  if (
    !Number.isSafeInteger(object.size) ||
    object.size <= 0 ||
    object.size > 20 * 1024 * 1024
  )
    throw new Error("demonstration_video_too_large");
  const contentType =
    object.httpMetadata?.contentType ??
    (normalized.endsWith(".webm") ? "video/webm" : "video/mp4");
  if (!["video/mp4", "video/webm"].includes(contentType))
    throw new Error("unsupported_demonstration_video_type");
  const data = await object.arrayBuffer();
  if (data.byteLength !== object.size)
    throw new Error("demonstration_video_size_mismatch");
  const actions = await env.videoSkillAnalyzer.analyze({
    data,
    contentType,
    ...(input.description ? { description: input.description } : {}),
  });
  const synthesized = synthesizeVideoSkill(actions);
  const skill = await library.draft(
    input.skillName,
    input.description ?? "Workflow learned from a video demonstration",
    synthesized.steps,
    "video"
  );
  return {
    ok: true,
    name: skill.name,
    actions: skill.steps.length,
    parameters: synthesized.parameters,
    verified: false,
    status: "draft",
    requires_review: true,
    requires_test: true,
    requires_explicit_enable: true,
  };
}
