import { describe, expect, it } from "vitest";
import { airGappedOnlyFromConfig, validateModelForSpacePolicy } from "./model-policy.js";
import { privateLoraGatewayBody, privateLoraInferenceInput } from "./script-engine/reasoner.js";

describe("vertical model policy", () => {
  const policy = { mode: "whitelist_only" as const, allowedModelIds: ["@cf/certified", "custom/acme"] };
  it("permits only exact certified identifiers, including explicitly certified custom models", () => {
    expect(validateModelForSpacePolicy("@cf/certified", policy).ok).toBe(true);
    expect(validateModelForSpacePolicy("custom/acme", policy).ok).toBe(true);
  });
  it("returns a compliance violation for every unlisted model", () => {
    expect(validateModelForSpacePolicy("custom/other", policy)).toMatchObject({ ok: false, error_code: "compliance_violation" });
  });
  it("leaves open and absent policies permissive while an empty whitelist fails closed", () => {
    expect(validateModelForSpacePolicy("@cf/any", { mode: "open", allowedModelIds: [] }).ok).toBe(true);
    expect(validateModelForSpacePolicy("@cf/any", undefined).ok).toBe(true);
    expect(validateModelForSpacePolicy("@cf/any", { mode: "whitelist_only", allowedModelIds: [] }))
      .toMatchObject({ ok: false, error_code: "compliance_violation" });
  });
});

describe("air-gap policy", () => {
  it("recognizes root and product compliance configuration", () => {
    expect(airGappedOnlyFromConfig(JSON.stringify({ compliance: { airGappedOnly: true } }))).toBe(true);
    expect(airGappedOnlyFromConfig(JSON.stringify({ productConfig: { compliance: { airGappedOnly: true } } }))).toBe(true);
  });
  it("fails closed on malformed configuration while treating absent configuration as ordinary", () => {
    expect(airGappedOnlyFromConfig("not-json")).toBe(true);
    expect(airGappedOnlyFromConfig(null)).toBe(false);
  });
});

describe("private LoRA routing", () => {
  it("attaches the company adapter to the base-model Workers AI input", () => {
    expect(privateLoraInferenceInput([{ role: "user", content: "hello" }], [], "adapter/acme", 128))
      .toMatchObject({ lora: "adapter/acme", max_tokens: 128 });
  });

  it("builds the gateway payload with the base @cf model and private adapter", () => {
    const body = JSON.parse(privateLoraGatewayBody({
      baseModel: "@cf/meta/llama-3.2-3b-instruct",
      system: "system",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      loraAdapterId: "adapter/acme",
      maxTokens: 128,
      toolChoice: "auto",
    }));
    expect(body).toMatchObject({
      model: "@cf/meta/llama-3.2-3b-instruct",
      lora: "adapter/acme",
      messages: [{ role: "system", content: "system" }, { role: "user", content: "hello" }],
    });
  });
});
