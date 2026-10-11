import type { SpaceModelPolicy } from "@naelao/agent-sdk";
export { airGappedOnlyFromConfig } from "@naelao/security";

export interface ModelPolicyValidation {
  ok: boolean;
  error_code?: "compliance_violation";
  message?: string;
}

/** Final server-side model gate. It deliberately compares the full identifier verbatim. */
export function validateModelForSpacePolicy(requestedModel: string, policy?: SpaceModelPolicy | null): ModelPolicyValidation {
  if (!policy || policy.mode !== "whitelist_only") return { ok: true };
  const allowed = new Set((policy.allowedModelIds ?? []).filter((id: string) => typeof id === "string" && id.length > 0));
  if (allowed.has(requestedModel)) return { ok: true };
  return { ok: false, error_code: "compliance_violation", message: `Model '${requestedModel}' is not certified for this space` };
}
