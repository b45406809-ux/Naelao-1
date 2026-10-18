import { describe, expect, it } from "vitest";
import { sanitizeAndScrubBlueprint } from "./blueprint-scrubber.js";
import { scanAndScrubEgress } from "./dlp.js";
import {
  mintEphemeralActionGrant,
  verifyEphemeralActionGrant,
} from "./ephemeral-grant.js";

function nested(depth: number, value: unknown): unknown {
  let result = value;
  for (let index = 0; index < depth; index++) result = { nested: result };
  return result;
}

describe("recursive security input boundaries", () => {
  it("redacts sensitive DLP values in keys and rejects cyclic, deep, and oversized payloads", () => {
    expect(
      scanAndScrubEgress({ "card_4111 1111 1111 1111": "ok" }).payload
    ).toEqual({
      "card_[REDACTED_CREDIT_CARD]": "ok",
    });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => scanAndScrubEgress(cyclic)).toThrow(
      "egress_dlp_circular_payload"
    );
    expect(() => scanAndScrubEgress(nested(66, "safe"))).toThrow(
      "egress_dlp_input_too_deep"
    );
    expect(() => scanAndScrubEgress("x".repeat(1_000_001))).toThrow(
      "egress_dlp_input_too_large"
    );
  });

  it("fails blueprint scrubbing closed on cycles, excessive depth, and oversized exports", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => sanitizeAndScrubBlueprint(cyclic)).toThrow(
      "blueprint_scrub_circular_input"
    );
    expect(() => sanitizeAndScrubBlueprint(nested(66, "safe"))).toThrow(
      "blueprint_scrub_input_too_deep"
    );
    expect(() =>
      sanitizeAndScrubBlueprint({ description: "x".repeat(1_000_001) })
    ).toThrow("blueprint_scrub_input_too_large");
  });

  it("rejects non-JSON, cyclic, deep, and oversized ephemeral-grant parameters", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expect(
      mintEphemeralActionGrant("tool.run", cyclic, "secret")
    ).rejects.toThrow("ephemeral_grant_params_circular");
    await expect(
      mintEphemeralActionGrant(
        "tool.run",
        nested(66, "safe") as never,
        "secret"
      )
    ).rejects.toThrow("ephemeral_grant_params_too_deep");
    await expect(
      mintEphemeralActionGrant(
        "tool.run",
        { text: "x".repeat(1_000_001) },
        "secret"
      )
    ).rejects.toThrow("ephemeral_grant_params_too_large");
    const valid = await mintEphemeralActionGrant(
      "tool.run",
      { ok: true },
      "secret"
    );
    expect(
      await verifyEphemeralActionGrant(valid, "tool.run", cyclic, "secret")
    ).toBe(false);
    expect(
      await verifyEphemeralActionGrant(
        valid,
        "tool.run",
        { ok: true },
        "secret",
        Number.NaN
      )
    ).toBe(false);
  });
});
