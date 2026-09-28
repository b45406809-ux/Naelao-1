import { describe, expect, it } from "vitest";
import { validateModelForSpacePolicy } from "./model-policy.js";
import { privateLoraInferenceInput } from "./script-engine/reasoner.js";

describe("vertical model policy", () => {
  const policy = { mode: "whitelist_only" as const, allowedModelIds: ["@cf/certified", "custom/acme"] };
  it("permits only exact certified identifiers, including explicitly certified custom models", () => {
    expect(validateModelForSpacePolicy("@cf/certified", policy).ok).toBe(true);
    expect(validateModelForSpacePolicy("custom/acme", policy).ok).toBe(true);
  });
  it("returns a compliance violation for every unlisted model", () => {
    expect(validateModelForSpacePolicy("custom/other", policy)).toMatchObject({ ok: false, error_code: "compliance_violation" });
  });
});

describe("private LoRA routing", () => {
  it("attaches the company adapter to the base-model Workers AI input", () => {
    expect(privateLoraInferenceInput([{ role: "user", content: "hello" }], [], "adapter/acme", 128))
      .toMatchObject({ lora: "adapter/acme", max_tokens: 128 });
  });
});
