import { describe, it, expect } from "vitest";
import {
  parseCronExpression,
  validateCronExpression,
  cronMatchesDate,
  isCronDue,
  CRON_DUE_MAX_LOOKBACK_MS,
} from "@naelao/events";

// Time-based scheduling (spec §05 cron-jobs.json) — the lightweight 5-field cron matcher used
// by scheduled_jobs (workers/spaces) + runScheduledJobs (workers/agents hourly dispatcher).

describe("parseCronExpression / cronMatchesDate", () => {
  it("matches a daily schedule ('0 8 * * *') exactly at 08:00 UTC and nowhere else", () => {
    const cron = parseCronExpression("0 8 * * *");
    expect(cronMatchesDate(cron, new Date("2026-06-15T08:00:00.000Z"))).toBe(true);
    expect(cronMatchesDate(cron, new Date("2026-06-15T08:01:00.000Z"))).toBe(false);
    expect(cronMatchesDate(cron, new Date("2026-06-15T07:00:00.000Z"))).toBe(false);
  });

  it("matches every minute of every hour for '0 * * * *' only on the hour", () => {
    const cron = parseCronExpression("0 * * * *");
    expect(cronMatchesDate(cron, new Date("2026-06-15T14:00:00.000Z"))).toBe(true);
    expect(cronMatchesDate(cron, new Date("2026-06-15T14:30:00.000Z"))).toBe(false);
  });

  it("supports comma lists", () => {
    const cron = parseCronExpression("0 8,20 * * *");
    expect(cronMatchesDate(cron, new Date("2026-06-15T08:00:00.000Z"))).toBe(true);
    expect(cronMatchesDate(cron, new Date("2026-06-15T20:00:00.000Z"))).toBe(true);
    expect(cronMatchesDate(cron, new Date("2026-06-15T12:00:00.000Z"))).toBe(false);
  });

  it("supports ranges", () => {
    const cron = parseCronExpression("0 9-17 * * *");
    expect(cronMatchesDate(cron, new Date("2026-06-15T09:00:00.000Z"))).toBe(true);
    expect(cronMatchesDate(cron, new Date("2026-06-15T17:00:00.000Z"))).toBe(true);
    expect(cronMatchesDate(cron, new Date("2026-06-15T18:00:00.000Z"))).toBe(false);
  });

  it("supports step values", () => {
    const cron = parseCronExpression("*/15 * * * *");
    expect(cronMatchesDate(cron, new Date("2026-06-15T00:00:00.000Z"))).toBe(true);
    expect(cronMatchesDate(cron, new Date("2026-06-15T00:15:00.000Z"))).toBe(true);
    expect(cronMatchesDate(cron, new Date("2026-06-15T00:20:00.000Z"))).toBe(false);
  });

  it("matches a specific weekday (0=Sunday)", () => {
    const cron = parseCronExpression("0 18 * * 5"); // Friday
    expect(cronMatchesDate(cron, new Date("2026-06-19T18:00:00.000Z"))).toBe(true); // a Friday
    expect(cronMatchesDate(cron, new Date("2026-06-20T18:00:00.000Z"))).toBe(false); // Saturday
  });

  it("rejects a malformed expression (wrong field count)", () => {
    expect(() => parseCronExpression("0 8 * *")).toThrow();
    expect(() => parseCronExpression("* * * * * *")).toThrow();
  });

  it("rejects an out-of-range field value", () => {
    expect(() => parseCronExpression("0 25 * * *")).toThrow();
    expect(() => parseCronExpression("99 8 * * *")).toThrow();
  });

  it("rejects an unparseable field segment", () => {
    expect(() => parseCronExpression("abc 8 * * *")).toThrow();
  });
});

describe("validateCronExpression", () => {
  it("returns null for a valid expression", () => {
    expect(validateCronExpression("0 8 * * *")).toBeNull();
  });

  it("returns the parse error message for an invalid expression", () => {
    const err = validateCronExpression("not a cron");
    expect(err).toBeTruthy();
    expect(typeof err).toBe("string");
  });
});

describe("isCronDue", () => {
  it("is due when the matching minute falls within (lastRunAt, now]", () => {
    const lastRunAt = new Date("2026-06-15T07:00:00.000Z").getTime();
    const now = new Date("2026-06-15T08:05:00.000Z").getTime();
    expect(isCronDue("0 8 * * *", lastRunAt, now)).toBe(true);
  });

  it("is not due when the matching minute already ran (lastRunAt == the match minute)", () => {
    const lastRunAt = new Date("2026-06-15T08:00:00.000Z").getTime();
    const now = new Date("2026-06-15T08:30:00.000Z").getTime();
    expect(isCronDue("0 8 * * *", lastRunAt, now)).toBe(false);
  });

  it("is not due when no matching minute has occurred since the last run", () => {
    const lastRunAt = new Date("2026-06-15T08:01:00.000Z").getTime();
    const now = new Date("2026-06-15T09:00:00.000Z").getTime();
    expect(isCronDue("0 8 * * *", lastRunAt, now)).toBe(false);
  });

  it("catches a missed dispatch cycle (gap spans the due minute even if not exactly aligned)", () => {
    // Dispatcher was down; last run was 2 days ago, now catching up.
    const lastRunAt = new Date("2026-06-13T08:00:00.000Z").getTime();
    const now = new Date("2026-06-15T10:00:00.000Z").getTime();
    expect(isCronDue("0 8 * * *", lastRunAt, now)).toBe(true);
  });

  it("bounds the scan via lookbackMs so a long-dormant job does not scan forever", () => {
    // last_run_at is a year ago; with the default 8-day lookback the scan only covers the
    // last 8 days, which for a daily 08:00 cron still finds a match (still due).
    const lastRunAt = new Date("2025-06-15T08:00:00.000Z").getTime();
    const now = new Date("2026-06-15T10:00:00.000Z").getTime();
    expect(isCronDue("0 8 * * *", lastRunAt, now)).toBe(true);
  });

  it("a custom (smaller) lookback can exclude a due minute outside its window", () => {
    const lastRunAt = 0;
    const now = new Date("2026-06-15T10:00:00.000Z").getTime();
    // 1-hour lookback: the 08:00 minute is well outside a window starting at 09:00.
    expect(isCronDue("0 8 * * *", lastRunAt, now, 60 * 60 * 1000)).toBe(false);
  });

  it("CRON_DUE_MAX_LOOKBACK_MS is 8 days", () => {
    expect(CRON_DUE_MAX_LOOKBACK_MS).toBe(8 * 24 * 60 * 60 * 1000);
  });

  it("propagates a parse error for a malformed cron expression", () => {
    expect(() => isCronDue("garbage", 0, Date.now())).toThrow();
  });
});
