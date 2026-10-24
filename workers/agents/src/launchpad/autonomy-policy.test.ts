import { describe, expect, it } from "vitest";
import { applyOnboardingAutonomyPolicy, onboardingAutonomyPolicy } from "./autonomy-policy.js";
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

  it("keeps domain-specific onboarding templates out of the kernel", () => {
    // FDE Space Templates own onboarding prompts. The kernel only compiles a selected answer.
    expect(LAUNCHPAD_TEMPLATES).toEqual([]);
  });

  it("writes the compiled policy with the internal request headers and fails closed", async () => {
    let captured: Request | undefined;
    const applied = await applyOnboardingAutonomyPolicy({
      options,
      answer: options[0],
      policyUrl: "http://spaces-worker/spaces/space-1/assistant-policy",
      headers: { "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": "signed" },
      fetch: async (request) => { captured = request; return Response.json({ ok: true }); },
    });
    expect(applied).toEqual({ configured: true, applied: true });
    expect(captured?.method).toBe("PATCH");
    expect(captured?.headers.get("x-naelao-internal-token")).toBe("signed");
    expect(await captured?.json()).toEqual({ approval_mode: "always_ask", auto_approved_actions: [] });

    const unavailable = await applyOnboardingAutonomyPolicy({
      options,
      answer: options[2],
      policyUrl: "http://spaces-worker/spaces/space-1/assistant-policy",
      headers: {},
      fetch: async () => new Response("unavailable", { status: 503 }),
    });
    expect(unavailable).toEqual({ configured: true, applied: false });

    const noChoice = await applyOnboardingAutonomyPolicy({
      options,
      answer: undefined,
      policyUrl: "http://spaces-worker/spaces/space-1/assistant-policy",
      headers: {},
      fetch: async () => { throw new Error("must not fetch"); },
    });
    expect(noChoice).toEqual({ configured: false, applied: true });
  });
});
