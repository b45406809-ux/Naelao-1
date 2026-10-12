import { interceptPlatformCli } from "./virtual-cli.js";
import type { LoopStep } from "./step-context.js";
const IMAGE_FIELDS = new Set(["image_base64", "screenshot", "screenshot_base64", "image_url", "image_data"]);
function textOnly(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(textOnly);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !IMAGE_FIELDS.has(key)).map(([key, entry]) => [key, textOnly(entry)]));
}
/** One explicit see result reaches exactly the next model turn. Other history stays text-only. */
export function preparePerception(steps: readonly LoopStep[]): { steps: LoopStep[]; imageUrl?: string } {
  const last = [...steps].reverse().find(step => step.name !== "system_one.loop_evaluation");
  const value = last?.output as { image_base64?: unknown; mime_type?: unknown } | undefined;
  const command = last?.params.commands ?? last?.params.command ?? last?.params.cmd;
  const see = last?.name === "browser.see" || (last?.name === "Bash" && typeof command === "string" && interceptPlatformCli(command)?.operation === "browser.see");
  const image = see && last?.ok && typeof value?.image_base64 === "string" && value.mime_type === "image/png" && /^[A-Za-z0-9+/]*={0,2}$/.test(value.image_base64) && value.image_base64.length <= 5_592_408 ? value.image_base64 : undefined;
  return { steps: steps.map(step => ({ ...step, ...(step.output === undefined ? {} : { output: textOnly(step.output) }) })), ...(image ? { imageUrl: `data:image/png;base64,${image}` } : {}) };
}
