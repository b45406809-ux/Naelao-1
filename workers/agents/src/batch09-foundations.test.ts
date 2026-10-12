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

  it("declares only the maintained Document and DataGrid shells", () => {
    const manifests = Object.values(PROJECT_KIND_MANIFESTS);
    expect(manifests).toHaveLength(2);
    expect(new Set(manifests.map((item) => item.viewportComponent)).size).toBe(2);
    for (const manifest of manifests) {
      expect(defaultViewportFor(manifest.layout)).toMatchObject({
        component: manifest.viewportComponent,
        canvasPrimary: true,
      });
    }
  });

});
