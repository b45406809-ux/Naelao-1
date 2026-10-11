import { describe, expect, it } from "vitest";
import { resolveOperatingMode } from "./mode-dispatch.js";

describe("operating mode dispatch", () => {
  it("normalizes the legacy autonomous operator spelling to AVOS", () => {
    expect(resolveOperatingMode({ templateMode: "autonomous_operator" })).toMatchObject({ templateMode: "autonomous_venture_os", source: "explicit", product: "avos" });
  });
  it("uses a project kind's declared default", () => {
    expect(resolveOperatingMode({ projectKind: "customer_bot" })).toMatchObject({ templateMode: "autonomous_venture_os", source: "project_kind", product: "avos" });
  });
  it("keeps the shared canvas and proactive-kernel contract for Cowork", () => {
    expect(resolveOperatingMode({ templateMode: "cowork_studio" })).toMatchObject({ templateMode: "cowork_studio", product: "cowork", canvasPrimary: true, proactiveWakes: true });
  });
});
