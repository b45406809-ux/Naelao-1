import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  lenientObject,
  optionalBoolean,
  optionalNumber,
  optionalString,
  parseLenient,
} from "./lenient-zod.js";

describe("lenient provider parsing", () => {
  it.each([
    [true, true],
    [false, false],
    ["true", true],
    ["false", false],
    ["1", true],
    ["0", false],
    [1, true],
    [0, false],
  ] as const)("coerces %s to %s for boolean fields", (input, expected) =>
    expect(optionalBoolean.parse(input)).toBe(expected)
  );

  it("treats unknown boolean spellings as absent instead of truthy", () => {
    expect(optionalBoolean.parse("yes")).toBeUndefined();
  });

  it("preserves provider fields while coercing known primitives", () => {
    const schema = lenientObject({
      enabled: optionalBoolean,
      count: optionalNumber,
      label: optionalString,
    });
    expect(
      schema.parse({
        enabled: "false",
        count: "4",
        label: 5,
        providerAdded: "kept",
      })
    ).toEqual({
      enabled: false,
      count: 4,
      label: "5",
      providerAdded: "kept",
    });
  });

  it("uses the fallback for malformed provider shapes", () => {
    expect(
      parseLenient(
        z.object({ count: z.number() }),
        { count: "not-number" },
        { count: 0 }
      )
    ).toEqual({ count: 0 });
  });
});
