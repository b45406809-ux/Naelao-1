import {
  DEFAULT_WORKING_MODEL,
  isAllowedModel,
  resolveEscalationModel,
  type EffortLevel,
} from "@naelao/billing-core";
import { isCompatProviderModel } from "../shared/ai-client.js";

export type WorkerContextAffinity = "shared" | "isolated";
export interface WorkerModelResolution {
  model: string;
  downgraded: boolean;
  reason?: string;
}

/**
 * Pick a leaf model from runtime policy, never from a model id emitted in the planner's task DAG.
 * Shared-context work follows the planner's model when it is in the verified catalog; an
 * isolated bulk task starts on the platform's known working model. Effort remains the hard cost
 * ceiling. Private/local and BYOK runs keep their authorized route so an isolated task cannot
 * silently escape its residency or credential policy.
 */
export function resolveWorkerModel(input: {
  plannerModel: string;
  contextAffinity: WorkerContextAffinity;
  effort: EffortLevel;
  privateRoute?: boolean;
}): WorkerModelResolution {
  if (input.privateRoute || input.plannerModel.startsWith("local/") || input.plannerModel.startsWith("custom/")) {
    return { model: input.plannerModel, downgraded: false };
  }

  const preferred = input.contextAffinity === "shared" ? input.plannerModel : DEFAULT_WORKING_MODEL;
  if (isCompatProviderModel(preferred) && input.contextAffinity === "shared") {
    return { model: preferred, downgraded: false };
  }
  if (!isAllowedModel(preferred)) {
    return {
      model: DEFAULT_WORKING_MODEL,
      downgraded: true,
      reason: `Worker model '${preferred}' is not in the verified catalog; used '${DEFAULT_WORKING_MODEL}'.`,
    };
  }
  return resolveEscalationModel(preferred, input.effort, { preferModel: preferred });
}
