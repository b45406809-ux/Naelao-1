import { describe, expect, it } from "vitest";
import { certifyArtifact, MIN_MARKETPLACE_FIXTURES, runConformanceSuite, verifyArtifactCertificate, type ConformanceSuite } from "./marketplace-conformance.js";

function suite(): ConformanceSuite {
  return {
    rules: [{ id: "missing-purpose", match: "purpose", flags: "i" }],
    fixtures: Array.from({ length: MIN_MARKETPLACE_FIXTURES }, (_, i) => ({
      id: `case-${i}`,
      text: i % 2 ? "This clause contains purpose." : "The parties shall protect information.",
      expected: i % 2 ? "violation" as const : "compliant" as const,
    })),
  };
}

describe("marketplace conformance", () => {
  it("replays 50 fixtures with deterministic compliant and violation outcomes", () => {
    const report = runConformanceSuite(suite());
    expect(report).toMatchObject({ passed: 50, total: 50, runner: "naelao-conformance-v1", diagnostics: [] });
  });

  it("returns actionable diagnostics and refuses certificates when any case regresses", async () => {
    const fixtureSet = suite();
    fixtureSet.fixtures[0]!.expected = "violation";
    const result = await certifyArtifact({ id: "blueprint-a" }, fixtureSet, "test-secret");
    expect(result.report.diagnostics).toEqual([{ fixtureId: "case-0", expected: "violation", actual: "compliant" }]);
    expect(result.certificate).toBeUndefined();
  });

  it("signs a pass certificate bound to both artifact and fixture bytes", async () => {
    const artifact = { id: "blueprint-a", version: 2 };
    const result = await certifyArtifact(artifact, suite(), "test-secret", "2026-10-12T00:00:00.000Z");
    expect(await verifyArtifactCertificate(artifact, result.certificate, "test-secret")).toBe(true);
    expect(await verifyArtifactCertificate(artifact, result.certificate, "test-secret", "state-delta")).toBe(false);
    expect(await verifyArtifactCertificate({ ...artifact, version: 3 }, result.certificate, "test-secret")).toBe(false);
    expect(await verifyArtifactCertificate(artifact, result.certificate, "wrong-secret")).toBe(false);
  });

  it("rejects undersized, malformed and duplicate fixture suites", () => {
    const invalid = suite();
    invalid.fixtures.pop();
    expect(() => runConformanceSuite(invalid)).toThrow("invalid_conformance_suite");
    const duplicate = suite();
    duplicate.fixtures[1]!.id = duplicate.fixtures[0]!.id;
    expect(() => runConformanceSuite(duplicate)).toThrow("invalid_conformance_suite");
  });
});
