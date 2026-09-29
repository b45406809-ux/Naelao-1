import { describe, expect, it } from "vitest";
import { CANVAS_VIEWPORTS, isCanvasMountDescriptor } from "./canvas-runtime.js";

describe("polymorphic canvas descriptors", () => {
  it("exposes every deliverable, gadget, container, and domain viewport", () => {
    expect(CANVAS_VIEWPORTS).toEqual(expect.arrayContaining([
      "document_redline", "spreadsheet_formula_grid", "code_workspace", "micro_app",
      "container_terminal", "virtual_desktop", "voice_agent", "customer_bot",
      "model_studio", "growth_engine",
    ]));
  });

  it("validates mount descriptors at the agent boundary", () => {
    expect(isCanvasMountDescriptor({ viewport: "micro_app", resourceId: "app-1", live: true })).toBe(true);
    expect(isCanvasMountDescriptor({ viewport: "unknown" })).toBe(false);
    expect(isCanvasMountDescriptor({ viewport: "container_terminal", live: "yes" })).toBe(false);
  });
});
