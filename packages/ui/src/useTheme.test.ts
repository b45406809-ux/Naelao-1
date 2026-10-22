import { describe, expect, it } from "vitest";
import { normalizeThemeMode } from "./useTheme";

describe("normalizeThemeMode", () => {
  it.each(["light", "dark", "system"] as const)("accepts supported value %s", (mode) => {
    expect(normalizeThemeMode(mode)).toBe(mode);
  });

  it.each([null, undefined, "", "auto", "<svg onload=alert(1)>", 1])(
    "falls back to system for invalid stored values (%s)",
    (value) => {
      expect(normalizeThemeMode(value)).toBe("system");
    },
  );
});
