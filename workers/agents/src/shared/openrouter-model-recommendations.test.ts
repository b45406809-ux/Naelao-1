import { describe, expect, it } from "vitest";
import { recommendOpenRouterModels } from "./openrouter-model-recommendations.js";
import type { OpenRouterModelCandidate } from "./openrouter-model-catalog.js";

const catalog: OpenRouterModelCandidate[] = [
  { id: "a", model: "openrouter/a", name: "Text large", inputModalities: ["text"], outputModalities: ["text"], contextLength: 128000, promptPriceUsdPerToken: 0.00001, completionPriceUsdPerToken: 0.00002 },
  { id: "b", model: "openrouter/b", name: "Vision", inputModalities: ["text", "image"], outputModalities: ["text"], contextLength: 32000, promptPriceUsdPerToken: 0.000001, completionPriceUsdPerToken: 0.000002 },
  { id: "c", model: "openrouter/c", name: "Unknown", contextLength: 256000 },
  { id: "d", model: "openrouter/d", name: "Free tool worker", inputModalities: ["text"], outputModalities: ["text"], supportedParameters: ["tools"], contextLength: 1_000_000, promptPriceUsdPerToken: 0, completionPriceUsdPerToken: 0 },
  { id: "e", model: "openrouter/e", name: "Paid tool worker", inputModalities: ["text"], outputModalities: ["text"], supportedParameters: ["tools"], contextLength: 500_000, promptPriceUsdPerToken: 0.000001, completionPriceUsdPerToken: 0.000002 },
];

describe("OpenRouter catalog recommendations", () => {
  it("ranks only candidates with relevant published metadata", () => {
    const recommendations = recommendOpenRouterModels(catalog);
    expect(recommendations.find(row => row.category === "general_text")?.candidates.map(row => row.id)).toEqual(["d", "e", "a"]);
    expect(recommendations.find(row => row.category === "vision_input")?.candidates.map(row => row.id)).toEqual(["b"]);
    expect(recommendations.find(row => row.category === "long_context")?.candidates.map(row => row.id)).toEqual(["d", "e", "c"]);
    expect(recommendations.find(row => row.category === "lower_published_cost")?.candidates.map(row => row.id)).toEqual(["d", "e", "b"]);
    expect(recommendations.find(row => row.category === "tool_workers")?.candidates.map(row => row.id)).toEqual(["d", "e"]);
    expect(recommendations.find(row => row.category === "long_context_workers")?.candidates.map(row => row.id)).toEqual(["d", "e"]);
    expect(recommendations.find(row => row.category === "free_tool_workers")?.candidates.map(row => row.id)).toEqual(["d"]);
    expect(recommendations.every(row => row.evidence.length > 0)).toBe(true);
  });

  it("does not invent features, prices, or recommendations from missing metadata", () => {
    expect(recommendOpenRouterModels([{ id: "x", model: "openrouter/x", name: "Unknown" }])).toEqual([]);
  });
});
