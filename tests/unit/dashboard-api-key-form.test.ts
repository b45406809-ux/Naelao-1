import { describe, expect, it } from "vitest";
import { parseApiKeyExpiryDays } from "../../apps/dashboard/src/lib/api-key-form";

describe("API-key expiry input validation", () => {
  it("distinguishes a blank no-expiry value from whole-day expirations", () => {
    expect(parseApiKeyExpiryDays("")).toBeUndefined();
    expect(parseApiKeyExpiryDays("  ")).toBeUndefined();
    expect(parseApiKeyExpiryDays("1")).toBe(1);
    expect(parseApiKeyExpiryDays("3650")).toBe(3650);
  });

  it.each(["0", "-1", "1.5", "3651", "NaN", "Infinity"])(
    "rejects invalid expiration input %s without truncation",
    (value) => expect(parseApiKeyExpiryDays(value)).toBeNull(),
  );
});
