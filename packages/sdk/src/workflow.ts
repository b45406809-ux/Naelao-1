/** Small declarative workflow plan for visual editors. Plans only name host-issued capabilities;
 * generated code invokes them through the durable workflow context and cannot introduce imports,
 * arbitrary JavaScript, credentials, or new capabilities. */
export interface WorkflowPlanStep {
  id: string;
  operation: string;
  args: Record<string, unknown>;
}

export interface WorkflowPlan {
  schemaVersion: "1.0";
  steps: readonly WorkflowPlanStep[];
}

export interface CompiledWorkflowPlan {
  source: string;
  stepIds: string[];
  capabilities: string[];
  sourceBytes: number;
}

const STEP_ID = /^[a-z][a-z0-9_-]{0,47}$/;
const CAPABILITY = /^[a-z][a-z0-9_.:-]{0,95}$/;

function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("workflow_plan_arguments_must_be_json");
  const parsed: unknown = JSON.parse(serialized);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("workflow_plan_arguments_must_be_object");
  return JSON.stringify(parsed);
}

export function compileWorkflowPlan(plan: WorkflowPlan, allowedCapabilities: readonly string[]): CompiledWorkflowPlan {
  if (!plan || plan.schemaVersion !== "1.0" || !Array.isArray(plan.steps) || plan.steps.length < 1 || plan.steps.length > 64) {
    throw new Error("workflow_plan_invalid");
  }
  const allowed = new Set(allowedCapabilities);
  const ids = new Set<string>();
  const steps = plan.steps.map(step => {
    if (!step || typeof step !== "object" || !STEP_ID.test(step.id) || ids.has(step.id)
      || typeof step.operation !== "string" || !CAPABILITY.test(step.operation) || !allowed.has(step.operation)) {
      throw new Error("workflow_plan_step_invalid_or_ungranted");
    }
    ids.add(step.id);
    return { id: step.id, operation: step.operation, args: JSON.parse(canonicalJson(step.args)) as Record<string, unknown> };
  });
  const serialized = JSON.stringify(steps);
  const source = `export async function execute(step, ctx) {\n` +
    `  const plan = ${serialized};\n` +
    `  const results = Object.create(null);\n` +
    `  for (const item of plan) {\n` +
    `    results[item.id] = await step.do("plan:" + item.id, () => ctx.tools.call(item.id, item.operation, item.args));\n` +
    `  }\n` +
    `  return results;\n` +
    `}\n`;
  const sourceBytes = new TextEncoder().encode(source).byteLength;
  if (sourceBytes > 65_536) throw new Error("workflow_plan_source_too_large");
  return Object.freeze({ source, stepIds: steps.map(item => item.id), capabilities: [...new Set(steps.map(item => item.operation))], sourceBytes });
}
