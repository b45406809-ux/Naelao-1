import { describe, expect, it } from "vitest";
import { parseSessionSpendStatus } from "./session-spend-status.js";

describe("session spend status", () => {
  it("accepts a bounded authoritative tally", () => {
    expect(parseSessionSpendStatus({ credits_used: 125, warned_80: true }))
      .toEqual({ credits_used: 125, warned_80: true });
  });

  it.each([
    null,
    [],
    {},
    { credits_used: -1, warned_80: false },
    { credits_used: Number.MAX_SAFE_INTEGER + 1, warned_80: false },
    { credits_used: 0, warned_80: "false" },
  ])("rejects malformed status %j", value => {
    expect(parseSessionSpendStatus(value)).toBeNull();
  });
});
