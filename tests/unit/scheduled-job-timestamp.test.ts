/**
 * The bug that made every newly-seeded proactive cron dead on arrival.
 *
 * `enqueueAgentTicks` computed a never-run job's anchor as Date.parse(`${created_at}Z`) — but D1
 * returns that column as a full ISO string that ALREADY ends in Z, so the result was "…671ZZ" and
 * Date.parse gave NaN. isCronDue then did Math.max(NaN, …), its scan loop never executed, and it
 * returned false. The job could not fire, so last_run_at stayed null, so it could never become
 * due: a permanent, silent no-op indistinguishable from "not scheduled yet".
 */

import { describe, it, expect } from "vitest";
import { parseTimestampMs } from "../../workers/agents/src/index.js";

describe("parseTimestampMs", () => {
  it("parses the ISO-with-Z form D1 actually returns, without corrupting it", () => {
    // The exact shape read off the live scheduled_jobs table.
    expect(parseTimestampMs("2026-08-08T11:20:40.671Z")).toBe(Date.parse("2026-08-08T11:20:40.671Z"));
  });

  it("parses SQLite's bare 'YYYY-MM-DD HH:MM:SS' as UTC, not local time", () => {
    // Other tables use this form. Without a zone marker it would be read as local time, which is
    // a silent hours-sized error on any non-UTC runtime.
    expect(parseTimestampMs("2026-08-08 11:20:40")).toBe(Date.parse("2026-08-08T11:20:40Z"));
  });

  it("handles an explicit offset", () => {
    expect(parseTimestampMs("2026-08-08T13:20:40+02:00")).toBe(Date.parse("2026-08-08T11:20:40Z"));
  });

  it("passes a numeric epoch through", () => {
    expect(parseTimestampMs(1786188040671)).toBe(1786188040671);
  });

  it("returns undefined — never NaN — for anything unparseable", () => {
    // NaN is what caused the outage: it propagates silently through Math.max and comparisons.
    // undefined forces the caller to decide what a missing timestamp means.
    for (const bad of ["", "not a date", null, undefined, Number.NaN]) {
      expect(parseTimestampMs(bad as never)).toBeUndefined();
    }
  });

  it("would have caught the original bug: the double-Z string is unparseable", () => {
    expect(Number.isNaN(Date.parse("2026-08-08T11:20:40.671Z" + "Z"))).toBe(true);
    expect(parseTimestampMs("2026-08-08T11:20:40.671Z")).toBeTypeOf("number");
  });
});
