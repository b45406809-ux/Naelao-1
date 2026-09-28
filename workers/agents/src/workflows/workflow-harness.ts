/** Compile the small authored-workflow ABI into a durable Cloudflare entrypoint module. */
export function compileWorkflowEntrypoint(scriptSource: string): { className: string; source: string } {
  if (!/export\s+async\s+function\s+execute\s*\(\s*step\s*[:,]/.test(scriptSource))
    throw new Error("Workflow source must export async function execute(step, ctx)");
  if (/\b(?:WebSocket|threads?|sessions?|presence|channels?|delegate)\b/.test(scriptSource))
    throw new Error("Workflow source requests a conversational capability unavailable to subagents");
  const className = "CompiledWorkflow";
  const source = `${scriptSource}\n\nimport { WorkflowEntrypoint } from "cloudflare:workers";\n` +
    `export default class ${className} extends WorkflowEntrypoint {\n  async run(event, step) {\n` +
    `    return step.do("execute", { retries: { limit: 3, delay: 1000, backoff: "exponential" }, timeout: "10 minutes" }, async () => {\n` +
    `      const value = await execute(step, this.env.SUBAGENT_CONTEXT.create(event.payload));\n` +
    `      return JSON.parse(JSON.stringify(value ?? null));\n    });\n  }\n}\n`;
  return { className, source };
}
