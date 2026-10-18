import { describe, expect, it } from "vitest";
import { consumerLlmUsageEvent, projectLlmUsageEvent } from "./project-llm-usage";

describe("projectLlmUsageEvent", () => {
  it("attributes planner inference to its project, model, rate card, and prepaid payer", () => {
    expect(projectLlmUsageEvent({
      spaceId: "space-1", projectId: "project-1", runId: "run-1",
      modelId: "openai/gpt-4.1-mini", tokens: 137, costCredits: 3,
      rateCardVersion: "catalog-2026-10-18", payer: "space_wallet",
    })).toEqual({
      event_type: "project_llm_tokens", quantity: 137, unit: "tokens", schema_version: 2,
      idempotency_key: "run:run-1:project-llm", space_id: "space-1", project_id: "project-1",
      run_id: "run-1", provider: "openai", model_id: "openai/gpt-4.1-mini", cost_credits: 3,
      rate_card_version: "catalog-2026-10-18", payer_kind: "space_wallet", decision: "allowed",
    });
  });

  it("preserves provider identity for first-party model families", () => {
    expect(projectLlmUsageEvent({
      spaceId: "s", projectId: "p", runId: "r", modelId: "@cf/meta/llama", tokens: 1,
      costCredits: 0, rateCardVersion: "core-model-rates-v1", payer: "unknown",
    }).provider).toBe("cloudflare");
  });

  it("marks personal assistant inference as consumer-prepaid usage", () => {
    expect(consumerLlmUsageEvent({
      spaceId: "s", runId: "r", modelId: "claude-sonnet-4-6", tokens: 20,
      costCredits: 1, rateCardVersion: "core-model-rates-v1",
    })).toMatchObject({
      event_type: "llm_tokens", idempotency_key: "run:r:consumer-llm",
      payer_kind: "consumer_credits", provider: "anthropic", cost_credits: 1,
    });
  });
});
