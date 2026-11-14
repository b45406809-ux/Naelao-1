import { describe, expect, it } from "vitest";
import { createLatestRequestFence, parseTemplateExpectedUsageInput } from "./template-usage-estimate.js";

describe("template usage estimate inputs", () => {
  it("treats empty planning assumptions as no projection", () => {
    expect(parseTemplateExpectedUsageInput("", "  ")).toEqual({ valid: true, usage: null, message: null });
  });

  it("accepts bounded integer assumptions and rejects partial or invalid values", () => {
    expect(parseTemplateExpectedUsageInput("200", "8")).toEqual({ valid: true,
      usage: { conversations_per_month: 200, interactions_per_conversation: 8 }, message: null });
    expect(parseTemplateExpectedUsageInput("1", "1").valid).toBe(true);
    expect(parseTemplateExpectedUsageInput("1000000", "500").valid).toBe(true);
    for (const [conversations, interactions] of [["", "8"], ["0", "1"], ["1000001", "1"], ["1.5", "1"], ["1", "501"]]) {
      expect(parseTemplateExpectedUsageInput(conversations!, interactions!)).toMatchObject({ valid: false, usage: null });
    }
  });

  it("includes a selected model and bounded call multiplier in the planning request", () => {
    expect(parseTemplateExpectedUsageInput("200", "8", "@cf/model", "2", "150000")).toEqual({ valid: true,
      usage: { conversations_per_month: 200, interactions_per_conversation: 8, managed_model_id: "@cf/model",
        model_calls_per_interaction: 2, model_credits_budget_per_month: 150000 }, message: null });
    expect(parseTemplateExpectedUsageInput("", "", "@cf/model", "1")).toEqual({ valid: true, usage: null, message: null });
    expect(parseTemplateExpectedUsageInput("200", "8", "@cf/model", "11")).toMatchObject({ valid: false, usage: null });
    expect(parseTemplateExpectedUsageInput("200", "8", "@cf/model", "2", "0")).toMatchObject({ valid: false, usage: null });
    expect(parseTemplateExpectedUsageInput("200", "8", "", "1", "100")).toMatchObject({ valid: false, usage: null });
    expect(parseTemplateExpectedUsageInput("", "", "@cf/model", "1", "9007199254740992")).toMatchObject({ valid: false, usage: null });
  });

  it("prevents an older overlapping response from being treated as current", () => {
    const requests = createLatestRequestFence();
    const older = requests.issue();
    const newer = requests.issue();
    expect(requests.isCurrent(older)).toBe(false);
    expect(requests.isCurrent(newer)).toBe(true);
    requests.invalidate();
    expect(requests.isCurrent(newer)).toBe(false);
  });
});
