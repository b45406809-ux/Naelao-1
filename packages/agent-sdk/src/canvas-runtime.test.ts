import { describe, expect, it } from "vitest";
import { CANVAS_LAYOUTS, CANVAS_VIEWPORTS, isCanvasMountDescriptor, parseCanvasMessage, validateWithBoundedCorrections } from "./canvas-runtime.js";

describe("polymorphic canvas descriptors", () => {
  it("exposes the maintained shells and a generic third-party mount socket", () => {
    expect(CANVAS_LAYOUTS).toEqual(["DualPane.Document", "DualPane.DataGrid"]);
    expect(CANVAS_VIEWPORTS).toEqual(expect.arrayContaining([
      "document_redline", "spreadsheet_formula_grid", "code_workspace", "micro_app",
      "container_terminal", "virtual_desktop", "canvas_mount",
    ]));
    expect(CANVAS_VIEWPORTS).not.toContain("voice_agent");
  });

  it("validates mount descriptors at the agent boundary", () => {
    expect(isCanvasMountDescriptor({ viewport: "micro_app", resourceId: "app-1", live: true })).toBe(true);
    expect(isCanvasMountDescriptor({ viewport: "unknown" })).toBe(false);
    expect(isCanvasMountDescriptor({ viewport: "container_terminal", live: "yes" })).toBe(false);
  });

  it("caps structural-linter repair at two passes and returns unresolved diagnostics as warnings", async () => {
    const result = await validateWithBoundedCorrections(0, [value => value === 3 ? [] : [{ ruleId: "exact-three", message: "Value must be 3" }]], async (_value, _diagnostics, attempt) => attempt);
    expect(result).toEqual({ candidate: 2, diagnostics: [{ ruleId: "exact-three", message: "Value must be 3" }], correctionAttempts: 2, warning: true });
  });

  it("accepts bounded project-scoped bridge messages and rejects executable or stale payloads", () => {
    expect(parseCanvasMessage({ type: "canvas.action", projectId: "p1", action: "record.save", payload: { id: "r1" }, baseRevision: 2 }, "p1")).toMatchObject({ action: "record.save", baseRevision: 2 });
    expect(parseCanvasMessage({ type: "canvas.state", projectId: "p1", revision: 3, data: { title: "ok" } }, "p1").type).toBe("canvas.state");
    expect(() => parseCanvasMessage({ type: "canvas.action", projectId: "p2", action: "save", payload: {} }, "p1")).toThrow();
    expect(() => parseCanvasMessage({ type: "canvas.action", projectId: "p1", action: "save", payload: { script: { code: "run" } } }, "p1")).toThrow();
  });
});
