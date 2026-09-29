import { describe, expect, it } from "vitest";
import {
  PROJECT_KIND_MANIFESTS,
  defaultViewportFor,
} from "../../../packages/agent-sdk/src/canvas-runtime";
import { projectExecutionTelemetry } from "../../../packages/agent-sdk/src/display-mode";

describe("Batch 09 foundations", () => {
  it("redacts implementation telemetry only in business mode", () => {
    const telemetry = {
      status: "done",
      commit_oid: "abc",
      raw_tier_id: "tier-6",
      v8_cold_start_log: "boot",
      token_breakdown: { input: 2 },
    };
    expect(projectExecutionTelemetry(telemetry, "business")).toEqual({
      status: "done",
    });
    expect(projectExecutionTelemetry(telemetry, "developer")).toEqual(
      telemetry
    );
  });

  it("declares nine distinct canvas-first project kinds including the quant desk", () => {
    const manifests = Object.values(PROJECT_KIND_MANIFESTS);
    expect(manifests).toHaveLength(9);
    expect(new Set(manifests.map((item) => item.viewportComponent)).size).toBe(
      9
    );
    expect(PROJECT_KIND_MANIFESTS.quant_desk.viewportComponent).toBe(
      "QuantDeskCanvas"
    );
    for (const manifest of manifests) {
      expect(defaultViewportFor(manifest.kind)).toMatchObject({
        component: manifest.viewportComponent,
        canvasPrimary: true,
      });
      expect(manifest.allowedLadderTiers.length).toBeGreaterThan(0);
    }
  });

  it("caps customer bots at tier 2 while product development reaches tier 6", () => {
    expect(PROJECT_KIND_MANIFESTS.customer_bot.allowedLadderTiers).toEqual([
      1, 2,
    ]);
    expect(
      PROJECT_KIND_MANIFESTS.customer_bot.allowedLadderTiers
    ).not.toContain(6);
    expect(PROJECT_KIND_MANIFESTS.product_dev.allowedLadderTiers).toContain(6);
  });

  it("assigns explicit autonomous and cowork defaults", () => {
    expect(PROJECT_KIND_MANIFESTS.customer_bot.defaultAutonomy).toBe(
      "autonomous_venture_os"
    );
    expect(PROJECT_KIND_MANIFESTS.doc_studio.defaultAutonomy).toBe(
      "cowork_studio"
    );
  });
});
