import { describe, expect, it } from "vitest";
import { resolveOperatingMode } from "./mode-dispatch.js";

describe("operating mode dispatch", () => {
  it("normalizes the legacy autonomous operator spelling to AVOS", () => {
    expect(resolveOperatingMode({ templateMode: "autonomous_operator" })).toMatchObject({ templateMode: "autonomous_venture_os", source: "explicit", product: "avos" });
  });
  it("keeps vertical behavior in templates instead of a project-kind mode registry", () => {
    expect(resolveOperatingMode({ projectKind: "workspace" })).toMatchObject({ templateMode: "cowork_studio", source: "default", product: "cowork" });
  });
  it("keeps the shared canvas and proactive-kernel contract for Cowork", () => {
    expect(resolveOperatingMode({ templateMode: "cowork_studio" })).toMatchObject({ templateMode: "cowork_studio", product: "cowork", canvasPrimary: true, proactiveWakes: true });
  });
});
