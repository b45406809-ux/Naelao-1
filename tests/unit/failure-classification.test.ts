import { describe, it, expect } from "vitest";
import { classifyFailure, FAILURE_KINDS, isFailureKind } from "@naelao/events";

describe("classifyFailure", () => {
  it("recognises Workers AI's own out-of-allowance code as a quota that clears by itself", () => {
    // The literal shape seen live when this account's free neuron budget runs out.
    const c = classifyFailure("AiError: 4006: You have exceeded your daily neuron allocation");
    expect(c.kind).toBe("quota_exhausted");
    expect(c.clears_on_its_own).toBe(true);
    // Nothing for the agent to fix — telling it otherwise sends it rebuilding things that work.
    expect(c.agent_actionable).toBe(false);
  });

  it("keeps a Naelao spend cap separate from a provider quota", () => {
    // Both say "limit", and being told the wrong one is the expensive mistake: waiting for a
    // reset that will never come, or asking the owner for money when nothing is actually capped.
    const cap = classifyFailure("402 session_budget_ceiling: this session has spent its allowance");
    expect(cap.kind).toBe("budget_ceiling");
    expect(cap.clears_on_its_own).toBe(false);

    const quota = classifyFailure("out of credits for this account");
    expect(quota.kind).toBe("quota_exhausted");
    expect(quota.clears_on_its_own).toBe(true);
  });

  it("marks a context overflow as the agent's own to fix, and a rate limit as not", () => {
    const overflow = classifyFailure("prompt is too long: 210000 tokens exceeds the context window");
    expect(overflow.kind).toBe("context_overflow");
    expect(overflow.agent_actionable).toBe(true);
    expect(overflow.clears_on_its_own).toBe(false);

    const rate = classifyFailure("429 Too Many Requests");
    expect(rate.kind).toBe("rate_limited");
    expect(rate.clears_on_its_own).toBe(true);
    expect(rate.agent_actionable).toBe(false);
  });

  it("recognises both of the loop's own exhaustion messages verbatim", () => {
    // These exact strings are what runScriptLoop produces; a change to either should fail here
    // loudly rather than silently degrading every stalled run to 'unknown'. The second one was
    // found by running a real agent against production and reading what it actually recorded.
    for (const text of [
      "Ran 6 step(s) without reaching an answer (completed: project.create)",
      "no terminal action",
    ]) {
      const c = classifyFailure(text);
      expect(c.kind).toBe("step_exhaustion");
      expect(c.agent_actionable).toBe(true);
    }
  });

  it("classifies from an HTTP status when there is no useful text", () => {
    expect(classifyFailure("", 429).kind).toBe("rate_limited");
    expect(classifyFailure("", 402).kind).toBe("budget_ceiling");
  });

  it("never guesses quota for an unrecognised error, and leaves it worth investigating", () => {
    // The one wrong answer that costs real time is "just wait" for something that never clears.
    const c = classifyFailure("TypeError: cannot read property 'id' of undefined");
    expect(c.kind).not.toBe("quota_exhausted");
    expect(c.clears_on_its_own).toBe(false);
    expect(c.agent_actionable).toBe(true);
  });

  it("handles null/undefined/empty without throwing", () => {
    expect(classifyFailure(null).kind).toBe("unknown");
    expect(classifyFailure(undefined).kind).toBe("unknown");
    expect(classifyFailure("   ").kind).toBe("unknown");
  });

  it("round-trips its own kind names, so a stored classification re-reads correctly", () => {
    // The diagnostics rollup stores the kind and later re-classifies from it; if that didn't hold,
    // every drill-down would degrade to 'unknown'.
    for (const kind of FAILURE_KINDS) {
      expect(isFailureKind(kind)).toBe(true);
      if (kind !== "unknown" && kind !== "tool_error") {
        expect(classifyFailure(kind).kind).toBe(kind);
      }
    }
    expect(isFailureKind("not_a_kind")).toBe(false);
    expect(isFailureKind(42)).toBe(false);
  });

  it("identifies a failing script as a tool error rather than a platform problem", () => {
    const c = classifyFailure("commerce.checkout failed: upstream returned 500");
    expect(c.kind).toBe("tool_error");
    expect(c.agent_actionable).toBe(true);
  });
});
