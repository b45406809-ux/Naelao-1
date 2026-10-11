import { describe, expect, it } from "vitest";
import { normalizeE164 } from "./product-end-user-routes.js";

describe("WhatsApp passwordless identity", () => {
  it.each([
    ["+27821234567", "+27821234567"],
    ["00 27 82 123 4567", "+27821234567"],
    ["+1 (415) 555-0100", "+14155550100"],
  ])("normalizes %s to E.164", (input, expected) => {
    expect(normalizeE164(input)).toBe(expected);
  });

  it.each(["27821234567", "+012345678", "+12", "hello", "+1234567890123456"])(
    "rejects invalid phone %s",
    (input) => expect(normalizeE164(input)).toBeNull(),
  );
});
