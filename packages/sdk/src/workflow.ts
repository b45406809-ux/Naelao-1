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

function validateReferences(value: unknown, priorStepIds: ReadonlySet<string>, depth = 0): void {
  if (depth > 32) throw new Error("workflow_plan_arguments_too_deep");
  if (Array.isArray(value)) { for (const child of value) validateReferences(child, priorStepIds, depth + 1); return; }
  if (!value || typeof value !== "object") return;
  const object = value as Record<string, unknown>;
  if (Object.hasOwn(object, "$workflowRef")) {
    const keys = Object.keys(object);
    const ref = object.$workflowRef;
    if (keys.length !== 1 || typeof ref !== "string") throw new Error("workflow_plan_reference_invalid");
    const parts = ref.split("#");
    const stepId = parts[0] ?? "";
    const pointer = parts[1];
    if (parts.length > 2 || !priorStepIds.has(stepId) || (pointer !== undefined && pointer !== "" && (!pointer.startsWith("/") || /~(?![01])/.test(pointer)))) {
      throw new Error("workflow_plan_reference_invalid");
    }
    return;
  }
  for (const child of Object.values(object)) validateReferences(child, priorStepIds, depth + 1);
}

/** Resolve the data-only `{$workflowRef:"step-id#/json/pointer"}` form against completed steps. */
export function resolveWorkflowPlanReferences(value: unknown, priorResults: Readonly<Record<string, unknown>>): unknown {
  if (Array.isArray(value)) return value.map(child => resolveWorkflowPlanReferences(child, priorResults));
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  if (Object.hasOwn(object, "$workflowRef")) {
    if (Object.keys(object).length !== 1 || typeof object.$workflowRef !== "string") throw new Error("workflow_plan_reference_invalid");
    const [stepId, pointer] = object.$workflowRef.split("#");
    if (!Object.hasOwn(priorResults, stepId ?? "")) throw new Error("workflow_plan_reference_result_missing");
    let current: unknown = priorResults[stepId ?? ""];
    if (current === undefined) throw new Error("workflow_plan_reference_result_missing");
    if (pointer) for (const encoded of pointer.slice(1).split("/")) {
      const key = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
      if (!current || typeof current !== "object" || !Object.hasOwn(current, key)) throw new Error("workflow_plan_reference_path_missing");
      current = (current as Record<string, unknown>)[key];
    }
    if (current === undefined) throw new Error("workflow_plan_reference_path_missing");
    return current;
  }
  return Object.fromEntries(Object.entries(object).map(([key, child]) => [key, resolveWorkflowPlanReferences(child, priorResults)]));
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
    const args = JSON.parse(canonicalJson(step.args)) as Record<string, unknown>;
    validateReferences(args, ids);
    ids.add(step.id);
    return { id: step.id, operation: step.operation, args };
  });
  const serialized = JSON.stringify(steps);
  const source = `export async function execute(step, ctx) {\n` +
    `  const plan = ${serialized};\n` +
    `  const results = Object.create(null);\n` +
    `  const resolve = value => {\n` +
    `    if (Array.isArray(value)) return value.map(resolve);\n` +
    `    if (!value || typeof value !== "object") return value;\n` +
    `    if (Object.keys(value).length === 1 && typeof value.$workflowRef === "string") {\n` +
    `      const [stepId, pointer] = value.$workflowRef.split("#"); if (!Object.hasOwn(results, stepId)) throw new Error("workflow_plan_reference_result_missing"); let current = results[stepId];\n` +
    `      if (current === undefined) throw new Error("workflow_plan_reference_result_missing");\n` +
    `      if (pointer) for (const encoded of pointer.slice(1).split("/")) { const key = encoded.replace(/~1/g, "/").replace(/~0/g, "~"); if (!current || typeof current !== "object" || !Object.hasOwn(current, key)) throw new Error("workflow_plan_reference_path_missing"); current = current[key]; }\n` +
    `      if (current === undefined) throw new Error("workflow_plan_reference_path_missing"); return current;\n` +
    `    }\n` +
    `    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolve(child)]));\n` +
    `  };\n` +
    `  for (const item of plan) {\n` +
    `    results[item.id] = await step.do("plan:" + item.id, () => ctx.tools.call(item.id, item.operation, resolve(item.args)));\n` +
    `  }\n` +
    `  return results;\n` +
    `}\n`;
  const sourceBytes = new TextEncoder().encode(source).byteLength;
  if (sourceBytes > 65_536) throw new Error("workflow_plan_source_too_large");
  return Object.freeze({ source, stepIds: steps.map(item => item.id), capabilities: [...new Set(steps.map(item => item.operation))], sourceBytes });
}
