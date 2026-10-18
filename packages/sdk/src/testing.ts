import { parseExtensionPrimitive, serializeExtensionPrimitive, type ExtensionPrimitiveManifest } from "@naelao/agent-sdk";
import { compileWorkflowPlan, resolveWorkflowPlanReferences, type WorkflowPlan } from "./workflow.js";

export function createContractTestHarness() {
  return Object.freeze({
    parse: parseExtensionPrimitive,
    roundTrip(value: ExtensionPrimitiveManifest): ExtensionPrimitiveManifest { return parseExtensionPrimitive(JSON.parse(serializeExtensionPrimitive(value))); },
  });
}

export interface MockWorkflowTestInput {
  plan: WorkflowPlan;
  allowedCapabilities: readonly string[];
  /** Static responses keyed by plan step ID; no callbacks, imports, fetch, or provider client are accepted. */
  responses?: Readonly<Record<string, unknown>>;
}

/** Runs a workflow plan entirely in-process against static fixture values. This is a functional
 * composition check only: it never invokes Naelao, a provider, a worker, or a live project. */
export function runMockWorkflowPlan(input: MockWorkflowTestInput) {
  const compiled = compileWorkflowPlan(input.plan, input.allowedCapabilities);
  let requestBytes = 0;
  let maxRequestBytes = 0;
  const calls: Array<{ stepId: string; operation: string; args: Record<string, unknown> }> = [];
  const results: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const step of input.plan.steps) {
    const args = resolveWorkflowPlanReferences(step.args, results) as Record<string, unknown>;
    const bytes = new TextEncoder().encode(JSON.stringify({ operation: step.operation, args })).byteLength;
    requestBytes += bytes; maxRequestBytes = Math.max(maxRequestBytes, bytes);
    calls.push({ stepId: step.id, operation: step.operation, args });
    results[step.id] = input.responses && Object.hasOwn(input.responses, step.id)
      ? JSON.parse(JSON.stringify(input.responses[step.id])) as unknown
      : { simulated: true, operation: step.operation };
  }
  const responseBytes = new TextEncoder().encode(JSON.stringify(results)).byteLength;
  return Object.freeze({
    passed: true as const,
    result: results,
    calls,
    profile: Object.freeze({
      mode: "offline_mock" as const,
      operations: input.plan.steps.length,
      uniqueCapabilities: compiled.capabilities.length,
      requestBytes,
      responseBytes,
      maxRequestBytes,
      liveProviderCalls: 0 as const,
      liveWorkerRuns: 0 as const,
      creditsMeasured: false as const,
      estimatedCredits: null,
      costConfidence: "not_measured" as const,
    }),
  });
}
