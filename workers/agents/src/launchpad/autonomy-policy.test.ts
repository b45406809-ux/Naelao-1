import { describe, expect, it } from "vitest";
import { onboardingAutonomyPolicy } from "./autonomy-policy.js";
import { LAUNCHPAD_TEMPLATES } from "./spacetype.js";

const options = ["Ask me first", "Handle routine work", "Run within configured limits"];

describe("onboardingAutonomyPolicy", () => {
  it("makes ask-first explicit by clearing the automatic action allowlist", () => {
    expect(onboardingAutonomyPolicy(options, options[0])).toEqual({
      approval_mode: "always_ask",
      auto_approved_actions: [],
    });
  });

  it("uses the provisioned safe routine allowlist for the middle choice", () => {
    expect(onboardingAutonomyPolicy(options, options[1])).toEqual({ approval_mode: "always_ask" });
  });

  it("selects autonomous mode only for the final explicit choice", () => {
    expect(onboardingAutonomyPolicy(options, options[2])).toEqual({ approval_mode: "yolo" });
  });

  it("does not infer policy from unknown, legacy, or malformed answers", () => {
    expect(onboardingAutonomyPolicy(options, "some other answer")).toBeNull();
    expect(onboardingAutonomyPolicy(options, undefined)).toBeNull();
    expect(onboardingAutonomyPolicy(options.slice(0, 2), options[0])).toBeNull();
  });

  it("keeps every current template's autonomy choices compatible with the policy compiler", () => {
    const autonomyPrompts = LAUNCHPAD_TEMPLATES.flatMap((template) =>
      (template.bootstrap?.prompts ?? []).filter((prompt) => prompt.id === "autonomy")
    );
    expect(autonomyPrompts.length).toBeGreaterThan(0);
    for (const prompt of autonomyPrompts) {
      expect(prompt.options, `${prompt.id} in ${prompt.question}`).toHaveLength(3);
      for (const option of prompt.options ?? []) {
        expect(onboardingAutonomyPolicy(prompt.options, option)).not.toBeNull();
      }
    }
  });
});
