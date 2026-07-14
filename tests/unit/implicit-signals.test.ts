import { describe, it, expect } from "vitest";
import { detectImplicitSignals } from "@naelao/events";

// §A1 Harness Excellence Phase HX2: detectImplicitSignals is the pure, regex-based classifier
// behind the implicit-signal pipeline (NaelaoAgentDO posts each match to SpaceDO's new
// agent_signal_events table). Deliberately keyword/regex-based, not an LLM call — see the
// function's own header comment for why.

describe("detectImplicitSignals", () => {
  it("returns no signals for an ordinary, calm message", () => {
    expect(detectImplicitSignals("Please summarize the last quarter's revenue.")).toEqual([]);
  });

  it("returns no signals for an empty string", () => {
    expect(detectImplicitSignals("")).toEqual([]);
  });

  it("detects user_frustration from 'that's wrong'", () => {
    const signals = detectImplicitSignals("No, that's wrong, please redo it.");
    expect(signals).toEqual([{ signal_type: "user_frustration", detail: expect.stringContaining("that's wrong") }]);
  });

  it("detects user_frustration from 'still broken'", () => {
    const signals = detectImplicitSignals("This is still broken after your last fix.");
    expect(signals.some((s) => s.signal_type === "user_frustration")).toBe(true);
  });

  it("detects agent_forgot from 'I already told you'", () => {
    const signals = detectImplicitSignals("I already told you the deadline is Friday.");
    expect(signals).toEqual([{ signal_type: "agent_forgot", detail: expect.stringContaining("already told") }]);
  });

  it("detects agent_forgot from 'as I said before'", () => {
    const signals = detectImplicitSignals("As I said before, use the new template.");
    expect(signals.some((s) => s.signal_type === "agent_forgot")).toBe(true);
  });

  it("detects BOTH signal types in the same message without duplicating either", () => {
    const signals = detectImplicitSignals("That's wrong — I already told you the deadline.");
    const types = signals.map((s) => s.signal_type).sort();
    expect(types).toEqual(["agent_forgot", "user_frustration"]);
  });

  it("is case-insensitive", () => {
    const signals = detectImplicitSignals("THAT'S WRONG, please fix it.");
    expect(signals.some((s) => s.signal_type === "user_frustration")).toBe(true);
  });

  it("truncates an overly long match's detail to 200 chars", () => {
    const longText = "that's wrong " + "x".repeat(500);
    const signals = detectImplicitSignals(longText);
    const frustration = signals.find((s) => s.signal_type === "user_frustration");
    expect(frustration?.detail.length).toBeLessThanOrEqual(200);
  });

  it("does NOT detect regeneration/repeat-goal patterns (deliberately left to explicit signals)", () => {
    // "do it again" alone (without an accompanying frustration marker) should not false-positive.
    const signals = detectImplicitSignals("Can you run the report again for March?");
    expect(signals).toEqual([]);
  });
});
