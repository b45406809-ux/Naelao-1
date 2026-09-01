import { describe, it, expect } from "vitest";
import {
  validateModelForSpacePolicy,
  type VerticalModelPolicy,
  ALLOWED_MODELS,
} from "../../packages/billing-core/src/models.js";
import {
  HOSPITAL_COWORK_BLUEPRINT,
  LEGAL_COWORK_BLUEPRINT,
  FINANCE_COWORK_BLUEPRINT,
  ARCHITECTURE_COWORK_BLUEPRINT,
  getTemplateModelPolicy,
} from "../../workers/agents/src/launchpad/spacetype.js";

describe("Vertical-Scoped Model Curation & Enforcement", () => {
  describe("validateModelForSpacePolicy", () => {
    const hospitalPolicy: VerticalModelPolicy = {
      mode: "whitelist_only",
      pickerHeaderLabel: "🏥 HIPAA & Clinically Vetted Models",
      defaultModelId: "custom/hospital-clinical-llama8b-v1",
      lockedByCompliancePolicy: true,
      allowedModelIds: [
        "custom/hospital-clinical-llama8b-v1",
        "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        "claude-sonnet-4-6",
        "google-ai-studio/gemini-3.7-flash",
      ],
    };

    const legalPolicy: VerticalModelPolicy = {
      mode: "whitelist_only",
      pickerHeaderLabel: "⚖️ Delaware & Legal High-Reasoning Certified Models",
      defaultModelId: "custom/acme-legal-redline",
      lockedByCompliancePolicy: true,
      allowedModelIds: [
        "custom/acme-legal-redline",
        "custom/lexpulse-delaware-legal-v2",
        "claude-sonnet-4-6",
        "@cf/openai/gpt-oss-120b",
        "google-ai-studio/gemini-3.7-flash",
      ],
    };

    it("allows authorized models in a whitelist-only vertical policy", () => {
      const res1 = validateModelForSpacePolicy("custom/hospital-clinical-llama8b-v1", hospitalPolicy);
      expect(res1.valid).toBe(true);

      const res2 = validateModelForSpacePolicy("@cf/meta/llama-3.3-70b-instruct-fp8-fast", hospitalPolicy);
      expect(res2.valid).toBe(true);

      const res3 = validateModelForSpacePolicy("claude-sonnet-4-6", hospitalPolicy);
      expect(res3.valid).toBe(true);
    });

    it("blocks non-certified models with compliance violation message", () => {
      const res = validateModelForSpacePolicy("@cf/openai/gpt-oss-20b", hospitalPolicy);
      expect(res.valid).toBe(false);
      expect(res.reason).toContain("Compliance Violation");
      expect(res.reason).toContain("not certified for this vertical space");
      expect(res.reason).toContain("custom/hospital-clinical-llama8b-v1");
    });

    it("enforces legal vertical policy accurately", () => {
      const ok = validateModelForSpacePolicy("@cf/openai/gpt-oss-120b", legalPolicy);
      expect(ok.valid).toBe(true);

      const blocked = validateModelForSpacePolicy("@cf/ibm-granite/granite-4.0-h-micro", legalPolicy);
      expect(blocked.valid).toBe(false);
      expect(blocked.reason).toContain("Compliance Violation");
    });

    it("allows all allowed models when mode is 'all_allowed' or undefined", () => {
      const res1 = validateModelForSpacePolicy("@cf/ibm-granite/granite-4.0-h-micro", {
        mode: "all_allowed",
        allowedModelIds: [],
        defaultModelId: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        lockedByCompliancePolicy: false,
      });
      expect(res1.valid).toBe(true);

      const res2 = validateModelForSpacePolicy("@cf/meta/llama-3.3-70b-instruct-fp8-fast", null);
      expect(res2.valid).toBe(true);
    });

    it("rejects unknown platform models even when space policy is unrestricted", () => {
      const res = validateModelForSpacePolicy("unvetted-rogue-model-9000", null);
      expect(res.valid).toBe(false);
    });
  });

  describe("Declarative Blueprints & getTemplateModelPolicy", () => {
    it("Hospital blueprint declares strict whitelist model policy", () => {
      expect(HOSPITAL_COWORK_BLUEPRINT).toBeDefined();
      expect(HOSPITAL_COWORK_BLUEPRINT.model_policy).toBeDefined();
      expect(HOSPITAL_COWORK_BLUEPRINT.model_policy?.mode).toBe("whitelist_only");
      expect(HOSPITAL_COWORK_BLUEPRINT.model_policy?.lockedByCompliancePolicy).toBe(true);
      expect(HOSPITAL_COWORK_BLUEPRINT.model_policy?.defaultModelId).toBe("custom/hospital-clinical-llama8b-v1");
      expect(HOSPITAL_COWORK_BLUEPRINT.model_policy?.allowedModelIds).toContain("custom/hospital-clinical-llama8b-v1");
      expect(HOSPITAL_COWORK_BLUEPRINT.model_policy?.allowedModelIds).toContain("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    });

    it("Legal blueprint declares high-reasoning legal model policy", () => {
      expect(LEGAL_COWORK_BLUEPRINT).toBeDefined();
      expect(LEGAL_COWORK_BLUEPRINT.model_policy?.mode).toBe("whitelist_only");
      expect(LEGAL_COWORK_BLUEPRINT.model_policy?.allowedModelIds).toContain("custom/lexpulse-delaware-legal-v2");
      expect(LEGAL_COWORK_BLUEPRINT.model_policy?.allowedModelIds).toContain("@cf/openai/gpt-oss-120b");
    });

    it("Finance blueprint declares quantitative vetted model policy", () => {
      expect(FINANCE_COWORK_BLUEPRINT).toBeDefined();
      expect(FINANCE_COWORK_BLUEPRINT.model_policy?.mode).toBe("whitelist_only");
      expect(FINANCE_COWORK_BLUEPRINT.model_policy?.allowedModelIds).toContain("@cf/openai/gpt-oss-120b");
      expect(FINANCE_COWORK_BLUEPRINT.model_policy?.allowedModelIds).toContain("@cf/nvidia/nemotron-3-120b-a12b");
    });

    it("Architecture blueprint declares engineering certified model policy", () => {
      expect(ARCHITECTURE_COWORK_BLUEPRINT).toBeDefined();
      expect(ARCHITECTURE_COWORK_BLUEPRINT.model_policy?.mode).toBe("whitelist_only");
      expect(ARCHITECTURE_COWORK_BLUEPRINT.model_policy?.allowedModelIds).toContain("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    });

    it("getTemplateModelPolicy resolves policies correctly from template IDs", () => {
      const policy = getTemplateModelPolicy("clinica-ehr-cowork");
      expect(policy).toBeDefined();
      expect(policy?.mode).toBe("whitelist_only");
      expect(policy?.pickerHeaderLabel).toContain("HIPAA");

      const legal = getTemplateModelPolicy("lexpulse-legal-cowork");
      expect(legal).toBeDefined();
      expect(legal?.pickerHeaderLabel).toContain("Legal");

      const unknown = getTemplateModelPolicy("non-existent-template");
      expect(unknown).toBeUndefined();
    });
  });
});
