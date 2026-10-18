import { describe, expect, it } from "vitest";
import {
  type ConformanceSuite,
  MIN_MARKETPLACE_FIXTURES,
  certifyArtifact,
  runConformanceSuite,
  verifyArtifactCertificate,
} from "./marketplace-conformance.js";

function suite(): ConformanceSuite {
  return {
    rules: [{ id: "missing-purpose", match: "purpose", flags: "i" }],
    fixtures: Array.from({ length: MIN_MARKETPLACE_FIXTURES }, (_, i) => ({
      id: `case-${i}`,
      text:
        i % 2
          ? "This clause contains purpose."
          : "The parties shall protect information.",
      expected: i % 2 ? ("violation" as const) : ("compliant" as const),
    })),
  };
}

describe("marketplace conformance", () => {
  it("replays 50 fixtures with deterministic compliant and violation outcomes", () => {
    const report = runConformanceSuite(suite());
    expect(report).toMatchObject({
      passed: 50,
      total: 50,
      runner: "naelao-conformance-v1",
      diagnostics: [],
    });
  });

  it("returns actionable diagnostics and refuses certificates when any case regresses", async () => {
    const fixtureSet = suite();
    const firstFixture = fixtureSet.fixtures[0];
    if (!firstFixture) throw new Error("fixture missing");
    firstFixture.expected = "violation";
    const result = await certifyArtifact(
      { id: "blueprint-a" },
      fixtureSet,
      "test-secret"
    );
    expect(result.report.diagnostics).toEqual([
      { fixtureId: "case-0", expected: "violation", actual: "compliant" },
    ]);
    expect(result.certificate).toBeUndefined();
  });

  it("signs a pass certificate bound to both artifact and fixture bytes", async () => {
    const artifact = { id: "blueprint-a", version: 2 };
    const result = await certifyArtifact(
      artifact,
      suite(),
      "test-secret",
      "2026-10-12T00:00:00.000Z"
    );
    expect(
      await verifyArtifactCertificate(
        artifact,
        result.certificate,
        "test-secret"
      )
    ).toBe(true);
    expect(
      await verifyArtifactCertificate(
        artifact,
        result.certificate,
        "test-secret",
        "state-delta"
      )
    ).toBe(false);
    expect(
      await verifyArtifactCertificate(
        { ...artifact, version: 3 },
        result.certificate,
        "test-secret"
      )
    ).toBe(false);
    expect(
      await verifyArtifactCertificate(
        artifact,
        result.certificate,
        "wrong-secret"
      )
    ).toBe(false);
  });

  it("rejects undersized, malformed and duplicate fixture suites", () => {
    const invalid = suite();
    invalid.fixtures.pop();
    expect(() => runConformanceSuite(invalid)).toThrow(
      "invalid_conformance_suite"
    );
    const duplicate = suite();
    const [first, second] = duplicate.fixtures;
    if (!first || !second) throw new Error("fixtures missing");
    second.id = first.id;
    expect(() => runConformanceSuite(duplicate)).toThrow(
      "invalid_conformance_suite"
    );
  });

  it("bounds canonical certificate inputs and fails verification closed", async () => {
    const circular: Record<string, unknown> = { id: "circular" };
    circular.self = circular;
    await expect(
      certifyArtifact(circular, suite(), "test-secret")
    ).rejects.toThrow("conformance_input_circular");

    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let index = 0; index < 66; index++) {
      cursor.next = {};
      cursor = cursor.next as Record<string, unknown>;
    }
    await expect(certifyArtifact(deep, suite(), "test-secret")).rejects.toThrow(
      "conformance_input_too_deep"
    );

    const oversized = { value: "x".repeat(1_000_001) };
    await expect(
      certifyArtifact(oversized, suite(), "test-secret")
    ).rejects.toThrow("conformance_input_too_large");
    expect(
      await verifyArtifactCertificate(circular, undefined, "test-secret")
    ).toBe(false);
  });
});
