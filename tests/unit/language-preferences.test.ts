import { normalizePreferredLanguage } from "@naelao/types";
import { describe, expect, it } from "vitest";

describe("saved language preference validation", () => {
  it("accepts and canonicalizes valid BCP-47 tags", () => {
    expect(normalizePreferredLanguage(" en-us ")).toBe("en-US");
    expect(normalizePreferredLanguage("sw-KE")).toBe("sw-KE");
  });

  it("does not turn unset, malformed, or oversized values into a preference", () => {
    expect(normalizePreferredLanguage(null)).toBeNull();
    expect(normalizePreferredLanguage("auto")).toBeNull();
    expect(normalizePreferredLanguage("en_US")).toBeNull();
    expect(normalizePreferredLanguage("en-")).toBeNull();
    expect(normalizePreferredLanguage(`en-${"a".repeat(40)}`)).toBeNull();
  });
});
