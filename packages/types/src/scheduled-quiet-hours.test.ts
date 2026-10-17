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
});
