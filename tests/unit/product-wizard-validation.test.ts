import { describe, expect, it } from "vitest";
import {
  hasDerivableProductAddress,
  parseWizardInteger,
  SLUG_PATTERN,
} from "../../apps/dashboard/src/app/dashboard/products/new/wizardTypes";

describe("product wizard validation", () => {
  it("matches the server's product slug boundary rules", () => {
    for (const slug of ["a-", "-a", "--", "has space", "a".repeat(41)]) {
      expect(SLUG_PATTERN.test(slug), slug).toBe(false);
    }
    for (const slug of ["ab", "a-b", "a".repeat(40)]) {
      expect(SLUG_PATTERN.test(slug), slug).toBe(true);
    }
  });

  it("requires an explicit address when a name has no usable slug characters", () => {
    expect(hasDerivableProductAddress("Acme Creator Store")).toBe(true);
    expect(hasDerivableProductAddress("!!!")).toBe(false);
    expect(hasDerivableProductAddress("A")).toBe(true);
  });

  it("accepts only blank or safe nonnegative whole-number pricing values", () => {
    expect(parseWizardInteger("")).toBeUndefined();
    expect(parseWizardInteger(" 0 ")).toBe(0);
    expect(parseWizardInteger("1200")).toBe(1200);
    for (const value of ["-1", "1.5", "1e3", "Infinity", "9007199254740992"]) {
      expect(parseWizardInteger(value), value).toBeNull();
    }
  });
});
