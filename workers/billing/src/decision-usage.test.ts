import { describe, expect, it } from "vitest";
import { validateDecisionUsageReceipt, type DecisionReservationForSettlement, type DecisionUsageReceipt } from "./decision-usage.js";

const prior: DecisionReservationForSettlement = { status: "uncertain", model_id: "cloudflare/clef-flash", max_tokens: 512, max_credits: 100, provider_generation_id: "gen-dec-a" };
const receipt: DecisionUsageReceipt = { generation_id: "gen-dec-a", model_id: "cloudflare/clef-flash", input_tokens: 400, output_tokens: 40, cost_usd: 0.005, evidence_source: "openrouter_generation_api" };

describe("decision usage receipt admission", () => {
  it("admits a matching generation receipt for an uncertain attempt", () => {
    expect(validateDecisionUsageReceipt(prior, receipt)).toEqual({ tokens: 440, costCredits: 50 });
  });
  it.each([
    ["wrong generation", { ...receipt, generation_id: "gen-dec-b" }],
    ["wrong model", { ...receipt, model_id: "other/model" }],
    ["response-only proof on an uncertain attempt", { ...receipt, evidence_source: "openrouter_response" as const }],
    ["malformed identifier", { ...receipt, generation_id: "../r1" }],
    ["negative tokens", { ...receipt, input_tokens: -1 }],
    ["token overrun", { ...receipt, input_tokens: 513 }],
    ["cost overrun", { ...receipt, cost_usd: 0.0101 }],
    ["unbounded cost", { ...receipt, cost_usd: Number.POSITIVE_INFINITY }],
  ])("rejects %s", (_name, value) => {
    expect(validateDecisionUsageReceipt(prior, value)).toBeNull();
  });
  it("allows settlement from a complete response receipt only while the attempt is held", () => {
    expect(validateDecisionUsageReceipt({ ...prior, status: "held" }, { ...receipt, evidence_source: "openrouter_response" })).toEqual({ tokens: 440, costCredits: 50 });
  });
});
