import { describe, expect, it } from "vitest";
import { availableTextModels, parseModelList, rankModels, retryDelayMs } from "../../../repomix/lib/gemini-models.mjs";

describe("Gemini 3.x runner model rotation", () => {
  it("accepts only unique text-oriented Gemini 3.x model IDs", () => {
    expect(parseModelList("models/gemini-3.6-flash,gemini-2.5-flash,gemini-3.6-flash,gemini-3.1-flash-live-preview")).toEqual(["gemini-3.6-flash"]);
  });

  it("filters the live catalog to generateContent-capable Gemini 3.x text models", () => {
    expect(availableTextModels({ models: [
      { name: "models/gemini-3.8-flash", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-3.8-live", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-3.7-flash", supportedGenerationMethods: ["countTokens"] },
      { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
    ] })).toEqual(["gemini-3.8-flash"]);
  });

  it("ranks Pro before full Flash before Flash Lite and retains discovered fallbacks", () => {
    expect(rankModels(["gemini-3.6-flash", "gemini-3.1-flash-lite"], ["gemini-3.1-pro-preview", "gemini-3.8-flash"])).toEqual([
      "gemini-3.1-pro-preview", "gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.1-flash-lite",
    ]);
  });

  it("backs off transient failures but rotates immediately for retired models", () => {
    expect(retryDelayMs(429, "2", 0)).toBe(2_000);
    expect(retryDelayMs(503, null, 2)).toBe(4_000);
    expect(retryDelayMs(404, null, 2)).toBe(0);
  });
});
