export type CustomModelLifecycleStatus = "draft" | "consented" | "imported" | "evaluated" | "evaluation_failed" | "active" | "revoked" | "deleted";
export type CustomModelLifecycleAction = "attest_consent" | "import_adapter" | "record_evaluation" | "approve_activation" | "rollback" | "revoke" | "delete" | "submit_training";

export interface ConsentAttestation {
  provenance: string;
  purpose: string;
  lawfulBasis: "consent" | "contract" | "legitimate_interest" | "public_data" | "other";
  affirmativeConsent: boolean;
  crossSpaceData: boolean;
  secretsExcluded: boolean;
  protectedContentExcluded: boolean;
  deletionPlanConfirmed: boolean;
}

export interface AdapterEvaluation {
  baseModel: string;
  testSetVersion: string;
  sampleCount: number;
  score: number;
  threshold: number;
  baselineScore?: number;
}

export function validateConsentAttestation(value: Partial<ConsentAttestation>): string | null {
  if (typeof value.provenance !== "string" || value.provenance.trim().length < 8 || value.provenance.length > 1000) return "provenance_required";
  if (typeof value.purpose !== "string" || value.purpose.trim().length < 8 || value.purpose.length > 500) return "purpose_required";
  if (!["consent", "contract", "legitimate_interest", "public_data", "other"].includes(value.lawfulBasis ?? "")) return "lawful_basis_required";
  if (value.affirmativeConsent !== true) return "affirmative_consent_required";
  if (value.crossSpaceData !== false) return "cross_space_data_forbidden";
  if (value.secretsExcluded !== true) return "secrets_must_be_excluded";
  if (value.protectedContentExcluded !== true) return "protected_content_must_be_excluded";
  if (value.deletionPlanConfirmed !== true) return "deletion_plan_required";
  return null;
}

export function validateAdapterEvaluation(value: Partial<AdapterEvaluation>, expectedBaseModel: string): string | null {
  if (value.baseModel !== expectedBaseModel) return "adapter_base_model_mismatch";
  if (typeof value.testSetVersion !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(value.testSetVersion)) return "versioned_test_set_required";
  if (!Number.isSafeInteger(value.sampleCount) || (value.sampleCount ?? 0) < 1 || (value.sampleCount ?? 0) > 10_000) return "invalid_evaluation_sample_count";
  for (const score of [value.score, value.threshold, ...(value.baselineScore === undefined ? [] : [value.baselineScore])]) {
    if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) return "invalid_evaluation_score";
  }
  return null;
}

export function evaluationPasses(value: AdapterEvaluation): boolean {
  return value.score >= value.threshold && (value.baselineScore === undefined || value.score >= value.baselineScore);
}

export function transitionCustomModelLifecycle(
  current: CustomModelLifecycleStatus,
  action: CustomModelLifecycleAction,
  evaluationPassed = false,
): CustomModelLifecycleStatus | null {
  if (action === "submit_training") return null;
  if (action === "attest_consent" && current === "draft") return "consented";
  if (action === "import_adapter" && current === "consented") return "imported";
  if (action === "record_evaluation" && ["imported", "evaluation_failed"].includes(current)) return evaluationPassed ? "evaluated" : "evaluation_failed";
  if (action === "approve_activation" && current === "evaluated" && evaluationPassed) return "active";
  if (action === "rollback" && current === "active") return "evaluated";
  if (action === "revoke" && ["consented", "imported", "evaluated", "evaluation_failed", "active"].includes(current)) return "revoked";
  if (action === "delete" && current !== "deleted") return "deleted";
  return null;
}
