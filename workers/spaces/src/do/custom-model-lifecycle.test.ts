import { describe, expect, it } from "vitest";
import { evaluationPasses, transitionCustomModelLifecycle, validateAdapterEvaluation, validateConsentAttestation } from "./custom-model-lifecycle.js";

const consent = {
  provenance: "Owner-curated licensed evaluation set",
  purpose: "Improve terminology for this Space's support replies",
  lawfulBasis: "consent" as const,
  affirmativeConsent: true,
  crossSpaceData: false,
  secretsExcluded: true,
  protectedContentExcluded: true,
  deletionPlanConfirmed: true,
};

describe("custom adapter lifecycle evidence", () => {
  it("requires affirmative lawful-basis, same-Space, exclusion, and deletion attestations", () => {
    expect(validateConsentAttestation(consent)).toBeNull();
    expect(validateConsentAttestation({ ...consent, affirmativeConsent: false })).toBe("affirmative_consent_required");
    expect(validateConsentAttestation({ ...consent, crossSpaceData: true })).toBe("cross_space_data_forbidden");
    expect(validateConsentAttestation({ ...consent, secretsExcluded: false })).toBe("secrets_must_be_excluded");
    expect(validateConsentAttestation({ ...consent, lawfulBasis: undefined })).toBe("lawful_basis_required");
    expect(validateConsentAttestation({ ...consent, deletionPlanConfirmed: false })).toBe("deletion_plan_required");
  });

  it("requires base-model-matched versioned evaluation and rejects regressions", () => {
    const evaluation = { baseModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", testSetVersion: "support-v3", sampleCount: 50, score: 0.92, threshold: 0.85, baselineScore: 0.88 };
    expect(validateAdapterEvaluation(evaluation, evaluation.baseModel)).toBeNull();
    expect(validateAdapterEvaluation({ ...evaluation, baseModel: "@cf/other" }, evaluation.baseModel)).toBe("adapter_base_model_mismatch");
    expect(validateAdapterEvaluation({ ...evaluation, score: 0.8 }, evaluation.baseModel)).toBeNull();
    expect(evaluationPasses({ ...evaluation, score: 0.8 })).toBe(false);
    expect(evaluationPasses(evaluation)).toBe(true);
    expect(validateAdapterEvaluation({ ...evaluation, testSetVersion: "" }, evaluation.baseModel)).toBe("versioned_test_set_required");
  });

  it("enforces consent, import, evaluation, approval, revocation, and deletion order", () => {
    expect(transitionCustomModelLifecycle("draft", "import_adapter")).toBeNull();
    expect(transitionCustomModelLifecycle("draft", "attest_consent")).toBe("consented");
    expect(transitionCustomModelLifecycle("consented", "import_adapter")).toBe("imported");
    expect(transitionCustomModelLifecycle("imported", "record_evaluation", false)).toBe("evaluation_failed");
    expect(transitionCustomModelLifecycle("evaluation_failed", "approve_activation", false)).toBeNull();
    expect(transitionCustomModelLifecycle("imported", "record_evaluation", true)).toBe("evaluated");
    expect(transitionCustomModelLifecycle("evaluated", "approve_activation", true)).toBe("active");
    expect(transitionCustomModelLifecycle("active", "revoke")).toBe("revoked");
    expect(transitionCustomModelLifecycle("active", "rollback")).toBe("evaluated");
    expect(transitionCustomModelLifecycle("revoked", "delete")).toBe("deleted");
    expect(transitionCustomModelLifecycle("consented", "submit_training")).toBeNull();
  });
});
