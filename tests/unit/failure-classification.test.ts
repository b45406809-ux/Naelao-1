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

  it("recognises the loop's own cancellation marker as a deliberate stop, not a failure to fix or wait out", () => {
    // This is the exact string script-engine/loop.ts's shouldCancel branch writes as result.error
    // — a change to it here without updating that string (or vice versa) would silently regress
    // the Stop button back to showing the wrong offer (auto-retry, or nothing at all).
    const c = classifyFailure("Stopped by you before finishing.");
    expect(c.kind).toBe("user_cancelled");
    // Neither "wait, it'll clear itself" (it won't — nobody is retrying a deliberate stop) nor
    // "the agent can fix this itself" (it can't — only the person decides whether to continue).
    expect(c.clears_on_its_own).toBe(false);
    expect(c.agent_actionable).toBe(false);
  });
});

/**
 * A model's own give_up reason is a description of a situation, not evidence of one.
 *
 * Observed live and this is the exact loop it produced: a Space Assistant running on Gemini —
 * a provider with plenty of capacity — read a wake-up brief mentioning the previous day's
 * Workers AI outage, gave up with "The daily free neuron allocation is exhausted...", and that
 * give_up was classified `quota_exhausted` ("clears on its own — do not retry"). The next
 * wake-up's brief relayed that back as its present state, so it gave up again. One real outage
 * froze the business permanently, on infrastructure that had never run out of anything.
 */
describe("classifyFailure — a model's own words are never infrastructure evidence", () => {
  const LIVE_GIVE_UP =
    "The daily free neuron allocation (quota_exhausted) is exhausted, preventing further " +
    "reasoning/execution until the quota resets, and setup is still unfinished.";

  it("does NOT call the live give_up text a self-clearing quota failure", () => {
    const c = classifyFailure(LIVE_GIVE_UP, undefined, "model");
    expect(c.kind).not.toBe("quota_exhausted");
    expect(c.clears_on_its_own).toBe(false);
    expect(c.agent_actionable).toBe(true);
  });

  it("still classifies the SAME text as a quota failure when infrastructure said it", () => {
    // The real gateway error must keep working exactly as before — this fix narrows what counts
    // as evidence, it does not stop recognising a genuine outage.
    expect(classifyFailure(LIVE_GIVE_UP).kind).toBe("quota_exhausted");
    expect(classifyFailure(LIVE_GIVE_UP, undefined, "infrastructure").kind).toBe("quota_exhausted");
  });

  it("keeps honouring structural facts the loop stamps, even on a model-origin failure", () => {
    // "the user pressed Stop" is a fact about the run, not the model's read on the world.
    expect(classifyFailure("Stopped by you before finishing.", undefined, "model").kind)
      .toBe("user_cancelled");
  });

  it("round-trips a stored kind name regardless of origin", () => {
    expect(classifyFailure("budget_ceiling", undefined, "model").kind).toBe("budget_ceiling");
  });
});

/**
 * The counterpart, and the reason this pair exists at all: the reasoner reports its OWN failures
 * — a gateway 429, an unparseable reply, a dead stream — through the same `give_up` channel the
 * model uses. Marking every give_up as model-origin swallowed a real Gemini 429 into `unknown`,
 * caught live one run after the fix that introduced it. Absent origin therefore means
 * infrastructure, so any path not explicitly marked keeps classifying exactly as it always has.
 */
describe("classifyFailure — a real gateway failure keeps its classification", () => {
  const LIVE_GEMINI_429 =
    'reasoner gateway error 429: [{ "error": { "code": 429, "message": "You exceeded your ' +
    'current quota, please check your plan and billing details." } }]';

  it("classifies the live Gemini 429 as self-clearing, not unknown", () => {
    const c = classifyFailure(LIVE_GEMINI_429);
    expect(c.kind).toBe("rate_limited");
    expect(c.clears_on_its_own).toBe(true);
  });

  it("classifies it the same way with an explicit infrastructure origin", () => {
    expect(classifyFailure(LIVE_GEMINI_429, undefined, "infrastructure").kind).toBe("rate_limited");
  });
});

/**
 * An overloaded provider is a wait, not a misconfiguration. Live: Gemini's 503 "This model is
 * currently experiencing high demand" classified as `unknown`, and `unknown` is agent_actionable,
 * which sends the shell's self-heal loop into an immediate retry — the one response that makes an
 * overloaded provider worse.
 */
describe("classifyFailure — an overloaded provider is self-clearing, not a bad model", () => {
  const LIVE_503 =
    'reasoner gateway error 503: [{ "error": { "code": 503, "message": "This model is currently ' +
    'experiencing high demand. Spikes in demand are usually short-lived." } }]';

  it("treats the live 503 as self-clearing so the client backs off instead of hammering", () => {
    const c = classifyFailure(LIVE_503);
    expect(c.kind).toBe("rate_limited");
    expect(c.clears_on_its_own).toBe(true);
  });

  it("still calls a genuinely missing model unavailable, which does NOT clear on its own", () => {
    const c = classifyFailure("reasoner gateway error 404: Model not found: claude-sonnet-4-6");
    expect(c.kind).toBe("model_unavailable");
    expect(c.clears_on_its_own).toBe(false);
  });
});
