import { describe, expect, it } from "vitest";
import { scanRequestBody } from "./waf.js";

describe("WAF request-body bounds", () => {
  it("fails closed when an attack is nested beyond the scanner depth", () => {
    let body: unknown = "<script>alert(1)</script>";
    for (let depth = 0; depth < 7; depth++) body = { nested: body };
    expect(scanRequestBody(body)).toEqual({
      detected: true,
      pattern: "body_depth_exceeded",
    });
  });

  it("rejects oversized strings before running the pattern checks", () => {
    expect(scanRequestBody("x".repeat(1_000_001))).toEqual({
      detected: true,
      pattern: "body_value_too_large",
    });
  });

  it("still scans normal nested JSON and leaves shallow benign values alone", () => {
    expect(
      scanRequestBody({ profile: { note: "<script>alert(1)</script>" } })
    ).toMatchObject({
      detected: true,
      pattern: "xss",
    });
    expect(scanRequestBody({ profile: { note: "ordinary text" } })).toEqual({
      detected: false,
    });
  });
});
