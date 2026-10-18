import { describe, expect, it } from "vitest";
import {
  findDestructiveMutation,
  signGatekeeperToken,
  verifyGatekeeperToken,
} from "./write-guard.js";

describe("mutation write-guard bounds", () => {
  it("fails closed on oversized inspection input and still distinguishes quoted SQL", () => {
    expect(findDestructiveMutation(null as never)).toMatchObject({
      action: "mutation.input_invalid",
    });
    expect(findDestructiveMutation("x".repeat(1_000_001))).toMatchObject({
      action: "mutation.input_too_large",
    });
    expect(
      findDestructiveMutation("SELECT 'DROP TABLE users' AS note")
    ).toBeNull();
    expect(findDestructiveMutation("DROP TABLE users")).toMatchObject({
      action: "sql.drop",
    });
  });

  it("validates signed gatekeeper claims and rejects oversized or expired grants", async () => {
    const now = 1000;
    const token = await signGatekeeperToken(
      { actions: ["sql.drop"], resources: ["db:main"], exp: now + 1000 },
      "gatekeeper-secret"
    );
    await expect(
      verifyGatekeeperToken(
        token,
        "gatekeeper-secret",
        "sql.drop",
        "db:main",
        now
      )
    ).resolves.toBe(true);
    await expect(
      verifyGatekeeperToken(
        token,
        "gatekeeper-secret",
        "sql.drop",
        "db:main",
        now + 1000
      )
    ).resolves.toBe(false);
    await expect(
      verifyGatekeeperToken(
        "x".repeat(32 * 1024 + 1),
        "gatekeeper-secret",
        "sql.drop",
        "db:main",
        now
      )
    ).resolves.toBe(false);
    await expect(
      signGatekeeperToken(
        { actions: ["x".repeat(257)], resources: ["db"], exp: now + 1000 },
        "secret"
      )
    ).rejects.toThrow("gatekeeper_claims_invalid");
  });
});
