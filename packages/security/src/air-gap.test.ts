import { describe, expect, it, vi } from "vitest";
import {
  airGappedOnlyFromConfig,
  isSpaceNetworkEgressDenied,
} from "./air-gap.js";

describe("central air-gap egress policy", () => {
  it("recognizes root and product compliance settings", () => {
    expect(
      airGappedOnlyFromConfig('{"compliance":{"airGappedOnly":true}}')
    ).toBe(true);
    expect(
      airGappedOnlyFromConfig(
        '{"productConfig":{"compliance":{"airGappedOnly":true}}}'
      )
    ).toBe(true);
    expect(airGappedOnlyFromConfig("{}")).toBe(false);
  });

  it("fails closed for missing, malformed, or unavailable policy state", async () => {
    const db = (value: unknown) =>
      ({
        prepare: vi.fn(() => ({
          bind: vi.fn(() => ({ first: vi.fn(async () => value) })),
        })),
      }) as unknown as D1Database;
    await expect(isSpaceNetworkEgressDenied(db(null), "missing")).resolves.toBe(
      true
    );
    await expect(
      isSpaceNetworkEgressDenied(db({ config_json: "{" }), "broken")
    ).resolves.toBe(true);
    await expect(
      isSpaceNetworkEgressDenied(db({ config_json: "{}" }), "normal")
    ).resolves.toBe(false);
    await expect(
      isSpaceNetworkEgressDenied(
        db({ config_json: '{"compliance":{"airGappedOnly":true}}' }),
        "airgap"
      )
    ).resolves.toBe(true);
  });

  it("fails closed for oversized policy JSON before parsing", () => {
    expect(airGappedOnlyFromConfig(" ".repeat(1_000_001))).toBe(true);
  });
});
