import { describe, it, expect } from "vitest";
import { computeNextRun } from "../../packages/events/src/index.js";

// Phase 3 item 27/28 — the "next run" display for a Crons editing UI. Mirrors isCronDue's own
// minute-scan approach in the opposite direction (forward instead of back).

describe("computeNextRun", () => {
  it("finds the next daily-9am fire after a time earlier the same day", () => {
    const from = Date.UTC(2026, 0, 1, 8, 0, 0); // Jan 1 2026, 08:00 UTC
    const next = computeNextRun("0 9 * * *", from);
    expect(next).toBe(Date.UTC(2026, 0, 1, 9, 0, 0));
  });

  it("rolls over to the next day when the daily time has already passed today", () => {
    const from = Date.UTC(2026, 0, 1, 10, 0, 0); // Jan 1 2026, 10:00 UTC — 9am already passed
    const next = computeNextRun("0 9 * * *", from);
    expect(next).toBe(Date.UTC(2026, 0, 2, 9, 0, 0));
  });

  it("is strictly AFTER fromMs — passing the exact match minute reports the NEXT occurrence, not that one", () => {
    const exactMatch = Date.UTC(2026, 0, 1, 9, 0, 0);
    const next = computeNextRun("0 9 * * *", exactMatch);
    expect(next).toBe(Date.UTC(2026, 0, 2, 9, 0, 0));
  });

  it("finds an hourly job's next fire within the same hour", () => {
    const from = Date.UTC(2026, 0, 1, 8, 15, 0);
    const next = computeNextRun("0 * * * *", from);
    expect(next).toBe(Date.UTC(2026, 0, 1, 9, 0, 0));
  });

  it("respects a weekday-only expression, skipping the weekend", () => {
    // 2026-01-02 is a Friday. Mon-Fri = 1-5.
    const friday = Date.UTC(2026, 0, 2, 10, 0, 0);
    const next = computeNextRun("0 9 * * 1-5", friday);
    // Next weekday 9am after Friday 10am is Monday 2026-01-05.
    expect(next).toBe(Date.UTC(2026, 0, 5, 9, 0, 0));
  });

  it("returns null for a genuinely unsatisfiable expression within the lookahead bound", () => {
    // Day 31 of February can never exist — bound the lookahead tight so the test is fast.
    const next = computeNextRun("0 0 31 2 *", Date.UTC(2026, 0, 1), 60 * 24 * 60 * 60 * 1000);
    expect(next).toBeNull();
  });

  it("throws on a malformed cron expression, matching parseCronExpression's own contract", () => {
    expect(() => computeNextRun("not a cron", Date.now())).toThrow(/exactly 5 fields/);
  });
});
