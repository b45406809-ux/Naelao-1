import { describe, expect, it } from "vitest";
import { isWithinScheduledQuietHours, validateScheduledQuietHours } from "./index.js";

describe("scheduled routine quiet hours", () => {
  it("validates both endpoints and a real timezone", () => {
    expect(validateScheduledQuietHours({ start: "22:00", end: "07:00", timeZone: "America/New_York" })).toBeNull();
    expect(validateScheduledQuietHours({ start: "22:00", end: "", timeZone: "UTC" })).toBe("quiet_hours_start_and_end_must_be_paired");
    expect(validateScheduledQuietHours({ start: "25:00", end: "07:00", timeZone: "UTC" })).toBe("quiet_hours_time_invalid");
    expect(validateScheduledQuietHours({ start: "22:00", end: "07:00", timeZone: "Not/AZone" })).toBe("quiet_hours_timezone_invalid");
  });

  it("handles windows crossing midnight in the configured local timezone", () => {
    const quiet = { start: "22:00", end: "07:00", timeZone: "America/New_York" };
    expect(isWithinScheduledQuietHours(quiet, Date.parse("2026-01-15T03:00:00Z"))).toBe(true); // 22:00 local
    expect(isWithinScheduledQuietHours(quiet, Date.parse("2026-01-15T12:00:00Z"))).toBe(false); // 07:00 local
    expect(isWithinScheduledQuietHours({ start: "09:00", end: "17:00", timeZone: "UTC" }, Date.parse("2026-01-15T12:00:00Z"))).toBe(true);
  });

  it("uses inclusive start and exclusive end boundaries", () => {
    const quiet = { start: "09:00", end: "17:00", timeZone: "UTC" };
    expect(isWithinScheduledQuietHours(quiet, Date.parse("2026-01-15T09:00:00Z"))).toBe(true);
    expect(isWithinScheduledQuietHours(quiet, Date.parse("2026-01-15T16:59:00Z"))).toBe(true);
    expect(isWithinScheduledQuietHours(quiet, Date.parse("2026-01-15T17:00:00Z"))).toBe(false);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 8.64e15 + 1])(
    "fails closed for invalid clock values (%s)",
    (now) => {
      expect(isWithinScheduledQuietHours({ start: "09:00", end: "17:00", timeZone: "UTC" }, now)).toBe(false);
    },
  );

  it("returns false rather than throwing for an invalid quiet window", () => {
    expect(isWithinScheduledQuietHours({ start: "bad", end: "17:00", timeZone: "UTC" }, Date.now())).toBe(false);
    expect(isWithinScheduledQuietHours({ start: "09:00", end: "17:00", timeZone: "Not/AZone" }, Date.now())).toBe(false);
  });
});
